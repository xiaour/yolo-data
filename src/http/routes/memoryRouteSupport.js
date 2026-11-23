// 用户长期记忆路由的共享守卫与加载器：鉴权、管理范围收敛、
// 归属校验与用户选项装配。路由装配见 memory.js。

export async function requireUser(ctx) {
  const { request, database, getRequestUser } = ctx;
  const user = await getRequestUser(request, database);
  if (!user) {
    throw Object.assign(new Error('authentication required'), { statusCode: 401 });
  }
  return user;
}

export function userLabel(item) {
  return item?.displayName || item?.username || `#${item?.id}`;
}

export function resolveScope({ database, user, requestedUserId = 0 }) {
  const isAdmin = user.role === 'ADMIN';
  if (!isAdmin) {
    return { isAdmin, userId: Number(user.id), scope: 'self' };
  }
  if (requestedUserId) {
    return { isAdmin, userId: Number(requestedUserId), scope: 'user' };
  }
  return { isAdmin, userId: null, scope: 'all' };
}

export async function buildUserOptions(database, store) {
  const users = await database.userRepository.listUsersAsync();
  return (await Promise.all(users.map(async (item) => {
    const stats = await store.statsAsync(item.id);
    return {
      id: item.id,
      name: userLabel(item),
      username: item.username,
      role: item.role,
      memoryCount: stats.notes + stats.documentsWithContent,
      pendingNotes: stats.pendingNotes,
    };
  }))).filter(Boolean);
}

export async function loadOwnedNote({ database, user, id }) {
  const row = (await database.query(
    'SELECT id, user_id AS userId FROM user_memory_notes WHERE id = ?', [Number(id)],
  ))[0];
  return assertOwnership({ row, user, label: '笔记' });
}

export async function loadOwnedDocument({ database, user, id }) {
  const row = (await database.query(
    'SELECT id, user_id AS userId FROM user_memory_documents WHERE id = ?', [Number(id)],
  ))[0];
  return assertOwnership({ row, user, label: '记忆文档' });
}

export function assertOwnership({ row, user, label }) {
  if (!row) {
    throw Object.assign(new Error(`${label}不存在或无权访问`), { statusCode: 404 });
  }
  if (user.role !== 'ADMIN' && Number(row.userId) !== Number(user.id)) {
    throw Object.assign(new Error(`${label}不存在或无权访问`), { statusCode: 404 });
  }
  return row;
}
