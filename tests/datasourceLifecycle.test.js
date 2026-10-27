import assert from 'node:assert/strict';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import { BusinessDatasetService } from '../src/businessDatasets.js';
import { getActivePoolAsync } from '../src/datasourcePool.js';

const payload = {
  code: 'source', name: 'Source', dbType: 'POSTGRESQL', host: 'old.example',
  port: 5432, databaseName: 'analytics', username: 'reader', encryptedPassword: 'ciphertext',
  options: { ssl: true, ca: 'test-ca' }, status: 1,
};

function fixture(t) {
  const database = new PlatformDatabase(':memory:');
  const service = new BusinessDatasetService({ database, crypto: {}, config: {} });
  const closed = [];
  // Only the external connection is replaced; persistence and cache lifecycle are real.
  service.createPool = source => ({ host: source.host, end: async () => { closed.push(source.host); } });
  t.after(async () => { await service.close(); await database.closeAsync(); });
  return { database, service, closed };
}

for (const [mode, getPool] of [
  ['sync', (service, source) => service.getPool(source)],
  ['async', (service, source) => {
    // The in-memory fixture has separate native/async connections; expose its
    // real persisted rows through the asynchronous repository contract.
    service.database.dataSourceRepository.getDataSourceAsync = async id => service.database.getDataSource(id);
    return getActivePoolAsync(service, source);
  }],
]) {
  for (const [field, value] of Object.entries({
    dbType: 'MYSQL', host: 'new.example', port: 5433, databaseName: 'other',
    username: 'other', encryptedPassword: 'new-ciphertext', options: { ssl: false },
  })) {
    test(`${mode} pool refreshes after another writer changes datasource ${field}`, async t => {
      const { database, service, closed } = fixture(t);
      service.createPool = source => ({ source, end: async () => { closed.push(source.host); } });
      const original = database.saveDataSource(payload);
      const oldPool = await getPool(service, original);
      database.saveDataSource({ ...payload, [field]: value }, original.id);
      const refreshed = await getPool(service, original);
      assert.notEqual(refreshed, oldPool);
      assert.deepEqual(refreshed.source[field], value);
      assert.deepEqual(closed, ['old.example']);
      assert.equal(await getPool(service, original), refreshed);
      assert.equal(service.pools.size, 1);
    });
  }

  test(`${mode} pool survives non-connection edits from another writer`, async t => {
    const { database, service, closed } = fixture(t);
    const original = database.saveDataSource(payload);
    const pool = await getPool(service, original);
    database.updateDataSourceTest(original.id, { ok: true, message: 'passed' });
    database.saveDataSource({ ...payload, name: 'Renamed', options: { ca: 'test-ca', ssl: true } }, original.id);
    assert.equal(await getPool(service, original), pool);
    assert.deepEqual(closed, []);
  });

  test(`${mode} retires old pool keys after external datasource renames`, async t => {
    const { database, service, closed } = fixture(t);
    const original = database.saveDataSource(payload);
    await getPool(service, original);
    const other = database.saveDataSource({ ...payload, code: 'other', host: 'other.example' });
    const otherPool = await getPool(service, other);
    let previousCode = original.code;
    for (const code of ['renamed', 'renamed_again']) {
      database.saveDataSource({ ...payload, code }, original.id);
      const currentPool = await getPool(service, original);
      assert.equal(service.pools.has(previousCode), false);
      assert.equal(service.pools.get(code), currentPool);
      assert.equal(service.pools.get('other'), otherPool);
      assert.equal(service.pools.size, 2);
      previousCode = code;
    }
    assert.deepEqual(closed, ['old.example', 'old.example']);
  });
}

test('changing a datasource code releases its original connection pool', t => {
  const { service, closed } = fixture(t);
  const original = service.saveDataSource(payload);
  const oldPool = service.getPool(original);
  const saved = service.saveDataSource({ ...payload, code: 'renamed', host: 'new.example' }, original.id);
  assert.deepEqual(closed, ['old.example']);
  assert.equal(service.pools.has('source'), false);
  assert.notEqual(service.getPool(saved), oldPool);
  assert.equal(service.getPool(saved).host, 'new.example');
  assert.equal(service.pools.size, 1);
});

test('failed datasource saves retain the existing pool and connection test result', t => {
  const { database, service, closed } = fixture(t);
  const original = service.saveDataSource(payload);
  const pool = service.getPool(original);
  database.updateDataSourceTest(original.id, { ok: true, message: 'passed' });
  service.saveDataSource({ ...payload, code: 'occupied' });
  assert.throws(() => service.saveDataSource({ ...payload, code: 'occupied' }, original.id), /UNIQUE/);
  assert.equal(service.getPool(database.getDataSource(original.id)), pool);
  assert.deepEqual(closed, []);
  assert.equal(database.getDataSource(original.id).lastTestOk, true);
});

test('connection updates without a code change replace the cached pool', t => {
  const { service, closed } = fixture(t);
  const original = service.saveDataSource(payload);
  const oldPool = service.getPool(original);
  const saved = service.saveDataSource({ ...payload, host: 'new.example' }, original.id);
  assert.deepEqual(closed, ['old.example']);
  assert.notEqual(service.getPool(saved), oldPool);
  assert.equal(service.getPool(saved).host, 'new.example');
  assert.equal(service.pools.size, 1);
});

test('failed connection tests are also invalidated when the connection changes', t => {
  const { database, service } = fixture(t);
  const original = service.saveDataSource(payload);
  database.updateDataSourceTest(original.id, { ok: false, message: 'old host refused' });
  const saved = service.saveDataSource({ ...payload, host: 'new.example' }, original.id);
  assert.equal(saved.lastTestOk, null);
  assert.equal(saved.lastTestAt, null);
  assert.equal(saved.lastTestMessage, '');
  const retested = database.updateDataSourceTest(saved.id, { ok: true, message: 'new host passed' });
  assert.equal(retested.lastTestOk, true);
  assert.equal(retested.lastTestMessage, 'new host passed');
});

for (const [field, value] of Object.entries({
  dbType: 'MYSQL', host: 'new.example', port: 5433, databaseName: 'other',
  username: 'other', encryptedPassword: 'new-ciphertext', options: { ssl: false },
})) {
  test(`changing datasource ${field} clears the old connection test result`, t => {
    const { database } = fixture(t);
    const original = database.saveDataSource(payload);
    database.updateDataSourceTest(original.id, { ok: true, message: 'old configuration passed' });
    const saved = database.saveDataSource({ ...payload, [field]: value }, original.id);
    assert.equal(saved.lastTestOk, null);
    assert.equal(saved.lastTestAt, null);
    assert.equal(saved.lastTestMessage, '');
    assert.equal(database.getDataSource(original.id).lastTestOk, null);
  });
}

test('non-connection edits and an omitted password preserve the previous test result', t => {
  const { database, service } = fixture(t);
  const original = service.saveDataSource(payload);
  const tested = database.updateDataSourceTest(original.id, { ok: false, message: 'connection refused' });
  const saved = service.saveDataSource({
    ...payload, code: 'renamed', name: 'New name', status: 0, encryptedPassword: '',
    options: { ca: 'test-ca', ssl: true },
  }, original.id);
  assert.equal(saved.lastTestOk, false);
  assert.equal(saved.lastTestAt, tested.lastTestAt);
  assert.equal(saved.lastTestMessage, 'connection refused');
  assert.equal(saved.encryptedPassword, 'ciphertext');
});

for (const succeeds of [true, false]) {
  test(`an in-flight ${succeeds ? 'successful' : 'failed'} connection test cannot overwrite an edited configuration`, async t => {
    const { database, service } = fixture(t);
    const source = service.saveDataSource(payload);
    let resolveQuery;
    let rejectQuery;
    service.createPool = () => ({
      query: () => new Promise((resolve, reject) => { resolveQuery = resolve; rejectQuery = reject; }),
      end: async () => {},
    });
    const testing = service.testDataSource(source.id);
    service.saveDataSource({ ...payload, host: 'new.example' }, source.id);
    if (succeeds) resolveQuery([[]]); else rejectQuery(new Error('old host failed'));
    const result = await testing;
    assert.equal(result.host, 'new.example');
    assert.equal(result.lastTestOk, null);
    assert.equal(result.lastTestAt, null);
    assert.equal(database.getDataSource(source.id).lastTestMessage, '');
  });
}

test('an in-flight test remains valid when only the datasource name changes', async t => {
  const { service } = fixture(t);
  const source = service.saveDataSource(payload);
  let resolveQuery;
  service.createPool = () => ({ query: () => new Promise(resolve => { resolveQuery = resolve; }), end: async () => {} });
  const testing = service.testDataSource(source.id);
  service.saveDataSource({ ...payload, name: 'New name' }, source.id);
  resolveQuery([[]]);
  const result = await testing;
  assert.equal(result.name, 'New name');
  assert.equal(result.lastTestOk, true);
});

