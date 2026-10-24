import assert from 'node:assert/strict';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import { DataSourceRepository } from '../src/dataSourceRepository.js';

for (const ok of [true, false]) {
  test(`a stale ${ok ? 'successful' : 'failed'} test cannot overwrite a connection edited immediately before persistence`, async t => {
    const database = new PlatformDatabase(':memory:');
    t.after(() => database.closeAsync());
    const original = database.saveDataSource({ code: 'atomic_test', name: 'Atomic test', dbType: 'MYSQL',
      host: 'old.example', username: 'reader', options: { connectTimeout: 1234 } });
    let updated = false;
    const repository = new DataSourceRepository(null, {
      async query(sql, bindings = []) { return database.db.prepare(sql).all(...bindings); },
      async execute(sql, bindings = []) {
        if (!updated) {
          updated = true;
          database.saveDataSource({ ...original, host: 'new.example' }, original.id);
        }
        const result = database.db.prepare(sql).run(...bindings);
        return { affectedRows: Number(result.changes) };
      },
    });
    const result = await repository.updateDataSourceTestAsync(original.id, { ok, message: 'old connection result' }, original);
    assert.equal(updated, true);
    assert.equal(result.host, 'new.example');
    assert.equal(result.lastTestAt, null);
    assert.equal(result.lastTestOk, null);
    assert.equal(result.lastTestMessage, '');
    const current = await repository.getDataSourceAsync(original.id);
    const fresh = await repository.updateDataSourceTestAsync(original.id, { ok: true, message: 'fresh connection' }, current);
    assert.equal(fresh.lastTestOk, true);
    assert.equal(fresh.lastTestMessage, 'fresh connection');
    assert.match(fresh.lastTestAt, /^\d{4}-/);
    database.db.prepare('DELETE FROM data_sources WHERE id = ?').run(original.id);
    assert.equal(await repository.updateDataSourceTestAsync(original.id, { ok }, current), null);
  });
}
