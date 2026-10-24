import assert from 'node:assert/strict';
import test from 'node:test';
import { initializePlatformDatabase } from '../src/platformDatabase.js';
import { UserMemoryStore } from '../src/userMemory.js';

const databaseName = process.env.YOLO_MYSQL_UPLOAD_TEST_DATABASE;
test('live MySQL memory document admission preserves concurrent scope identity and existing data', { skip: !databaseName }, async (t) => {
  // Shares the disposable CI database with upload acceptance, run sequentially.
  const platform = await initializePlatformDatabase({ backend: 'mysql', mysql: {
    host: process.env.YOLO_MYSQL_UPLOAD_TEST_HOST ?? '127.0.0.1',
    port: Number(process.env.YOLO_MYSQL_UPLOAD_TEST_PORT ?? 3306),
    database: databaseName, user: process.env.YOLO_MYSQL_UPLOAD_TEST_USER ?? 'root',
    password: process.env.YOLO_MYSQL_UPLOAD_TEST_PASSWORD ?? 'test', connectionLimit: 6,
  } });
  t.after(() => platform.close());
  const database = platform.database;
  const userId = (await database.listUsersAsync()).find(user => user.username === 'admin').id;
  const otherId = (await database.listUsersAsync()).find(user => user.username === 'east_manager').id;
  const themeId = (await database.listThemesAsync())[0].id;
  const memory = new UserMemoryStore(database);
  const documents = await Promise.all([
    memory.ensureDocumentAsync(userId), memory.ensureDocumentAsync(userId, themeId),
    memory.ensureDocumentAsync(otherId), memory.ensureDocumentAsync(otherId, themeId),
    memory.ensureDocumentAsync(userId), memory.ensureDocumentAsync(userId, themeId),
  ]);
  assert.equal(new Set(documents.map(document => document.id)).size, 4);
  assert.equal(documents[0].id, documents[4].id);
  assert.equal(documents[1].id, documents[5].id);
  assert.deepEqual(documents.slice(0, 4).map(document => [document.userId, document.themeId]),
    [[userId, null], [userId, themeId], [otherId, null], [otherId, themeId]]);
  const differentlyConfigured = new UserMemoryStore(database, { summaryBudget: 10, contentBudget: 20 });
  // Capture real empty reads, then make the row exist before admission resumes.
  await database.execute('DELETE FROM user_memory_documents WHERE id = ?', [documents[0].id]);
  const getByScope = differentlyConfigured.getDocumentByScopeAsync.bind(differentlyConfigured);
  let release;
  let bothRead;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { bothRead = resolve; });
  let reads = 0;
  differentlyConfigured.getDocumentByScopeAsync = async (...args) => {
    const result = await getByScope(...args);
    if (reads++ < 2) {
      if (reads === 2) bothRead();
      await gate;
    }
    return result;
  };
  const pending = [differentlyConfigured.ensureDocumentAsync(userId), differentlyConfigured.ensureDocumentAsync(userId)];
  await ready;
  const winner = await memory.ensureDocumentAsync(userId);
  await memory.updateDocumentAsync(winner.id, { summary: 'preserved summary', content: 'preserved content' });
  const preserved = await memory.getDocumentAsync(winner.id);
  release();
  for (const document of await Promise.all(pending)) assert.deepEqual(document, preserved);
  const [count] = await database.query('SELECT COUNT(*) AS n FROM user_memory_documents WHERE user_id = ? AND scope_key = ?', [userId, 'global']);
  assert.equal(Number(count.n), 1);
  await database.execute("CREATE TRIGGER reject_memory_document BEFORE INSERT ON user_memory_documents FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced memory insert failure'");
  try {
    await assert.rejects(memory.ensureDocumentAsync(-1), /forced memory insert failure/);
  } finally { await database.execute('DROP TRIGGER reject_memory_document'); }
});
