import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MysqlPlatformStore,
  normalizeMysqlPlatformConfig,
} from '../src/mysqlPlatformStore.js';
import { splitSqlStatements } from '../src/mysqlMigrations.js';

test('mysql platform store normalizes connection settings without touching business datasource settings', () => {
  const config = normalizeMysqlPlatformConfig({
    host: 'mysql',
    port: 3307,
    database: 'platform',
    user: 'platform_user',
    password: 'secret',
  });
  assert.deepEqual(config, {
    host: 'mysql',
    port: 3307,
    database: 'platform',
    user: 'platform_user',
    password: 'secret',
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
    timezone: 'Z',
  });
});

test('mysql platform store requires platform database and user', () => {
  assert.throws(
    () => normalizeMysqlPlatformConfig({}),
    /PLATFORM_DB_NAME 和 PLATFORM_DB_USER/,
  );
});

test('mysql init SQL parser splits generated DDL and migration statement markers', () => {
  assert.deepEqual(splitSqlStatements(`-- header\nSET NAMES utf8mb4;\n-- table: t\nCREATE TABLE t (id INT);\n-- STATEMENT\nALTER TABLE t ADD COLUMN name VARCHAR(50);`), [
    'SET NAMES utf8mb4',
    'CREATE TABLE t (id INT)',
    'ALTER TABLE t ADD COLUMN name VARCHAR(50)',
  ]);
});

test('MySQL platform store exposes the same async query/execute/transaction contract', async () => {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push('begin'),
    query: async (sql, values) => { calls.push(['tx-query', sql, values]); return [[{ value: 7 }]]; },
    execute: async (sql, values) => { calls.push(['tx-execute', sql, values]); return [{ affectedRows: 1 }]; },
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
    release: () => calls.push('release'),
  };
  const pool = {
    getConnection: async () => connection,
    query: async (sql, values) => [[{ value: 3 }]],
    execute: async () => [{ affectedRows: 1, insertId: 9 }],
    end: async () => calls.push('end'),
  };
  const store = new MysqlPlatformStore({ database: 'platform', user: 'platform' }, {
    poolFactory: () => pool,
  });
  assert.deepEqual(await store.query('SELECT ?', [3]), [{ value: 3 }]);
  assert.deepEqual(await store.execute('INSERT INTO t VALUES (?)', [9]), {
    affectedRows: 1,
    insertId: 9,
  });
  calls.length = 0;
  const result = await store.transaction(async (tx) => {
    const rows = await tx.query('SELECT ?', [7]);
    await tx.execute('UPDATE t SET value = ?', [7]);
    return rows[0].value;
  });
  assert.equal(result, 7);
  assert.deepEqual(calls, [
    'begin', ['tx-query', 'SELECT ?', [7]], ['tx-execute', 'UPDATE t SET value = ?', [7]],
    'commit', 'release',
  ]);
  await store.close();
  assert.equal(calls.at(-1), 'end');
});
