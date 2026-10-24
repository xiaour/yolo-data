import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTimeGrainExpression } from '../src/businessDatasets.js';
import { BusinessDatasetService } from '../src/businessDatasets.js';
import { PlatformDatabase } from '../src/database.js';
import { postgresParameters } from '../src/dialects/common.js';
import { getDialect, normalizeDataSource, normalizeDbType } from '../src/dialects/index.js';
import { adaptPostgresPool, postgresPoolOptions } from '../src/dialects/postgresql.js';
import { dialectDataset, dialectRequest } from './fixtures/dialectDataset.js';

test('MySQL, TiDB and Doris retain one dialect; PG aliases normalize at save time', () => {
  for (const type of ['MYSQL', 'TIDB', 'DORIS', 'legacy']) assert.equal(getDialect(type).code, 'MYSQL');
  for (const type of ['PG', 'postgres', ' postgresql ']) assert.equal(normalizeDbType(type), 'POSTGRESQL');
  assert.equal(normalizeDataSource({ dbType: 'pg', databaseName: 'test' }).port, 5432);
  assert.equal(normalizeDataSource({}).port, 9030);
  assert.throws(() => normalizeDataSource({ dbType: 'PG' }), /必须指定连接数据库/);
  for (const port of [0, -1, 65536, 2.5, 'bad']) assert.throws(() => normalizeDataSource({ port }), /端口/);
});

test('identifier quoting uses the same whitelist for both dialects', () => {
  assert.equal(getDialect('MYSQL').quoteIdentifier('Order'), '`Order`');
  assert.equal(getDialect('PG').quoteIdentifier('Order'), '"Order"');
  assert.equal(getDialect('MYSQL').quoteIdentifier('yolo-data'), '`yolo-data`');
  assert.equal(getDialect('PG').quoteIdentifier('yolo-data'), '"yolo-data"');
  for (const type of ['MYSQL', 'PG']) {
    for (const name of ['bad.name', 'a"', 'x;DROP TABLE sales', '', 'x`']) {
      assert.throws(() => getDialect(type).quoteIdentifier(name), /invalid SQL identifier/);
    }
  }
});

test('all five MySQL time grains preserve their existing SQL', () => {
  const expected = {
    DAY: "DATE_FORMAT(`day`, '%Y-%m-%d')",
    WEEK: "DATE_FORMAT(DATE_SUB(DATE(`day`), INTERVAL WEEKDAY(`day`) DAY), '%Y-%m-%d')",
    MONTH: "DATE_FORMAT(`day`, '%Y-%m')",
    QUARTER: "CONCAT(YEAR(`day`), '-Q', QUARTER(`day`))",
    YEAR: "DATE_FORMAT(`day`, '%Y')",
  };
  for (const [grain, sql] of Object.entries(expected)) assert.equal(buildTimeGrainExpression('day', grain), sql);
});

test('PostgreSQL time grains return the same string bucket keys including Monday weeks', () => {
  const expected = {
    DAY: 'to_char("day"::timestamp, \'YYYY-MM-DD\')',
    WEEK: 'to_char(date_trunc(\'week\', "day"::timestamp), \'YYYY-MM-DD\')',
    MONTH: 'to_char("day"::timestamp, \'YYYY-MM\')',
    QUARTER: 'to_char("day"::timestamp, \'YYYY-"Q"Q\')',
    YEAR: 'to_char("day"::timestamp, \'YYYY\')',
  };
  for (const [grain, sql] of Object.entries(expected)) assert.equal(buildTimeGrainExpression('day', grain, 'PG'), sql);
  assert.equal(buildTimeGrainExpression('day', null, 'PG'), '"day"');
});

test('PostgreSQL parameters preserve literals, identifiers and already-native placeholders', () => {
  assert.equal(postgresParameters('SELECT \'?\', \'it\'\'s ?\', "?", ? + ?'), 'SELECT \'?\', \'it\'\'s ?\', "?", $1 + $2');
  assert.equal(postgresParameters('SELECT $1, $2'), 'SELECT $1, $2');
});

test('SQL compiler preserves scoped/global/HAVING parameter order and never interpolates values', () => {
  const { service } = dialectDataset();
  const compiled = service.buildQuery(1, dialectRequest);
  assert.match(compiled.sql, /SUM\(CASE WHEN "region" = \$1 THEN "amount" ELSE 0 END\) AS "east_amount"/);
  assert.match(compiled.sql, /COUNT\(DISTINCT "order_id"\) AS "orders"/);
  assert.match(compiled.sql, /FROM "public"\."sales"/);
  assert.match(compiled.sql, /"region" IN \(\$2, \$3\)/);
  assert.match(compiled.sql, /HAVING SUM\("amount"\) > \$6/);
  assert.match(compiled.sql, /LIMIT \$7$/);
  assert.deepEqual(compiled.values, ['east', 'east', 'west', '2026-01-01', '2026-03-31', 5, 10]);
  const malicious = "east' OR 1=1 --";
  const query = service.buildQuery(1, { metrics: ['amount'], filters: [{ field: 'region', operator: '=', value: malicious }] });
  assert.equal(query.sql.includes(malicious), false);
  assert.deepEqual(query.values, [malicious, 200]);
});

test('SQL compiler numbers BETWEEN, null filters, conditional distinct and HAVING correctly', () => {
  const { service } = dialectDataset();
  const compiled = service.buildQuery(1, {
    metrics: [{ field: 'order_id', aggregator: 'COUNT_DISTINCT', predicateFilters: [{ field: 'region', operator: 'NOT_IN', value: ['x'] }] }],
    filters: [{ field: 'day', operator: 'BETWEEN', value: ['2026-01-01', '2026-12-31'] }, { field: 'region', operator: 'IS_NOT_NULL' }],
  });
  assert.match(compiled.sql, /COUNT\(DISTINCT CASE WHEN "region" NOT IN \(\$1\) THEN "order_id" END\)/);
  assert.match(compiled.sql, /"day" BETWEEN \$2 AND \$3 AND "region" IS NOT NULL/);
  assert.deepEqual(compiled.values, ['x', '2026-01-01', '2026-12-31', 200]);
});

test('PostgreSQL metadata preserves camel-case aliases and schema-qualified discovery', () => {
  const pg = getDialect('PG');
  assert.match(pg.metadataSql('schemas'), /information_schema.schemata/);
  assert.match(pg.metadataSql('tables'), /AS "tableName"/);
  assert.match(pg.metadataSql('columns'), /col_description/);
  assert.match(pg.prepareSql(pg.metadataSql('columns')), /n.nspname = \$1 AND c.relname = \$2/);
  for (const type of ['numeric(12,2)', 'real', 'bigint', 'double precision']) assert.equal(pg.classifyColumnType(type), 'NUMBER');
  assert.equal(pg.classifyColumnType('timestamp with time zone'), 'DATE');
  assert.equal(pg.classifyColumnType('boolean'), 'BOOLEAN');
  assert.equal(pg.classifyColumnType('text'), 'STRING');
});

test('PostgreSQL driver adapts timeouts, date strings, fields and precision without global parsers', async () => {
  let received;
  const raw = { on() {}, end: async () => {}, query: async (query) => {
    received = query;
    return { rows: [{ n: '9007199254740993' }], fields: [{ name: 'n', dataTypeID: 20 }] };
  } };
  const pool = adaptPostgresPool(raw, { getTypeParser: () => Number });
  const [rows, fields] = await pool.query({ sql: 'SELECT ? AS n', values: ['9007199254740993'], timeout: 1234 });
  assert.equal(received.text, 'SELECT $1 AS n');
  assert.equal(received.query_timeout, 1234);
  assert.equal(received.types.getTypeParser(1082)('2026-01-01'), '2026-01-01');
  assert.equal(received.types.getTypeParser(1114)('2026-01-01 01:00:00'), '2026-01-01 01:00:00');
  assert.equal(received.types.getTypeParser(23)('3'), 3);
  assert.equal(rows[0].n, '9007199254740993');
  assert.equal(fields[0].type, 20);
  await pool.end();
});

test('PostgreSQL SSL verifies certificates, with bounded/read-only connections', () => {
  const { source } = dialectDataset();
  const options = postgresPoolOptions({ ...source, options: { ssl: { ca: 'PEM', rejectUnauthorized: false } } }, 'secret');
  assert.deepEqual(options.ssl, { rejectUnauthorized: true, ca: 'PEM' });
  assert.equal(options.password, 'secret');
  assert.match(options.options, /default_transaction_read_only=on/);
  assert.equal(options.connectionTimeoutMillis, 10000);
  assert.equal(postgresPoolOptions(source, '').ssl, false);
});

test('PG sampling, profiling, distinct and execution use quoted source identifiers', async () => {
  const { service, logs } = dialectDataset();
  const queries = [];
  service.getPoolById = () => ({ query: async (query) => {
    queries.push(query.sql);
    return [[{ day: '2026-01-01', region: 'east', amount: '10', value: 'east', min_0: '2026-01-01', max_0: '2026-02-01' }], [{ name: 'amount', type: 1700 }]];
  } });
  await service.sampleDataset(1);
  const dataset = service.getDataset(1);
  await service.sampleForProfiling(dataset, service.getDatasetFields(1));
  const ranges = await service.listFieldRanges(dataset, service.getDatasetFields(1));
  assert.equal(ranges.day.min, '2026-01-01');
  assert.deepEqual(await service.listDistinctFieldValues(1, 'region'), ['east']);
  const result = await service.executeQuery({ datasetId: 1, request: { metrics: ['amount'] }, userId: 1 });
  assert.equal(result.columns[0].showType, 'NUMBER');
  assert.equal(logs[0].success, true);
  for (const sql of queries) { assert.match(sql, /"public"\."sales"/); assert.equal(sql.includes('`'), false); }
});

test('MySQL sampling supports a hyphenated database/schema name', async () => {
  const { service } = dialectDataset('MYSQL', 'yolo-data');
  let query;
  service.getPoolById = () => ({ query: async (input) => {
    query = input.sql;
    return [[{ day: '2026-01-01' }], [{ name: 'day' }]];
  } });

  await service.sampleDataset(1, 20);

  assert.match(query, /FROM `yolo-data`\.`sales` LIMIT \?/);
});

test('connection tests record driver/connection errors instead of throwing before the try block', async () => {
  const { service } = dialectDataset();
  service.createPool = () => { throw new Error('pg missing'); };
  assert.deepEqual(await service.testDataSource(1), { ok: false, message: 'pg missing' });
  let ended = false;
  service.createPool = () => ({ query: async () => { throw new Error('connection refused'); }, end: async () => { ended = true; } });
  assert.deepEqual(await service.testDataSource(1), { ok: false, message: 'connection refused' });
  assert.equal(ended, true);
});

test('PG datasource settings survive SQLite persistence without schema migrations or plaintext passwords', () => {
  const database = new PlatformDatabase(':memory:');
  try {
    const service = new BusinessDatasetService({ database, crypto: { encrypt: (password) => `encrypted:${password}` }, config: {} });
    const saved = service.saveDataSource({ name: 'PostgreSQL test', dbType: 'postgres', host: 'localhost', databaseName: 'analytics', username: 'reader', password: 'test-password', options: { ssl: { ca: 'PEM' } } });
    assert.equal(saved.dbType, 'POSTGRESQL');
    assert.equal(saved.port, 5432);
    assert.equal(saved.databaseName, 'analytics');
    assert.equal(saved.encryptedPassword, 'encrypted:test-password');
    assert.deepEqual(saved.options, { ssl: { ca: 'PEM' } });
    assert.equal('encryptedPassword' in database.listDataSources()[0], false);
    const dataset = database.saveBusinessDataset({ code: 'pg_sales', name: 'PG sales', datasourceId: saved.id, schemaName: 'public', primaryTable: 'sales' });
    assert.equal(dataset.dbType, 'POSTGRESQL');
    assert.equal(dataset.schemaName, 'public');
  } finally { database.db.close(); }
});


test('dialect fixture supports asynchronous metadata discovery without a platform repository', async () => {
  const { service } = dialectDataset();
  const calls = [];
  service.getPool = () => ({ query: async (query) => {
    calls.push(query);
    return [[{ schemaName: 'public' }]];
  } });
  assert.deepEqual(await service.listDatabases(1), ['public']);
  assert.match(calls[0], /information_schema.schemata/);
});
