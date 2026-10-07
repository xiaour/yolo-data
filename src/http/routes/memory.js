// 用户长期记忆路由：记忆文档、笔记、版本与合并。
// 普通用户只能访问自己的记忆；管理员可以查看和维护所有用户的记忆，用于运营与排障。
// 这里只做鉴权、范围收敛和审计，不包含任何业务口径。
import { MEMORY_KINDS, NOTE_SOURCES, NOTE_STATES } from '../../userMemory.js';

function requireUser(ctx) {
  const { request, database, getRequestUser } = ctx;
  const user = getRequestUser(request, database);
  if (!user) {
    throw Object.assign(new Error('authentication required'), { statusCode: 401 });
  }
  return user;
}

function userLabel(item) {
  return item?.displayName || item?.username || `#${item?.id}`;
}

function resolveScope({ database, user, requestedUserId = 0 }) {
  const isAdmin = user.role === 'ADMIN';
  if (!isAdmin) {
    return { isAdmin, userId: Number(user.id), scope: 'self' };
  }
  if (requestedUserId) {
    return { isAdmin, userId: Number(requestedUserId), scope: 'user' };
  }
  return { isAdmin, userId: null, scope: 'all' };
}

function buildUserOptions(database, store) {
  return database.listUsers().map((item) => {
    const stats = store.stats(item.id);
    return {
      id: item.id,
      name: userLabel(item),
      username: item.username,
      role: item.role,
      memoryCount: stats.notes + stats.documentsWithContent,
      pendingNotes: stats.pendingNotes,
    };
  });
}

function loadOwnedNote({ database, user, id }) {
  const row = database.db.prepare(
    'SELECT id, user_id AS userId FROM user_memory_notes WHERE id = ?',
  ).get(Number(id));
  return assertOwnership({ row, user, label: '笔记' });
}

function loadOwnedDocument({ database, user, id }) {
  const row = database.db.prepare(
    'SELECT id, user_id AS userId FROM user_memory_documents WHERE id = ?',
  ).get(Number(id));
  return assertOwnership({ row, user, label: '记忆文档' });
}

function assertOwnership({ row, user, label }) {
  if (!row) {
    throw Object.assign(new Error(`${label}不存在或无权访问`), { statusCode: 404 });
  }
  if (user.role !== 'ADMIN' && Number(row.userId) !== Number(user.id)) {
    throw Object.assign(new Error(`${label}不存在或无权访问`), { statusCode: 404 });
  }
  return row;
}

export function registerMemoryRoutes(table) {
  table.add({
    id: 'memories.list',
    method: 'GET',
    path: '/api/memories',
    tags: ['memory'],
    summary: '列出长期记忆文档与笔记（本人或管理员全部用户）',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { response, url, database, application, sendJson, parseIntParam } = ctx;
      const user = requireUser(ctx);
      const store = application.userMemories;
      const scope = resolveScope({
        database,
        user,
        requestedUserId: parseIntParam(url.searchParams.get('userId'), 0),
      });
      const themeId = parseIntParam(url.searchParams.get('themeId'), 0) || null;
      const limit = Math.max(1, Math.min(parseIntParam(url.searchParams.get('limit'), 200), 500));
      const noteFilter = {
        state: url.searchParams.get('state') ?? '',
        kind: url.searchParams.get('kind') ?? '',
        keyword: url.searchParams.get('q') ?? '',
        themeId,
        scopeKey: url.searchParams.get('scopeKey') ?? '',
        limit,
      };
      const targets = scope.userId
        ? [scope.userId]
        : database.listUsers().map((item) => Number(item.id));
      const labelOf = new Map(
        database.listUsers().map((item) => [Number(item.id), userLabel(item)]),
      );
      const decorate = (item) => ({ ...item, userName: labelOf.get(Number(item.userId)) ?? '-' });
      const documents = targets
        .flatMap((targetId) => store.listDocuments({ userId: targetId, themeId, limit })
          .map(decorate))
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))
          || right.id - left.id)
        .slice(0, limit);
      const notes = targets
        .flatMap((targetId) => store.listNotes({ userId: targetId, ...noteFilter })
          .map(decorate))
        .sort((left, right) => (left.state === 'PENDING' ? 0 : 1) - (right.state === 'PENDING' ? 0 : 1)
          || right.id - left.id)
        .slice(0, limit);
      sendJson(response, 200, {
        scope: scope.scope,
        documents,
        notes,
        kinds: MEMORY_KINDS,
        sources: Object.keys(NOTE_SOURCES).map((code) => ({ code, label: NOTE_SOURCES[code] })),
        states: Object.keys(NOTE_STATES).map((code) => ({ code, label: NOTE_STATES[code] })),
        users: scope.isAdmin ? buildUserOptions(database, store) : [],
        maintenance: {
          ...(application.memoryMaintenance?.stats?.() ?? { enabled: false, intervalMs: 0 }),
          compactRatio: application.userMemoryDistiller?.compactRatio ?? null,
          autoConsolidateAt: application.userMemoryDistiller?.autoConsolidateAt ?? null,
        },
        stats: scope.userId
          ? store.stats(scope.userId)
          : {
            documents: documents.length,
            documentsWithContent: documents.filter((item) => item.content.trim()).length,
            notes: notes.length,
            pendingNotes: notes.filter((item) => item.state === 'PENDING').length,
          },
      });
    },
  });

  table.add({
    id: 'memories.notes.create',
    method: 'POST',
    path: '/api/memories/notes',
    tags: ['memory'],
    summary: '追加一条长期记忆笔记',
    middleware: ['auth'],
    requestBody: true,
    handler: async (ctx) => {
      const { response, database, application, readJson, sendJson, parseIntParam } = ctx;
      const user = requireUser(ctx);
      const body = await readJson(ctx.request);
      const scope = resolveScope({
        database,
        user,
        requestedUserId: parseIntParam(body.userId, 0),
      });
      const note = application.userMemories.createNote({
        userId: scope.userId ?? user.id,
        themeId: parseIntParam(body.themeId, 0) || null,
        kind: body.kind,
        content: body.content,
        source: 'MANUAL',
      });
      if (!note) {
        throw Object.assign(new Error('笔记内容长度需在 4-400 字之间'), { statusCode: 400 });
      }
      database.addAuditLog({
        userId: user.id,
        themeId: note.themeId ?? null,
        action: 'USER_MEMORY_NOTE_CREATE',
        detail: {
          noteId: note.id,
          ownerUserId: note.userId,
          kind: note.kind,
          deduped: Boolean(note.deduped),
        },
      });
      sendJson(response, 200, note);
    },
  });

  table.add({
    id: 'memories.notes.update',
    method: 'PATCH',
    path: '/api/memories/notes/:id(\\d+)',
    tags: ['memory'],
    summary: '修改笔记内容、类型或归档状态',
    middleware: ['auth'],
    requestBody: true,
    handler: async (ctx) => {
      const { response, database, application, params, readJson, sendJson } = ctx;
      const user = requireUser(ctx);
      const note = loadOwnedNote({ database, user, id: params?.[0] });
      const body = await readJson(ctx.request);
      const updated = application.userMemories.updateNote(Number(note.id), {
        content: body.content,
        kind: body.kind,
        state: body.state,
      });
      if (!updated) {
        throw Object.assign(new Error('笔记内容长度需在 4-400 字之间'), { statusCode: 400 });
      }
      database.addAuditLog({
        userId: user.id,
        action: 'USER_MEMORY_NOTE_UPDATE',
        detail: {
          noteId: updated.id,
          ownerUserId: updated.userId,
          state: updated.state,
          byAdmin: Number(updated.userId) !== Number(user.id),
        },
      });
      sendJson(response, 200, updated);
    },
  });

  table.add({
    id: 'memories.notes.delete',
    method: 'DELETE',
    path: '/api/memories/notes/:id(\\d+)',
    tags: ['memory'],
    summary: '删除一条笔记',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { response, database, application, params, sendJson } = ctx;
      const user = requireUser(ctx);
      const note = loadOwnedNote({ database, user, id: params?.[0] });
      const deleted = application.userMemories.removeNote(Number(note.id));
      database.addAuditLog({
        userId: user.id,
        action: 'USER_MEMORY_NOTE_DELETE',
        detail: {
          noteId: Number(note.id),
          ownerUserId: note.userId,
          byAdmin: Number(note.userId) !== Number(user.id),
        },
      });
      sendJson(response, 200, { deleted, noteId: Number(note.id) });
    },
  });

  table.add({
    id: 'memories.document.update',
    method: 'PATCH',
    path: '/api/memories/documents/:id(\\d+)',
    tags: ['memory'],
    summary: '人工编辑记忆文档正文或暂停注入',
    middleware: ['auth'],
    requestBody: true,
    handler: async (ctx) => {
      const { response, database, application, params, readJson, sendJson } = ctx;
      const user = requireUser(ctx);
      const document = loadOwnedDocument({ database, user, id: params?.[0] });
      const body = await readJson(ctx.request);
      const updated = application.userMemories.updateDocument(Number(document.id), {
        summary: body.summary,
        content: body.content,
        status: body.status === undefined ? undefined : (body.status ? 1 : 0),
      });
      if (!updated) {
        throw Object.assign(new Error('记忆文档不存在'), { statusCode: 404 });
      }
      database.addAuditLog({
        userId: user.id,
        themeId: updated.themeId ?? null,
        action: 'USER_MEMORY_DOCUMENT_UPDATE',
        detail: {
          documentId: updated.id,
          ownerUserId: updated.userId,
          status: updated.status,
          version: updated.version,
          byAdmin: Number(updated.userId) !== Number(user.id),
        },
      });
      sendJson(response, 200, updated);
    },
  });

  table.add({
    id: 'memories.document.delete',
    method: 'DELETE',
    path: '/api/memories/documents/:id(\\d+)',
    tags: ['memory'],
    summary: '清空某个作用域下的记忆文档与笔记',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { response, database, application, params, sendJson } = ctx;
      const user = requireUser(ctx);
      const document = loadOwnedDocument({ database, user, id: params?.[0] });
      const deleted = application.userMemories.removeDocument(Number(document.id));
      database.addAuditLog({
        userId: user.id,
        action: 'USER_MEMORY_DOCUMENT_DELETE',
        detail: {
          documentId: Number(document.id),
          ownerUserId: document.userId,
          byAdmin: Number(document.userId) !== Number(user.id),
        },
      });
      sendJson(response, 200, { deleted, documentId: Number(document.id) });
    },
  });

  table.add({
    id: 'memories.versions',
    method: 'GET',
    path: '/api/memories/documents/:id(\\d+)/versions',
    tags: ['memory'],
    summary: '读取记忆文档的版本快照',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { response, database, application, params, url, sendJson, parseIntParam } = ctx;
      const user = requireUser(ctx);
      const document = loadOwnedDocument({ database, user, id: params?.[0] });
      const limit = Math.max(1, Math.min(parseIntParam(url.searchParams.get('limit'), 20), 100));
      sendJson(response, 200, {
        documentId: Number(document.id),
        versions: application.userMemories.listVersions(Number(document.id), limit),
      });
    },
  });

  table.add({
    id: 'memories.rollback',
    method: 'POST',
    path: '/api/memories/documents/:id(\\d+)/rollback',
    tags: ['memory'],
    summary: '回滚记忆文档到指定版本',
    middleware: ['auth'],
    requestBody: true,
    handler: async (ctx) => {
      const { response, database, application, params, readJson, sendJson, parseIntParam } = ctx;
      const user = requireUser(ctx);
      const document = loadOwnedDocument({ database, user, id: params?.[0] });
      const body = await readJson(ctx.request);
      const version = parseIntParam(body.version, 0);
      const rolled = version
        ? application.userMemories.rollback(Number(document.id), version)
        : null;
      if (!rolled) {
        throw Object.assign(new Error('指定版本不存在'), { statusCode: 404 });
      }
      database.addAuditLog({
        userId: user.id,
        themeId: rolled.themeId ?? null,
        action: 'USER_MEMORY_ROLLBACK',
        detail: {
          documentId: rolled.id,
          ownerUserId: rolled.userId,
          toVersion: version,
          newVersion: rolled.version,
          byAdmin: Number(rolled.userId) !== Number(user.id),
        },
      });
      sendJson(response, 200, rolled);
    },
  });

  table.add({
    id: 'memories.consolidate',
    method: 'POST',
    path: '/api/memories/consolidate',
    tags: ['memory'],
    summary: '把待合并笔记整理进记忆文档',
    middleware: ['auth'],
    requestBody: true,
    handler: async (ctx) => {
      const { response, database, application, readJson, sendJson, parseIntParam } = ctx;
      const user = requireUser(ctx);
      const body = await readJson(ctx.request);
      const scope = resolveScope({
        database,
        user,
        requestedUserId: parseIntParam(body.userId, 0),
      });
      const targetUserId = scope.userId ?? user.id;
      const themeId = body.themeId === undefined || body.themeId === null
        ? null
        : (parseIntParam(body.themeId, 0) || null);
      const result = await application.userMemoryDistiller.consolidate({
        userId: targetUserId,
        themeId,
        auto: Boolean(body.auto),
      });
      database.addAuditLog({
        userId: user.id,
        themeId: result.document?.themeId ?? null,
        action: 'USER_MEMORY_CONSOLIDATE',
        detail: {
          documentId: result.document?.id ?? null,
          ownerUserId: targetUserId,
          changed: result.changed,
          merged: result.merged,
          reason: result.reason,
          byAdmin: Number(targetUserId) !== Number(user.id),
        },
      });
      sendJson(response, 200, {
        changed: result.changed,
        reason: result.reason,
        merged: result.merged,
        document: result.document,
      });
    },
  });

  table.add({
    id: 'memories.maintain',
    method: 'POST',
    path: '/api/memories/maintain',
    tags: ['memory'],
    summary: '手动触发记忆整理：合并待合并笔记并压缩过长正文',
    middleware: ['auth'],
    requestBody: true,
    handler: async (ctx) => {
      const { response, database, application, readJson, sendJson, parseIntParam } = ctx;
      const user = requireUser(ctx);
      const body = await readJson(ctx.request);
      const scope = resolveScope({
        database,
        user,
        requestedUserId: parseIntParam(body.userId, 0),
      });
      const targetUserId = scope.userId ?? user.id;
      const themeId = body.themeId === undefined || body.themeId === null
        ? null
        : (parseIntParam(body.themeId, 0) || null);
      const result = await application.userMemoryDistiller.maintain({
        userId: targetUserId,
        themeId,
        auto: Boolean(body.auto),
      });
      database.addAuditLog({
        userId: user.id,
        themeId,
        action: 'USER_MEMORY_MAINTAIN',
        detail: {
          ownerUserId: targetUserId,
          documentId: result.compacted?.document?.id ?? result.consolidated?.document?.id ?? null,
          consolidated: result.consolidated?.reason ?? null,
          compacted: result.compacted?.reason ?? null,
          merged: result.consolidated?.merged ?? 0,
          before: result.compacted?.before ?? null,
          after: result.compacted?.after ?? null,
          byAdmin: Number(targetUserId) !== Number(user.id),
        },
      });
      sendJson(response, 200, {
        changed: result.changed,
        consolidated: result.consolidated,
        compacted: result.compacted,
      });
    },
  });

  table.add({
    id: 'memories.distill',
    method: 'POST',
    path: '/api/memories/distill',
    tags: ['memory'],
    summary: '从指定会话抽取长期记忆笔记',
    middleware: ['auth'],
    requestBody: true,
    handler: async (ctx) => {
      const { response, database, application, readJson, sendJson, parseIntParam } = ctx;
      const user = requireUser(ctx);
      const body = await readJson(ctx.request);
      const sessionId = parseIntParam(body.sessionId, 0);
      if (!sessionId) {
        throw Object.assign(new Error('需要提供会话 sessionId'), { statusCode: 400 });
      }
      const isAdmin = user.role === 'ADMIN';
      const session = database.getChatSession(sessionId, isAdmin ? null : user.id);
      if (!session) {
        throw Object.assign(new Error('会话不存在或无权访问'), { statusCode: 404 });
      }
      const messages = database.listChatMessages(session.id, session.userId, 200) ?? [];
      const userMessages = messages.filter((message) => message.role === 'user');
      const lastAssistant = [...messages].reverse()
        .find((message) => message.role === 'assistant')?.content ?? '';
      const notes = await application.userMemoryDistiller.distillConversation({
        userId: session.userId,
        themeId: session.themeId,
        sessionId: session.id,
        question: userMessages.map((message) => message.content).join('\n'),
        answer: lastAssistant,
        useModel: body.useModel !== false,
      });
      database.addAuditLog({
        userId: user.id,
        themeId: session.themeId ?? null,
        action: 'USER_MEMORY_DISTILL',
        detail: {
          sessionId: session.id,
          ownerUserId: session.userId,
          saved: notes.length,
          byAdmin: Number(session.userId) !== Number(user.id),
        },
      });
      sendJson(response, 200, { sessionId: session.id, notes, count: notes.length });
    },
  });
}
