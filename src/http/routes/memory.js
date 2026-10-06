// 记忆管理：会话记忆（chat_sessions / chat_messages）的查看与清理。
// 普通用户只能访问自己的记忆；管理员可以查看全部用户，用于运营与排障。
// 这里只做鉴权、范围收敛和审计，不包含任何业务口径。
export function registerMemoryRoutes(table) {
  table.add({
    id: 'memories.list',
    method: 'GET',
    path: '/api/memories',
    tags: ['memory'],
    summary: '列出会话记忆（本人或管理员全部用户）',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, url, database, getRequestUser, sendJson, parseIntParam } = ctx;
      const user = getRequestUser(request, database);
      if (!user) {
        throw Object.assign(new Error('authentication required'), { statusCode: 401 });
      }
      const isAdmin = user.role === 'ADMIN';
      const limit = Math.max(1, Math.min(parseIntParam(url.searchParams.get('limit'), 100), 500));
      const requestedUserId = parseIntParam(url.searchParams.get('userId'), 0);
      const pool = isAdmin
        ? database.listUsers()
        : [database.getUser(user.id)].filter(Boolean);
      const targets = isAdmin && !requestedUserId
        ? pool
        : pool.filter((item) => Number(item.id) === Number(isAdmin ? requestedUserId : user.id));
      const nameOf = new Map(pool.map((item) => [
        Number(item.id),
        item.displayName || item.username || `#${item.id}`,
      ]));
      const items = targets
        .flatMap((target) => database.listChatSessions(target.id, limit)
          .map((session) => ({
            ...session,
            userName: nameOf.get(Number(session.userId)) ?? '-',
          })))
        .sort((left, right) => (
          String(right.updatedAt).localeCompare(String(left.updatedAt)) || right.id - left.id
        ))
        .slice(0, limit);
      sendJson(response, 200, {
        scope: isAdmin ? (requestedUserId ? 'user' : 'all') : 'self',
        items,
        users: isAdmin
          ? pool.map((item) => ({
            id: item.id,
            name: item.displayName || item.username || `#${item.id}`,
            username: item.username,
          }))
          : [],
      });
    },
  });

  table.add({
    id: 'memories.messages',
    method: 'GET',
    path: '/api/memories/:id(\\d+)/messages',
    tags: ['memory'],
    summary: '读取某条会话记忆的完整消息',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, params, getRequestUser, sendJson } = ctx;
      const user = getRequestUser(request, database);
      const session = resolveSession({ database, user, params });
      const messages = database.listChatMessages(session.id, session.userId, 200) ?? [];
      sendJson(response, 200, { session, messages });
    },
  });

  table.add({
    id: 'memories.delete',
    method: 'DELETE',
    path: '/api/memories/:id(\\d+)',
    tags: ['memory'],
    summary: '删除某条会话记忆（本人或管理员）',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, params, getRequestUser, sendJson } = ctx;
      const user = getRequestUser(request, database);
      const session = resolveSession({ database, user, params });
      const deleted = database.deleteChatSession(session.id, session.userId);
      database.addAuditLog({
        userId: user.id,
        themeId: session.themeId ?? null,
        action: 'MEMORY_DELETE',
        detail: {
          sessionId: session.id,
          ownerUserId: session.userId,
          title: session.title ?? '',
          byAdmin: Number(session.userId) !== Number(user.id),
        },
      });
      sendJson(response, 200, { deleted, sessionId: session.id });
    },
  });
}

// 管理员可访问全部记忆；其他用户只能访问属于自己的记忆。
function resolveSession({ database, user, params }) {
  const sessionId = Number(params?.[0]);
  const isAdmin = user?.role === 'ADMIN';
  const session = database.getChatSession(sessionId, isAdmin ? null : user?.id);
  if (!session) {
    throw Object.assign(new Error('会话记忆不存在或无权访问'), { statusCode: 404 });
  }
  return session;
}
