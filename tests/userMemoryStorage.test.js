import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import { UserMemoryStore } from '../src/userMemory.js';

// Executes every statement against SQLite while exposing only the MySQL store
// contract (including result shapes). No canned query results or sync fallback.
function asyncOnlyStore(sqlite) {
  const store = {
    isAsyncPlatformStore: true,
    query: async (sql, params = []) => sqlite.prepare(sql).all(...params),
    execute: async (sql, params = []) => {
      const result = sqlite.prepare(sql).run(...params);
      return { insertId: Number(result.lastInsertRowid), affectedRows: Number(result.changes) };
    },
    transaction: async (callback) => {
      sqlite.exec('BEGIN');
      try {
        const result = await callback(store);
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return store;
}

for (const mode of ['sync', 'sqlite-async', 'mysql-shaped']) {
  test(`memory storage preserves scoped lifecycle through ${mode}`, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-storage-'));
    const database = new PlatformDatabase(path.join(directory, 'test.db'));
    t.after(async () => {
      await database.closeAsync();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const userId = database.getUserByUsername('admin').id;
    const otherId = database.getUserByUsername('east_manager').id;
    const themeId = database.listThemes()[0].id;
    const memory = new UserMemoryStore(mode === 'mysql-shaped' ? asyncOnlyStore(database.db) : database);
    const call = (method, ...args) => memory[`${method}${mode === 'sync' ? '' : 'Async'}`](...args);
    assert.equal(await call('createNote', { userId, content: '短' }), null);
    const global = await call('ensureDocument', userId);
    const scoped = await call('ensureDocument', userId, themeId);
    assert.equal((await call('ensureDocument', userId, themeId)).id, scoped.id);
    assert.equal(await call('getDocument', -1), null);
    const input = { userId, themeId, kind: 'CALIBER', source: 'MANUAL', content: '默认使用含税销售口径' };
    const note = await call('createNote', input);
    await call('createNote', { userId, content: '通用记忆术语偏好' });
    await call('createNote', { userId: otherId, content: '其他用户独立偏好' });
    await call('updateNote', note.id, { state: 'ARCHIVED' });
    const revived = await call('createNote', { ...input, kind: 'TERM', source: 'DISTILLED' });
    assert.equal(revived.id, note.id);
    assert.equal(revived.deduped, true);
    assert.equal(revived.kind, 'CALIBER');
    assert.equal(revived.source, 'MANUAL');
    assert.equal(revived.state, 'PENDING');
    assert.equal((await call('pendingNotes', userId, themeId)).length, 2);
    assert.equal((await call('listNotes', { userId, scopeKey: scoped.scopeKey, kind: 'caliber', keyword: '含税' })).length, 1);
    assert.equal((await call('listNotes', { userId: otherId })).length, 1);
    await call('saveConsolidated', scoped.id, { summary: '含税偏好', content: '第一行\n含税销售口径\n第三行', noteCount: 1 });
    assert.equal(await call('markNotesMerged', [note.id, 'invalid'], 1), 1);
    assert.equal((await call('getNote', note.id)).mergedVersion, 1);
    await call('updateDocument', scoped.id, { content: '新的含税销售口径' });
    assert.deepEqual((await call('listVersions', scoped.id)).map((row) => row.version), [2, 1]);
    assert.equal((await call('rollback', scoped.id, 1)).version, 3);
    assert.equal(await call('rollback', scoped.id, 999), null);
    assert.equal((await call('search', userId, themeId, '含税'))[0].location, `${scoped.scopeKey}#L2`);
    assert.match((await call('buildContextMessage', userId, themeId)).retrievalText, /含税偏好/);
    assert.equal((await call('getDocument', scoped.id)).injectedCount, 1);
    await call('updateDocument', scoped.id, { status: 0 });
    assert.equal(await call('buildContextMessage', userId, themeId), null);
    assert.equal((await call('listMaintenanceTargets', { compactThreshold: 1 })).some((row) => row.scopeKey === scoped.scopeKey), true);
    assert.equal((await call('stats', userId)).notes, 2);
    assert.equal(await call('removeDocument', scoped.id), true);
    assert.equal(await call('getNote', note.id), null);
    assert.deepEqual(await call('listVersions', scoped.id), []);
    assert.equal((await call('getDocument', global.id)).id, global.id);
    assert.equal(await call('removeDocument', scoped.id), false);
  });
}
