import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import { SessionMemoryStore } from '../src/memory.js';
import {
  UserMemoryStore, MEMORY_KINDS, memoryScopeKey, normalizeNoteContent,
} from '../src/userMemory.js';
import {
  UserMemoryDistiller, extractExplicitNotes, appendOnlyMerge,
} from '../src/userMemoryDistiller.js';
import { USER_MEMORY_TOOLS, createUserMemoryToolHandler } from '../src/userMemoryTools.js';
import { startMemoryMaintenance } from '../src/userMemoryMaintenance.js';
import { startServer } from '../src/server.js';
import { FakeIndicatorClient } from './fixtures/fakeIndicatorClient.js';

function createHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-memory-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  const userMemories = new UserMemoryStore(database);
  const memory = new SessionMemoryStore(database, { userMemories });
  const admin = database.getUserByUsername('admin');
  const theme = database.listThemes()[0];
  return {
    directory, database, userMemories, memory, admin, theme,
  };
}

function testConfig(directory, overrides = {}) {
  return {
    projectRoot: process.cwd(),
    port: 0,
    dbPath: path.join(directory, 'test.db'),
    supersonic: { baseUrl: '', token: '', timeoutMs: 5_000 },
    deepseek: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      timeoutMs: 5_000,
      maxToolRounds: 3,
    },
    chatMemoryMessageLimit: 20,
    datasourceSecretKey: '',
    datasourceSecretKeyPath: path.join(directory, '.credential-key'),
    bootstrapDatasource: { enabled: false },
    uploads: { maxBytes: 64 * 1024, maxFilesPerSession: 5 },
    ...overrides,
  };
}

test('long-term memory keeps one handbook per user × scope, versioned and scoped', () => {
  const { userMemories, admin, theme } = createHarness();
  const document = userMemories.ensureDocument(admin.id, theme.id);
  assert.equal(document.version, 0);
  assert.equal(document.content, '');
  assert.equal(userMemories.ensureDocument(admin.id, theme.id).id, document.id, '同一作用域只有一份文档');

  const globalDocument = userMemories.ensureDocument(admin.id, null);
  assert.notEqual(globalDocument.id, document.id);
  assert.equal(globalDocument.scopeKey, memoryScopeKey(null));
  assert.equal(globalDocument.scopeLabel, '通用（全部智能体）');
  assert.equal(userMemories.listDocuments({ userId: admin.id }).length, 2);
  assert.equal(userMemories.listDocuments({ userId: admin.id, themeId: theme.id }).length, 2, '主题筛选包含通用层');

  assert.equal(userMemories.saveConsolidated(document.id, {
    summary: '覆盖含税口径',
    content: '## 口径偏好\n- 默认按含税口径看销售额',
    noteCount: 2,
    changeReason: '合并 2 条笔记',
  }).version, 1);
  const second = userMemories.saveConsolidated(document.id, {
    summary: '覆盖含税口径与时间习惯',
    content: '## 口径偏好\n- 默认按含税口径看销售额\n\n## 时间习惯\n- 默认看最近 30 天',
    noteCount: 1,
  });
  assert.equal(second.version, 2);
  const versions = userMemories.listVersions(document.id);
  assert.deepEqual(versions.map((item) => item.version), [2, 1]);

  const rolled = userMemories.rollback(document.id, 1);
  assert.equal(rolled.version, 3, '回滚本身也生成新版本');
  assert.match(rolled.content, /默认按含税口径看销售额/);
  assert.doesNotMatch(rolled.content, /最近 30 天/);
  assert.equal(userMemories.rollback(document.id, 99), null);
});

test('notes are append-only, deduped per scope and can be archived or revived', () => {
  const { userMemories, admin, theme, database } = createHarness();
  assert.equal(userMemories.createNote({ userId: admin.id, content: '短' }), null);
  assert.equal(userMemories.createNote({ userId: admin.id, content: 'x'.repeat(401) }), null);

  const created = userMemories.createNote({
    userId: admin.id, themeId: theme.id, kind: 'CALIBER', content: '  含税口径是默认口径。 ',
  });
  assert.equal(created.content, '含税口径是默认口径');
  assert.equal(created.kindLabel, '口径偏好');
  assert.equal(created.state, 'PENDING');

  const deduped = userMemories.createNote({
    userId: admin.id, themeId: theme.id, kind: 'TERM', content: '含税口径是默认口径',
  });
  assert.equal(deduped.id, created.id, '同作用域重复笔记只刷新原条目');
  assert.equal(deduped.deduped, true);
  assert.equal(deduped.kind, 'CALIBER', '重复笔记不覆盖已有类型');

  const global = userMemories.createNote({ userId: admin.id, kind: 'TERM', content: '跨智能体通用的术语映射' });
  assert.equal(global.scopeKey, memoryScopeKey(null));
  assert.equal(userMemories.pendingNotes(admin.id, theme.id).length, 2, '待合并含通用层');
  assert.equal(userMemories.pendingNotes(admin.id, theme.id + 999).length, 1, '其他智能体只看到通用层');

  userMemories.updateNote(created.id, { state: 'ARCHIVED' });
  assert.equal(userMemories.pendingNotes(admin.id, theme.id).length, 1);
  userMemories.createNote({ userId: admin.id, themeId: theme.id, content: '含税口径是默认口径' });
  assert.equal(userMemories.listNotes({ userId: admin.id, scopeKey: memoryScopeKey(theme.id) })[0].state, 'PENDING', '归档笔记再次被沉淀时自动恢复');

  const other = database.getUserByUsername('east_manager');
  assert.equal(userMemories.listNotes({ userId: other.id }).length, 0, '记忆按用户隔离');
  assert.equal(userMemories.listNotes({ userId: admin.id, kind: 'TERM' }).length, 1, '可按类型过滤');

  assert.equal(userMemories.removeNote(created.id), true);
  assert.equal(userMemories.listNotes({ userId: admin.id, scopeKey: memoryScopeKey(theme.id) }).length, 0);

  assert.ok(MEMORY_KINDS.some((item) => item.code === 'TIME_RANGE'));
  assert.equal(normalizeNoteContent('  a   b 。 '), 'a b', '归一化压缩空白并去掉句尾标点');
});

test('context injection sends only the summary and counts usage; paused documents are skipped', () => {
  const { userMemories, memory, admin, theme, database } = createHarness();
  const session = database.createChatSession({ userId: admin.id, themeId: theme.id, title: '注入测试' });
  database.appendChatMessage({ sessionId: session.id, userId: admin.id, role: 'user', content: '上个月销售额' });

  assert.equal(memory.buildModelContext(session.id, admin.id).length, 1, '没有记忆时不额外占用上下文');

  const document = userMemories.ensureDocument(admin.id, theme.id);
  userMemories.saveConsolidated(document.id, {
    summary: '默认按含税口径看销售额',
    content: '## 口径偏好\n- 默认按含税口径看销售额\n- 特殊口径细节不应常驻',
  });
  const context = memory.buildModelContext(session.id, admin.id);
  assert.equal(context.length, 2);
  assert.equal(context[0].role, 'system');
  assert.match(context[0].content, /默认按含税口径看销售额/);
  assert.match(context[0].content, /v1/);
  assert.doesNotMatch(context[0].content, /特殊口径细节不应常驻/, '正文细节不常驻，按需检索');
  assert.equal(userMemories.getDocument(document.id).injectedCount, 1);

  userMemories.updateDocument(document.id, { status: 0 });
  assert.equal(memory.buildModelContext(session.id, admin.id).length, 1, '暂停注入后不再占用上下文');
});

test('memory search returns located hits for the handbook body', () => {
  const { userMemories, admin, theme } = createHarness();
  const document = userMemories.ensureDocument(admin.id, theme.id);
  userMemories.saveConsolidated(document.id, {
    summary: '覆盖含税口径',
    content: '## 口径偏好\n- 默认按含税口径看销售额\n\n## 术语映射\n- 客户调价指渠道为调价的订单',
  });
  const hits = userMemories.search(admin.id, theme.id, '客户调价');
  assert.equal(hits.length, 1);
  assert.match(hits[0].excerpt, /客户调价/);
  assert.match(hits[0].location, /^theme:\d+#L\d+$/);
  assert.equal(userMemories.search(admin.id, theme.id, '不存在的词').length, 0);
  assert.ok(userMemories.stats(admin.id).documentsWithContent >= 1);
});

test('legacy row memories migrate into notes exactly once', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-memory-legacy-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  const admin = database.getUserByUsername('admin');
  database.db.exec(`
    CREATE TABLE user_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      theme_id INTEGER,
      category TEXT NOT NULL DEFAULT 'BUSINESS_KNOWLEDGE',
      content TEXT NOT NULL,
      status INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
  `);
  database.db.prepare(`
    INSERT INTO user_memories (user_id, theme_id, category, content, status, created_at)
    VALUES (?, NULL, 'TERM', '旧体系里的术语记忆', 1, ?)
  `).run(admin.id, new Date().toISOString());

  const store = new UserMemoryStore(database);
  const migrated = store.listNotes({ userId: admin.id });
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].state, 'PENDING');
  assert.equal(migrated[0].kind, 'TERM');

  assert.equal(new UserMemoryStore(database).listNotes({ userId: admin.id }).length, 1, '不重复迁移');
  database.close();
});

test('distiller extracts explicit remembers without a model', async () => {
  const { userMemories, admin, theme, database } = createHarness();
  const session = database.createChatSession({ userId: admin.id, themeId: theme.id, title: '显式记忆' });
  assert.deepEqual(extractExplicitNotes('华东上月销售额是多少'), []);
  assert.equal(extractExplicitNotes('记住：以后默认按未税口径看销售额').length, 1);

  const distiller = new UserMemoryDistiller({ store: userMemories });
  const notes = await distiller.distillConversation({
    userId: admin.id,
    themeId: theme.id,
    sessionId: session.id,
    question: '记住：以后默认按未税口径看销售额',
    answer: '好的。',
  });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].source, 'EXPLICIT');
  assert.match(notes[0].content, /默认按未税口径看销售额/);
  assert.equal(notes[0].sessionId, session.id);
});

test('distiller prefers model output and still keeps explicit remembers', async () => {
  const { userMemories, admin, theme, database } = createHarness();
  const session = database.createChatSession({ userId: admin.id, themeId: theme.id, title: '模型沉淀' });
  const payloads = [
    '[{"kind":"TERM","content":"客户调价指的是渠道为调价的订单","confidence":0.9},'
      + '{"kind":"TERM","content":"x","confidence":0.1}]',
    '不是 JSON',
  ];
  const harness = {
    chat: async () => ({ choices: [{ message: { content: payloads.shift() } }] }),
  };
  const distiller = new UserMemoryDistiller({ store: userMemories, resolveHarness: () => harness });

  const distilled = await distiller.distillConversation({
    userId: admin.id, themeId: theme.id, sessionId: session.id, question: '客户调价怎么理解', answer: '按渠道识别',
  });
  assert.equal(distilled.length, 1, '只保留通过校验的候选');
  assert.equal(distilled[0].kind, 'TERM');
  assert.equal(distilled[0].source, 'DISTILLED');

  const fallback = await distiller.distillConversation({
    userId: admin.id, themeId: theme.id, sessionId: session.id, question: '记住：默认看最近七天', answer: '',
  });
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].source, 'EXPLICIT', '模型无有效输出时仍保留显式记忆');
});

test('consolidation rewrites the handbook, marks notes merged and stays idempotent', async () => {
  const { userMemories, admin, theme } = createHarness();
  userMemories.createNote({ userId: admin.id, themeId: theme.id, kind: 'CALIBER', content: '默认含税口径' });
  userMemories.createNote({ userId: admin.id, themeId: theme.id, kind: 'TIME_RANGE', content: '默认看最近 30 天' });

  const harness = {
    chat: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            changed: true,
            summary: '覆盖含税口径与默认时间范围',
            content: '## 口径偏好\n- 默认含税口径\n\n## 时间习惯\n- 默认看最近 30 天',
          }),
        },
      }],
    }),
  };
  const distiller = new UserMemoryDistiller({ store: userMemories, resolveHarness: () => harness });
  const result = await distiller.consolidate({ userId: admin.id, themeId: theme.id });
  assert.equal(result.changed, true);
  assert.equal(result.merged, 2);
  assert.equal(result.document.version, 1);
  assert.match(result.document.summary, /默认时间范围/);
  assert.equal(userMemories.pendingNotes(admin.id, theme.id).length, 0);
  assert.equal(userMemories.listNotes({ userId: admin.id, state: 'MERGED' }).length, 2);
  assert.equal(userMemories.listNotes({ userId: admin.id, state: 'MERGED' })[0].mergedVersion, 1);

  const again = await distiller.consolidate({ userId: admin.id, themeId: theme.id });
  assert.deepEqual({ changed: again.changed, reason: again.reason }, { changed: false, reason: 'NO_PENDING_NOTES' });
  assert.equal(userMemories.getDocument(result.document.id).version, 1, '无待合并笔记时不产生新版本');

  userMemories.createNote({ userId: admin.id, themeId: theme.id, kind: 'TERM', content: '已被记住的术语' });
  const noopHarness = { chat: async () => ({ choices: [{ message: { content: '{"changed": false}' } }] }) };
  const noop = await new UserMemoryDistiller({ store: userMemories, resolveHarness: () => noopHarness })
    .consolidate({ userId: admin.id, themeId: theme.id, force: true });
  assert.equal(noop.reason, 'NO_MEANINGFUL_CHANGE');
  assert.equal(userMemories.pendingNotes(admin.id, theme.id).length, 1, '无实质变化时笔记保持待合并');
});

test('consolidation without a model appends notes verbatim instead of inventing content', async () => {
  const { userMemories, admin, theme } = createHarness();
  userMemories.createNote({ userId: admin.id, themeId: theme.id, kind: 'TERM', content: '客户调价指渠道为调价的订单' });
  const distiller = new UserMemoryDistiller({ store: userMemories });
  const result = await distiller.consolidate({ userId: admin.id, themeId: theme.id });
  assert.equal(result.changed, true);
  assert.equal(result.usedModel, false);
  assert.match(result.document.content, /### 术语映射/);
  assert.match(result.document.content, /客户调价指渠道为调价的订单/);
  assert.match(result.document.summary, /客户调价指渠道为调价的订单/);
  assert.match(appendOnlyMerge({ content: '', summary: '' }, [
    { kind: 'TERM', content: 'A 指 B' },
  ]).content, /A 指 B/);
});

test('memory tool lists scopes and searches the handbook on demand', async () => {
  const { userMemories, admin, theme } = createHarness();
  const handler = createUserMemoryToolHandler({ store: userMemories, user: admin, themeId: theme.id });
  assert.ok(USER_MEMORY_TOOLS.some((tool) => tool.function.name === 'search_user_memory'));

  const empty = await handler('search_user_memory', {});
  assert.equal(empty.available, false);

  const document = userMemories.ensureDocument(admin.id, theme.id);
  userMemories.saveConsolidated(document.id, {
    summary: '覆盖含税口径与术语映射',
    content: '## 术语映射\n- 客户调价指渠道为调价的订单',
  });
  const index = await handler('search_user_memory', {});
  assert.equal(index.available, true);
  assert.equal(index.scopes[0].version, 1);
  assert.deepEqual(index.scopes[0].sections, ['## 术语映射']);

  const found = await handler('search_user_memory', { query: '客户调价' });
  assert.equal(found.results.length, 1);
  assert.match(found.results[0].excerpt, /客户调价/);

  const missing = await handler('search_user_memory', { query: '不存在' });
  assert.equal(missing.results.length, 0);
  await assert.rejects(() => handler('unknown_tool', {}));
});

test('long-term memory api scopes普通用户到本人、管理员到全部用户', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-memory-http-'));
  const { server, application } = await startServer(
    testConfig(directory),
    new FakeIndicatorClient(),
  );
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const admin = { 'content-type': 'application/json', 'x-user-id': '1' };
  const analyst = { 'content-type': 'application/json', 'x-user-id': '2' };
  try {
    const created = await fetch(`${baseUrl}/api/memories/notes`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ content: '管理员的长期记忆', kind: 'CALIBER' }),
    });
    assert.equal(created.status, 200);
    const adminNote = await created.json();
    assert.equal(adminNote.userId, 1);
    assert.equal(adminNote.kindLabel, '口径偏好');

    const shortContent = await fetch(`${baseUrl}/api/memories/notes`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ content: '短' }),
    });
    assert.equal(shortContent.status, 400);

    const analystList = await fetch(`${baseUrl}/api/memories`, { headers: analyst });
    const analystPayload = await analystList.json();
    assert.equal(analystPayload.scope, 'self');
    assert.equal(analystPayload.notes.length, 0, '看不到他人笔记');
    assert.equal(analystPayload.documents.length, 0);
    assert.deepEqual(analystPayload.users, []);

    const override = await fetch(`${baseUrl}/api/memories?userId=1`, { headers: analyst });
    assert.equal((await override.json()).notes.length, 0, '普通用户不能用 userId 越权');

    const adminList = await fetch(`${baseUrl}/api/memories`, { headers: admin });
    const adminPayload = await adminList.json();
    assert.equal(adminPayload.scope, 'all');
    assert.equal(adminPayload.notes.length, 1);
    assert.ok(adminPayload.notes[0].userName, '管理员列表带出记忆归属人');
    assert.ok(adminPayload.users.length >= 2, '管理员可切换用户');
    assert.ok(adminPayload.kinds.some((item) => item.code === 'TIME_RANGE'));

    const analystPatch = await fetch(`${baseUrl}/api/memories/notes/${adminNote.id}`, {
      method: 'PATCH',
      headers: analyst,
      body: JSON.stringify({ state: 'ARCHIVED' }),
    });
    assert.equal(analystPatch.status, 404, '普通用户不能修改他人笔记');
    const analystDelete = await fetch(`${baseUrl}/api/memories/notes/${adminNote.id}`, {
      method: 'DELETE',
      headers: analyst,
    });
    assert.equal(analystDelete.status, 404);

    const consolidated = await fetch(`${baseUrl}/api/memories/consolidate`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({}),
    });
    const consolidatedPayload = await consolidated.json();
    assert.equal(consolidatedPayload.changed, true);
    assert.equal(consolidatedPayload.merged, 1);
    assert.equal(consolidatedPayload.document.version, 1);
    assert.match(consolidatedPayload.document.content, /管理员的长期记忆/);
    const documentId = consolidatedPayload.document.id;

    const versions = await fetch(`${baseUrl}/api/memories/documents/${documentId}/versions`, { headers: admin });
    assert.deepEqual((await versions.json()).versions.map((item) => item.version), [1]);

    const edited = await fetch(`${baseUrl}/api/memories/documents/${documentId}`, {
      method: 'PATCH',
      headers: admin,
      body: JSON.stringify({ summary: '管理员的手册摘要', content: '## 口径偏好\n- 管理员的长期记忆（修订）' }),
    });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).version, 2);

    const rollback = await fetch(`${baseUrl}/api/memories/documents/${documentId}/rollback`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(rollback.status, 200);
    const rolled = await rollback.json();
    assert.equal(rolled.version, 3);
    assert.doesNotMatch(rolled.content, /修订/);

    const missingVersion = await fetch(`${baseUrl}/api/memories/documents/${documentId}/rollback`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ version: 99 }),
    });
    assert.equal(missingVersion.status, 404);

    const analystRollback = await fetch(`${baseUrl}/api/memories/documents/${documentId}/rollback`, {
      method: 'POST',
      headers: analyst,
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(analystRollback.status, 404, '普通用户不能回滚他人文档');

    const session = await fetch(`${baseUrl}/api/chat/sessions`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ title: '沉淀用会话', themeId: application.database.listThemes()[0].id }),
    });
    const sessionPayload = await session.json();
    const distillNoModel = await fetch(`${baseUrl}/api/memories/distill`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ sessionId: sessionPayload.id, useModel: false }),
    });
    assert.equal(distillNoModel.status, 200);
    assert.equal((await distillNoModel.json()).count, 0, '无模型且无显式记忆时不沉淀');

    // 「我的记忆」视图：管理员也只带自己的 userId，接口必须收敛到本人。
    const selfScoped = await fetch(`${baseUrl}/api/memories?userId=1`, { headers: admin });
    const selfPayload = await selfScoped.json();
    assert.equal(selfPayload.scope, 'user');
    assert.ok(selfPayload.documents.every((item) => Number(item.userId) === 1));
    assert.equal(typeof selfPayload.maintenance?.intervalMs, 'number', '列表返回自动整理状态');

    // 手动整理：测试环境没有可用模型，压缩必须显式降级而不是编造内容。
    const ownerDocument = await application.userMemories.ensureDocument(1, null);
    application.userMemories.saveConsolidated(ownerDocument.id, {
      summary: '旧的通用摘要',
      content: `## 口径偏好\n${'- 默认按含税口径看销售额\n'.repeat(600)}`,
    });
    const maintain = await fetch(`${baseUrl}/api/memories/maintain`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ userId: 1, themeId: null }),
    });
    assert.equal(maintain.status, 200);
    const maintainPayload = await maintain.json();
    assert.equal(maintainPayload.compacted.reason, 'MODEL_REQUIRED', '没有模型时不做压缩');

    const versionBefore = application.userMemories.getDocument(documentId).version;
    const analystMaintain = await fetch(`${baseUrl}/api/memories/maintain`, {
      method: 'POST',
      headers: analyst,
      body: JSON.stringify({ userId: 1, themeId: null }),
    });
    const analystPayload2 = await analystMaintain.json();
    assert.equal(
      Number(analystPayload2.compacted.document.userId),
      2,
      '普通用户的维护请求只能作用在自己身上',
    );
    assert.equal(
      application.userMemories.getDocument(documentId).version,
      versionBefore,
      '普通用户的维护请求不越权改动他人记忆',
    );

    const removed = await fetch(`${baseUrl}/api/memories/documents/${documentId}`, {
      method: 'DELETE',
      headers: admin,
    });
    assert.equal(removed.status, 200);
    assert.equal(await application.userMemories.getDocument(documentId), null);
    assert.equal(application.userMemories.listNotes({ userId: 1 }).length, 0, '清空文档会一并清理该作用域笔记');
    assert.equal(await application.userMemories.getDocument(ownerDocument.id), null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    application.database.close();
  }
});

test('auto compaction shortens an over-budget handbook and keeps a rollback version', async () => {
  const { userMemories, admin, theme } = createHarness();
  const body = `## 口径偏好\n${'- 默认按含税口径看销售额\n'.repeat(600)}`;
  const document = userMemories.ensureDocument(admin.id, theme.id);
  userMemories.saveConsolidated(document.id, { summary: '旧摘要', content: body });
  const longContent = userMemories.getDocument(document.id).content;
  assert.ok(longContent.length >= 6400, '测试数据要超过压缩阈值');

  const compressedBody = `## 口径偏好\n${'- 默认按含税口径看销售额\n'.repeat(250)}`;
  const harness = {
    chat: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            changed: true,
            summary: '覆盖含税口径',
            content: compressedBody,
            removed: ['重复的口径偏好条目'],
          }),
        },
      }],
    }),
  };
  const distiller = new UserMemoryDistiller({
    store: userMemories, resolveHarness: () => harness,
  });

  const small = userMemories.ensureDocument(admin.id, null);
  userMemories.saveConsolidated(small.id, {
    summary: '小摘要',
    content: '## 术语映射\n- 客户调价指渠道为调价的订单',
  });
  const skipped = await distiller.compact({ userId: admin.id, themeId: null, auto: true });
  assert.equal(skipped.reason, 'NOT_NEEDED', '未超阈值时不自动压缩');

  const result = await distiller.compact({ userId: admin.id, themeId: theme.id, auto: true });
  assert.equal(result.reason, 'COMPRESSED');
  assert.equal(result.changed, true);
  assert.ok(result.after < result.before);
  assert.equal(result.document.version, 2);
  assert.match(result.document.summary, /覆盖含税口径/);
  assert.equal(userMemories.listVersions(document.id)[0].changeReason.startsWith('自动压缩'), true);

  const rolled = userMemories.rollback(document.id, 1);
  assert.equal(rolled.content, longContent, '压缩前的版本仍可回滚');
});

test('auto compaction refuses to grow, over-compress or run without a model', async () => {
  const { userMemories, admin, theme } = createHarness();
  const document = userMemories.ensureDocument(admin.id, theme.id);
  userMemories.saveConsolidated(document.id, {
    summary: '旧摘要',
    content: `## 口径偏好\n${'- 默认按含税口径看销售额\n'.repeat(600)}`,
  });
  const content = userMemories.getDocument(document.id).content;

  const distillerFor = (payload) => new UserMemoryDistiller({
    store: userMemories,
    resolveHarness: () => ({ chat: async () => ({ choices: [{ message: { content: payload } }] }) }),
  });

  const noModel = new UserMemoryDistiller({ store: userMemories });
  assert.equal(
    (await noModel.compact({ userId: admin.id, themeId: theme.id })).reason,
    'MODEL_REQUIRED',
    '没有模型时不做压缩，也不编造内容',
  );

  const growing = await distillerFor(JSON.stringify({
    changed: true, summary: '更长的摘要', content: `${content}\n- 又加了一条`,
  })).compact({ userId: admin.id, themeId: theme.id });
  assert.equal(growing.reason, 'NOT_SHORTER');
  assert.equal(userMemories.getDocument(document.id).version, 1);

  const destructive = await distillerFor(JSON.stringify({
    changed: true, summary: '几乎清空', content: '## 口径偏好\n- 含税',
  })).compact({ userId: admin.id, themeId: theme.id });
  assert.equal(destructive.reason, 'OVER_COMPRESSED');
  assert.equal(userMemories.getDocument(document.id).content, content, '异常压缩不落库');

  const noop = await distillerFor('{"changed": false}')
    .compact({ userId: admin.id, themeId: theme.id });
  assert.equal(noop.reason, 'NO_MEANINGFUL_CHANGE');
});

test('maintain folds notes in and compresses in one automatic pass', async () => {
  const { userMemories, admin, theme } = createHarness();
  userMemories.createNote({
    userId: admin.id, themeId: theme.id, kind: 'CALIBER', content: '默认按含税口径看销售额',
  });
  const longBody = `## 口径偏好\n${'- 默认按含税口径看销售额\n'.repeat(600)}`;
  const harness = {
    chat: async (messages) => ({
      choices: [{
        message: {
          content: messages[0].content.includes('压缩器')
            ? JSON.stringify({
              changed: true,
              summary: '覆盖含税口径',
              content: `## 口径偏好\n${'- 默认按含税口径看销售额\n'.repeat(250)}`,
            })
            : JSON.stringify({ changed: true, summary: '覆盖含税口径', content: longBody }),
        },
      }],
    }),
  };
  const distiller = new UserMemoryDistiller({ store: userMemories, resolveHarness: () => harness });

  const result = await distiller.maintain({ userId: admin.id, themeId: theme.id });
  assert.equal(result.changed, true);
  assert.equal(result.consolidated.reason, 'CONSOLIDATED');
  assert.equal(result.compacted.reason, 'COMPRESSED', '合并后超阈值立即压缩');
  assert.ok(result.compacted.after < result.compacted.before);
  assert.equal(userMemories.pendingNotes(admin.id, theme.id).length, 0);

  const idle = await distiller.maintain({ userId: admin.id, themeId: theme.id, auto: true });
  assert.equal(idle.changed, false);
  assert.equal(idle.consolidated.reason, 'NO_PENDING_NOTES');
  assert.equal(idle.compacted.reason, 'NOT_NEEDED');
});

test('auto consolidation respects the batch threshold and cooldown', async () => {
  const { userMemories, admin, theme } = createHarness();
  userMemories.createNote({ userId: admin.id, themeId: theme.id, kind: 'CALIBER', content: '第一条笔记' });
  let calls = 0;
  // 模拟真实模型：把待合并笔记原样整理进正文，保证每次合并都带来变化。
  const harness = {
    chat: async (messages) => {
      calls += 1;
      const payload = JSON.parse(messages[1].content);
      const lines = (payload.notes ?? []).map((note) => `- ${note.content}`).join('\n');
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              changed: true,
              summary: `覆盖 ${(payload.notes ?? []).length} 条口径`,
              content: `## 口径偏好\n${lines}`,
            }),
          },
        }],
      };
    },
  };
  const distiller = new UserMemoryDistiller({
    store: userMemories, resolveHarness: () => harness, autoConsolidateAt: 3,
  });

  const belowThreshold = await distiller.consolidate({ userId: admin.id, themeId: theme.id, auto: true });
  assert.equal(belowThreshold.reason, 'BELOW_THRESHOLD');
  assert.equal(calls, 0, '未达批量阈值不动模型');

  userMemories.createNote({ userId: admin.id, themeId: theme.id, kind: 'CALIBER', content: '第二条笔记' });
  userMemories.createNote({ userId: admin.id, themeId: theme.id, kind: 'CALIBER', content: '第三条笔记' });
  const first = await distiller.consolidate({ userId: admin.id, themeId: theme.id, auto: true });
  assert.equal(first.reason, 'CONSOLIDATED');
  assert.equal(calls, 1);

  userMemories.createNote({ userId: admin.id, themeId: theme.id, kind: 'CALIBER', content: '第四条笔记' });
  userMemories.createNote({ userId: admin.id, themeId: theme.id, kind: 'CALIBER', content: '第五条笔记' });
  userMemories.createNote({ userId: admin.id, themeId: theme.id, kind: 'CALIBER', content: '第六条笔记' });
  const cooled = await distiller.consolidate({ userId: admin.id, themeId: theme.id, auto: true });
  assert.equal(cooled.reason, 'COOLDOWN', '冷却期内不重复调用模型');
  assert.equal(calls, 1);

  const manual = await distiller.consolidate({ userId: admin.id, themeId: theme.id });
  assert.equal(manual.changed, true, '手动合并不受阈值与冷却限制');
  assert.equal(userMemories.pendingNotes(admin.id, theme.id).length, 0);

  const sweepLike = await distiller.maintain({
    userId: admin.id, themeId: theme.id, auto: true, minPending: 1,
  });
  assert.equal(sweepLike.consolidated.reason, 'NO_PENDING_NOTES');
});

test('maintenance sweep walks scopes with pending notes or oversized handbooks', async () => {
  const { userMemories, admin, theme } = createHarness();
  const document = userMemories.ensureDocument(admin.id, theme.id);
  userMemories.saveConsolidated(document.id, {
    summary: '旧摘要',
    content: `## 口径偏好\n${'- 默认按含税口径看销售额\n'.repeat(600)}`,
  });
  const other = userMemories.ensureDocument(admin.id, null);
  userMemories.createNote({ userId: admin.id, kind: 'TERM', content: '客户调价指渠道为调价的订单' });

  const targets = userMemories.listMaintenanceTargets({ compactThreshold: 6400 });
  assert.equal(targets.length, 2, '过长的文档和有待合并笔记的作用域都要被巡检到');
  assert.ok(targets.some((item) => item.themeId === theme.id && item.contentLength >= 6400));
  assert.ok(targets.some((item) => item.themeId === null && item.pendingNotes >= 1));
  assert.equal(userMemories.listMaintenanceTargets({ compactThreshold: 0 })[0].pendingNotes >= 1, true);

  const harness = {
    chat: async (messages) => ({
      choices: [{
        message: {
          content: messages[0].content.includes('压缩器')
            ? JSON.stringify({
              changed: true,
              summary: '覆盖含税口径',
              content: `## 口径偏好\n${'- 默认按含税口径看销售额\n'.repeat(250)}`,
            })
            : JSON.stringify({
              changed: true, summary: '覆盖术语', content: '## 术语映射\n- 客户调价指渠道为调价的订单',
            }),
        },
      }],
    }),
  };
  const distiller = new UserMemoryDistiller({ store: userMemories, resolveHarness: () => harness });
  const maintenance = startMemoryMaintenance({ distiller, intervalMs: 0 });
  assert.equal(maintenance.enabled, false, 'intervalMs<=0 时巡检保持关闭');

  const result = await maintenance.runOnce();
  assert.equal(result.processed, 2);
  assert.equal(result.changed, 2);
  assert.ok(maintenance.stats().lastRunAt);
  assert.equal(userMemories.getDocument(other.id).content.includes('客户调价'), true);
  const compactedDocument = userMemories.getDocument(document.id);
  assert.ok(compactedDocument.content.length < 4000, '过长正文被压缩');
  assert.match(compactedDocument.content, /默认按含税口径看销售额/);
  assert.equal(compactedDocument.version > document.version, true);
  maintenance.stop();
  assert.equal(maintenance.enabled, false);
});
