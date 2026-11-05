import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { PlatformDatabase } from '../src/database.js';
import { ensurePlatformMysqlDatasource } from '../src/application.js';
import { createKnexPlatformStore } from '../src/knexPlatformStore.js';
import {
  createPlatformDatabase,
  initializePlatformDatabase,
  normalizePlatformDatabaseConfig,
} from '../src/platformDatabase.js';

test('platform database config defaults to sqlite and keeps backend separate from datasource config', () => {
  assert.deepEqual(
    [
      normalizePlatformDatabaseConfig({}).backend,
      normalizePlatformDatabaseConfig({}).initSqlPath,
      normalizePlatformDatabaseConfig({ backend: 'SQLITE' }).backend,
    ],
    ['sqlite', './config/platform/sqlite-init.sql', 'sqlite'],
  );
});

test('SQLite platform database exposes the async query/execute/transaction contract', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-async-store-'));
  const database = new PlatformDatabase(path.join(directory, 'platform.db'));
  try {
    await database.execute(`
      CREATE TABLE store_contract_probe (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        value TEXT NOT NULL
      )
    `);
    const inserted = await database.execute(
      'INSERT INTO store_contract_probe (value) VALUES (?)',
      ['before'],
    );
    assert.ok(inserted.insertId > 0);
    assert.equal(inserted.affectedRows, 1);

    await database.transaction(async (tx) => {
      await tx.execute(
        'UPDATE store_contract_probe SET value = ? WHERE id = ?',
        ['after', inserted.insertId],
      );
    });
    const selected = await database.query(
      'SELECT value FROM store_contract_probe WHERE id = ?',
      [inserted.insertId],
    );
    assert.equal(selected[0].value, 'after');

    await assert.rejects(database.transaction(async (tx) => {
      await tx.execute('DELETE FROM store_contract_probe WHERE id = ?', [inserted.insertId]);
      throw new Error('rollback probe');
    }), /rollback probe/);
    assert.equal(
      (await database.query('SELECT COUNT(*) AS count FROM store_contract_probe'))[0].count,
      1,
    );
  } finally {
    await database.closeAsync();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('chat sessions persist the Codex thread mapping', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-codex-thread-'));
  const database = new PlatformDatabase(path.join(directory, 'platform.db'));
  try {
    const user = database.listUsers()[0];
    const theme = database.listThemes()[0];
    const session = database.createChatSession({ userId: user.id, themeId: theme.id });
    assert.equal(session.codexThreadId, null);
    const updated = database.updateChatSession(session.id, { codexThreadId: 'thread-123' });
    assert.equal(updated.codexThreadId, 'thread-123');
    assert.equal(database.listChatSessions(user.id)[0].codexThreadId, 'thread-123');
  } finally {
    await database.closeAsync();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('native node:sqlite store implements the shared async query and transaction contract', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-knex-sqlite-'));
  const store = createKnexPlatformStore({ backend: 'sqlite', path: path.join(directory, 'platform.db') });
  try {
    await store.execute('CREATE TABLE probe (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)');
    const inserted = await store.execute('INSERT INTO probe (value) VALUES (?)', ['before']);
    assert.equal(inserted.affectedRows, 1);
    assert.ok(inserted.insertId > 0);
    await store.transaction(async (tx) => {
      await tx.execute('UPDATE probe SET value=? WHERE id=?', ['after', inserted.insertId]);
    });
    assert.equal((await store.query('SELECT value FROM probe WHERE id=?', [inserted.insertId]))[0].value, 'after');
    await assert.rejects(store.transaction(async (tx) => {
      await tx.execute('DELETE FROM probe WHERE id=?', [inserted.insertId]);
      throw new Error('knex rollback probe');
    }), /knex rollback probe/);
    assert.equal((await store.query('SELECT COUNT(*) AS count FROM probe'))[0].count, 1);
  } finally {
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('platform database selects the matching init script for each backend', () => {
  assert.equal(
    normalizePlatformDatabaseConfig({ backend: 'mysql' }).initSqlPath,
    './config/platform/mysql-init.sql',
  );
});

test('configured MySQL backend connects and executes its selected init script', async () => {
  const calls = [];
  const initialized = await initializePlatformDatabase({
    backend: 'mysql',
    initSqlPath: 'config/platform/mysql-init.sql',
    mysql: { host: 'mysql-test', database: 'platform', user: 'platform', initialize: true },
  }, {
    mysqlStoreFactory: (config) => ({
      connect: async () => calls.push(['connect', config.mysql.host]),
      initialize: async (scriptPath) => {
        calls.push(['initialize', scriptPath]);
        return 42;
      },
      query: async (sql) => {
        calls.push(['query', sql]);
        return /^\s*SELECT COUNT\(\*\) AS count FROM/i.test(sql) ? [{ count: 1 }] : [];
      },
      execute: async (sql) => {
        calls.push(['execute', sql]);
        return { insertId: calls.length, affectedRows: 1 };
      },
      close: async () => calls.push(['close']),
    }),
  });
  assert.equal(initialized.backend, 'mysql');
  assert.equal(initialized.statementCount, 42);
  assert.equal(typeof initialized.database.listBusinessDatasetsAsync, 'function');
  assert.equal(typeof initialized.database.addAuditLogAsync, 'function');
  assert.equal(typeof initialized.database.createChatSessionAsync, 'function');
  assert.equal(typeof initialized.database.getChatSessionAsync, 'function');
  assert.equal(typeof initialized.database.listChatMessagesAsync, 'function');
  assert.equal(typeof initialized.database.appendChatMessageAsync, 'function');
  assert.equal(typeof initialized.database.saveConversationAsync, 'function');
  assert.equal(typeof initialized.database.createMcpApiKeyAsync, 'function');
  assert.equal(typeof initialized.database.listMcpApiKeysAsync, 'function');
  assert.equal(typeof initialized.database.revokeMcpApiKeyAsync, 'function');
  assert.equal(typeof initialized.database.getDataSourceByCodeAsync, 'function');
  assert.equal(typeof initialized.database.getBusinessDatasetAsync, 'function');
  assert.equal(typeof initialized.database.saveBusinessDatasetAsync, 'function');
  assert.equal(typeof initialized.database.replaceDatasetFieldsAsync, 'function');
  assert.equal(typeof initialized.database.listDatasetFieldsAsync, 'function');
  assert.equal(typeof initialized.database.setDatasetFieldEnabledAsync, 'function');
  assert.equal(typeof initialized.database.deleteBusinessDatasetAsync, 'function');
  assert.deepEqual(calls, [
    ['connect', 'mysql-test'],
    ['initialize', 'config/platform/mysql-init.sql'],
    ['query', 'SELECT `key` FROM platform_settings WHERE `key` = ?'],
    ['query', 'SELECT COUNT(*) AS count FROM app_users'],
  ]);
  const savedMessage = await initialized.database.appendChatMessageAsync({ sessionId: 7, userId: 3, role: 'user', content: 'question' });
  assert.equal(savedMessage.id, calls.length - 1);
  const conversationId = await initialized.database.saveConversationAsync({ userId: 3, themeId: 2, question: 'question', answer: {} });
  assert.equal(typeof conversationId, 'number');
  assert.equal(await initialized.database.getDataSourceByCodeAsync('absent'), null);
  assert.equal(await initialized.database.getBusinessDatasetAsync(999), null);
  assert.deepEqual(await initialized.database.listDatasetFieldsAsync(999), []);
  assert.equal(await initialized.database.deleteBusinessDatasetAsync(999), false);
  assert.ok(calls.some(([kind, sql]) => kind === 'query' && sql.includes('business_datasets')));
  await initialized.close();
  assert.deepEqual(calls.at(-1), ['close']);
});

test('PLATFORM_DB MySQL connection is initialized as an enabled read-only dataset datasource', async () => {
  const payloads = [];
  const service = {
    getDataSourceByCodeAsync: async () => null,
    saveDataSourceAsync: async (payload) => { payloads.push(payload); return payload; },
  };
  const source = await ensurePlatformMysqlDatasource({
    backend: 'mysql',
    mysql: { host: 'db.example', port: 3307, database: 'analytics', user: 'reader', password: 'secret' },
    businessDatasets: service,
  });
  assert.equal(source.code, 'platform_mysql');
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0], {
    code: 'platform_mysql', name: '平台 MySQL 数据源', dbType: 'MYSQL', host: 'db.example', port: 3307,
    databaseName: 'analytics', username: 'reader', password: 'secret', status: 1,
    options: { readonly: true, maxRows: 1000, queryTimeoutMs: 20000 },
  });
});

test('PLATFORM_DB datasource seeding is skipped for SQLite and never overwrites an existing source', async () => {
  let saves = 0;
  const existing = { code: 'platform_mysql', host: 'custom-host' };
  const service = {
    getDataSourceByCodeAsync: async () => existing,
    saveDataSourceAsync: async () => { saves += 1; },
  };
  assert.equal(await ensurePlatformMysqlDatasource({ backend: 'sqlite', mysql: { host: 'x', database: 'x', user: 'x' }, businessDatasets: service }), null);
  assert.equal(await ensurePlatformMysqlDatasource({ backend: 'mysql', mysql: { host: 'x', database: 'x', user: 'x' }, businessDatasets: service }), existing);
  assert.equal(saves, 0);
});

test('mysql platform backend fails clearly until the async store migration is enabled', () => {
  assert.throws(
    () => createPlatformDatabase({ backend: 'mysql', path: ':memory:' }),
    /PLATFORM_DB_BACKEND=mysql 尚未启用/,
  );
});

test('unknown platform database backend is rejected before opening a database', () => {
  assert.throws(
    () => normalizePlatformDatabaseConfig({ backend: 'h2' }),
    /不支持的平台数据库后端/,
  );
});

test('sqlite SQL compatibility migration upgrades an existing platform schema', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-migration-'));
  const filePath = path.join(directory, 'platform.db');
  let database;
  try {
    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      CREATE TABLE app_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'ANALYST',
        status INTEGER NOT NULL DEFAULT 1, attributes_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE themes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT '',
        indicator_ids_json TEXT NOT NULL DEFAULT '[]',
        allowed_dimensions_json TEXT NOT NULL DEFAULT '[]', default_chart TEXT NOT NULL DEFAULT 'auto',
        status INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    legacy.close();

    database = new PlatformDatabase(filePath);
    const columns = database.db.prepare('PRAGMA table_info(themes)').all()
      .map((column) => column.name);
    assert.ok(columns.includes('llm_config_json'));
    assert.ok(database.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_sessions'",
    ).get());
    assert.equal(
      database.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE key = '001-compatibility-columns'").get().count,
      1,
    );
  } finally {
    await database?.closeAsync();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
