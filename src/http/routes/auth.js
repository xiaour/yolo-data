import {
  assertPasswordUsable,
  checkUserPassword,
  clearSessionCookie,
  createSession,
  deleteSession,
  deleteUserSessions,
  readSessionToken,
  resolveAuthMode,
  resolveSession,
  sessionCookie,
  setUserPassword,
} from '../../auth.js';

export function registerAuthRoutes(table) {
  table.add({
    id: 'auth.me',
    method: 'GET',
    path: '/api/auth/me',
    tags: ['auth'],
    summary: '读取当前登录用户',
    handler: async (ctx) => {
      const { request, response, database, config, sendJson } = ctx;
      const token = readSessionToken(request);
      const user = token ? resolveSession(database, token) : null;
      sendJson(response, 200, {
        authenticated: Boolean(user),
        user,
        authMode: resolveAuthMode(config),
        sessionTtlHours: Number(config.sessionTtlHours ?? 12),
      });
    },
  });

  table.add({
    id: 'auth.login',
    method: 'POST',
    path: '/api/auth/login',
    tags: ['auth'],
    summary: '账号密码登录',
    middleware: ['loginRateLimit'],
    handler: async (ctx) => {
      const { request, response, database, config, readJson, sendJson } = ctx;
      const body = await readJson(request);
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      if (!username || !password) {
        throw Object.assign(new Error('请输入用户名和密码'), { statusCode: 400 });
      }
      const user = database.getUserByUsername(username);
      if (!user || !checkUserPassword(database, user, password)) {
        throw Object.assign(new Error('用户名或密码不正确'), { statusCode: 401 });
      }
      if (Number(user.status ?? 1) === 0) {
        throw Object.assign(new Error('账号已停用，请联系管理员'), { statusCode: 403 });
      }
      const session = createSession(database, user.id, config.sessionTtlHours);
      response.setHeader('Set-Cookie', sessionCookie(session.token, {
        maxAgeSeconds: session.maxAgeSeconds,
        secure: Boolean(config.secureCookies),
      }));
      database.addAuditLog({
        userId: user.id,
        action: 'USER_LOGIN',
        detail: { username: user.username },
      });
      sendJson(response, 200, {
        user,
        expiresAt: session.expiresAt,
        authMode: resolveAuthMode(config),
      });
    },
  });

  table.add({
    id: 'auth.logout',
    method: 'POST',
    path: '/api/auth/logout',
    tags: ['auth'],
    summary: '退出登录',
    handler: async (ctx) => {
      const { request, response, database, config, sendJson } = ctx;
      const token = readSessionToken(request);
      const user = token ? resolveSession(database, token) : null;
      deleteSession(database, token);
      response.setHeader('Set-Cookie', clearSessionCookie({
        secure: Boolean(config.secureCookies),
      }));
      if (user) {
        database.addAuditLog({ userId: user.id, action: 'USER_LOGOUT', detail: {} });
      }
      sendJson(response, 200, { ok: true });
    },
  });

  table.add({
    id: 'auth.password',
    method: 'PUT',
    path: '/api/auth/password',
    tags: ['auth'],
    summary: '修改当前登录用户密码',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, readJson, sendJson, user } = ctx;
      const body = await readJson(request);
      const newPassword = assertPasswordUsable(body.newPassword);
      if (!checkUserPassword(database, user, body.currentPassword)) {
        throw Object.assign(new Error('当前密码不正确'), { statusCode: 400 });
      }
      setUserPassword(database, user.id, newPassword);
      deleteUserSessions(database, user.id, readSessionToken(request));
      database.addAuditLog({ userId: user.id, action: 'USER_PASSWORD_CHANGE', detail: {} });
      sendJson(response, 200, { ok: true });
    },
  });
}
