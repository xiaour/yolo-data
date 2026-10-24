import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import { UserMemoryStore } from '../src/userMemory.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admission-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  t.after(async () => {
    await database.closeAsync();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { database, memory: new UserMemoryStore(database),
    userId: database.getUserByUsername('admin').id,
    otherId: database.getUserByUsername('east_manager').id,
    themeId: database.listThemes()[0].id };
}

test('concurrent SQLite document admission isolates users and scopes', async (t) => {
  const { memory, database, userId, otherId, themeId } = fixture(t);
  const documents = await Promise.all([
    memory.ensureDocumentAsync(userId), memory.ensureDocumentAsync(userId, themeId),
    memory.ensureDocumentAsync(otherId), memory.ensureDocumentAsync(otherId, themeId),
  ]);
  assert.equal(new Set(documents.map(document => document.id)).size, 4);
  assert.deepEqual(documents.map(document => [document.userId, document.themeId]),
    [[userId, null], [userId, themeId], [otherId, null], [otherId, themeId]]);
  assert.equal((await database.query('SELECT id FROM user_memory_documents')).length, 4);
});

test('concurrent SQLite admission returns one existing document without resetting its content or budgets', async (t) => {
  const { memory, database, userId, themeId } = fixture(t);
  const documents = await Promise.all(Array.from({ length: 6 }, () => memory.ensureDocumentAsync(userId)));
  assert.equal(new Set(documents.map(document => document.id)).size, 1);
  const differentlyConfigured = new UserMemoryStore(database, { summaryBudget: 10, contentBudget: 20 });
  // Pause real empty reads so another caller can create and edit the row
  // before these callers attempt their inserts.
  const getByScope = differentlyConfigured.getDocumentByScopeAsync.bind(differentlyConfigured);
  let release;
  let bothRead;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { bothRead = resolve; });
  let initialReads = 0;
  differentlyConfigured.getDocumentByScopeAsync = async (...args) => {
    const result = await getByScope(...args);
    if (initialReads++ < 2) {
      if (initialReads === 2) bothRead();
      await gate;
    }
    return result;
  };
  const pending = [differentlyConfigured.ensureDocumentAsync(userId, themeId), differentlyConfigured.ensureDocumentAsync(userId, themeId)];
  await ready;
  const winner = memory.ensureDocument(userId, themeId);
  const existing = memory.updateDocument(winner.id, { summary: '保留摘要', content: '保留正文' });
  release();
  const duplicates = await Promise.all(pending);
  for (const document of duplicates) assert.deepEqual(document, existing);
  assert.equal((await database.query('SELECT id FROM user_memory_documents')).length, 2);
});

test('SQLite document admission propagates insert failures', async (t) => {
  const { memory, database, userId } = fixture(t);
  await database.execute("CREATE TRIGGER reject_memory_document BEFORE INSERT ON user_memory_documents BEGIN SELECT RAISE(ABORT, 'forced memory insert failure'); END");
  await assert.rejects(memory.ensureDocumentAsync(userId), /forced memory insert failure/);
  assert.deepEqual(await database.query('SELECT id FROM user_memory_documents'), []);
});
