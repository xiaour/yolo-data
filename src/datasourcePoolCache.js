import { isDeepStrictEqual } from 'node:util';

// Bind each pool to the persisted connection settings used to create it.
// Weak keys keep retired pools and their credential snapshots collectible.
const configurations = new WeakMap();

function connectionConfiguration(source) {
  return [source.id, source.dbType, source.host, source.port, source.databaseName,
    source.username, source.encryptedPassword, source.options];
}

export function configuredPool(service, source) {
  if (!source) throw new Error('data source not found');
  if (Number(source.status) !== 1) {
    throw Object.assign(new Error('data source is disabled'), {
      code: 'DATASOURCE_DISABLED', statusCode: 403,
    });
  }
  const configuration = connectionConfiguration(source);
  let pool = service.pools.get(source.code);
  if (pool && !isDeepStrictEqual(configurations.get(pool), configuration)) {
    service.closePool(source.code);
    pool = null;
  }
  if (!pool) {
    // Another process can rename the persisted code without invalidating
    // this process's old cache key. Scan only on a miss, keeping reuse O(1).
    for (const [code, cached] of service.pools) {
      const previous = configurations.get(cached);
      if (code !== source.code && previous && String(previous[0]) === String(source.id)) {
        service.closePool(code);
      }
    }
    pool = service.createPool(source);
    configurations.set(pool, structuredClone(configuration));
    service.pools.set(source.code, pool);
  }
  return pool;
}
