import assert from 'node:assert/strict';
import test from 'node:test';
import { initializePlatformDatabase } from '../src/platformDatabase.js';
import { DataSourceRepository } from '../src/dataSourceRepository.js';

const databaseName = process.env.YOLO_MYSQL_UPLOAD_TEST_DATABASE;
test('live MySQL rejects stale connection results including case-only credential changes', { skip: !databaseName }, async t => {
  const platform = await initializePlatformDatabase({ backend: 'mysql', mysql: {
    host: process.env.YOLO_MYSQL_UPLOAD_TEST_HOST ?? '127.0.0.1',
    port: Number(process.env.YOLO_MYSQL_UPLOAD_TEST_PORT ?? 3306), database: databaseName,
    user: process.env.YOLO_MYSQL_UPLOAD_TEST_USER ?? 'root',
    password: process.env.YOLO_MYSQL_UPLOAD_TEST_PASSWORD ?? 'test',
  } });
  let sourceId;
  t.after(async () => {
    try { if (sourceId) await platform.database.execute('DELETE FROM data_sources WHERE id=?', [sourceId]); }
    finally { await platform.close(); }
  });
  const database = platform.database;
  const repo = database.dataSourceRepository;
  const source = await repo.saveDataSourceAsync({ code: 'cas_source', name: 'CAS source', dbType: 'MYSQL',
    host: 'old.example', username: 'reader', encryptedPassword: 'Cipher', options: { tag: 'Case' } });
  sourceId = source.id;
  for (const [field, replacement] of [['host', 'OLD.EXAMPLE'], ['username', 'READER'],
    ['encrypted_password', 'cipher'], ['options_json', '{"tag":"case"}']]) {
    const original = await repo.getDataSourceAsync(source.id);
    let edited = false;
    const interleaved = new DataSourceRepository(null, {
      backend: 'mysql', query: (...args) => database.query(...args),
      async execute(sql, bindings) {
        if (!edited) {
          edited = true;
          await database.execute(`UPDATE data_sources SET ${field}=?, last_test_at=NULL,
            last_test_ok=NULL, last_test_message='' WHERE id=?`, [replacement, source.id]);
        }
        return database.execute(sql, bindings);
      },
    });
    const result = await interleaved.updateDataSourceTestAsync(source.id, { ok: true, message: 'stale' }, original);
    assert.equal(edited, true);
    assert.equal(result.lastTestAt, null, field);
    assert.equal(result.lastTestOk, null, field);
    assert.equal(result.lastTestMessage, '', field);
    const fresh = await repo.updateDataSourceTestAsync(source.id, { ok: false, message: 'fresh' }, result);
    assert.equal(fresh.lastTestOk, false, field);
    assert.equal(fresh.lastTestMessage, 'fresh', field);
    assert.ok(fresh.lastTestAt, field);
  }
});
