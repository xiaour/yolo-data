import { deleteUserSessions, setDefaultUserPassword, setUserPassword } from '../../auth.js';
import { assertRowPoliciesSupported } from '../../permissions.js';

export function registerUserRoutes(table) {
  table.add({
    id: 'users.list',
    method: 'GET',
    path: '/api/users',
    tags: ['users'],
    summary: '列出用户（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, getRequestUser, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      sendJson(response, 200, database.listUsers());
    },
  });

  table.add({
    id: 'users.create',
    method: 'POST',
    path: '/api/users',
    tags: ['users'],
    summary: '创建用户（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, getRequestUser, readJson, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      const saved = database.saveUser(body);
      const password = String(body.password ?? '');
      if (password) {
        setUserPassword(database, saved.id, password);
      } else {
        setDefaultUserPassword(database, saved.id);
      }
      database.addAuditLog({
        userId: user.id,
        action: 'USER_CREATE',
        detail: { targetUserId: saved.id, username: saved.username },
      });
      sendJson(response, 200, saved);
    },
  });

  table.add({
    id: 'users.update',
    method: 'PUT',
    path: '/api/users/:id(\\d+)',
    tags: ['users'],
    summary: '更新用户（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, params, getRequestUser, readJson, sendJson } = ctx;
      const userRoute = params;
      const current = getRequestUser(request, database);
      if (current.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      const saved = database.saveUser(body, Number(userRoute[0]));
      if (Number(saved.status ?? 1) === 0) {
        deleteUserSessions(database, saved.id);
      }
      database.addAuditLog({
        userId: current.id,
        action: 'USER_UPDATE',
        detail: { targetUserId: saved.id, username: saved.username },
      });
      sendJson(response, 200, saved);
    },
  });

  table.add({
    id: 'users.resetPassword',
    method: 'PUT',
    path: '/api/users/:id(\\d+)/password',
    tags: ['users'],
    summary: '重置用户密码（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, params, getRequestUser, readJson, sendJson } = ctx;
      const current = getRequestUser(request, database);
      const targetId = Number(params[0]);
      const target = database.getUser(targetId);
      if (!target) {
        throw Object.assign(new Error('user not found'), { statusCode: 404 });
      }
      const body = await readJson(request);
      const password = String(body.password ?? '');
      if (password) {
        setUserPassword(database, targetId, password);
      } else {
        setDefaultUserPassword(database, targetId);
      }
      deleteUserSessions(database, targetId);
      database.addAuditLog({
        userId: current.id,
        action: 'USER_PASSWORD_RESET',
        detail: { targetUserId: targetId, usedDefault: !password },
      });
      sendJson(response, 200, { ok: true, targetUserId: targetId, usedDefault: !password });
    },
  });

  table.add({
    id: 'users.permissions.read',
    method: 'GET',
    path: '/api/users/:id(\\d+)/permissions',
    tags: ['users'],
    summary: '读取用户权限档案',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, params, getRequestUser, sendJson } = ctx;
      const permissionRoute = params;
      const current = getRequestUser(request, database);
      if (current.role !== 'ADMIN' && Number(permissionRoute[0]) !== current.id) {
        throw Object.assign(new Error('permission denied'), { statusCode: 403 });
      }
      sendJson(response, 200, database.getPermissionProfile(Number(permissionRoute[0])));
    },
  });

  table.add({
    id: 'users.permissions.replace',
    method: 'PUT',
    path: '/api/users/:id(\\d+)/permissions',
    tags: ['users'],
    summary: '替换用户权限档案（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, params, getRequestUser, readJson, sendJson } = ctx;
      const permissionSaveRoute = params;
      const current = getRequestUser(request, database);
      if (current.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      assertRowPoliciesSupported(body.rowPolicies);
      const profile = database.replacePermissionProfile(Number(permissionSaveRoute[0]), body);
      database.addAuditLog({
        userId: current.id,
        action: 'PERMISSION_UPDATE',
        detail: {
          targetUserId: Number(permissionSaveRoute[0]),
          themeGrants: profile.themeGrants.length,
          indicatorGrants: profile.indicatorGrants.length,
          rowPolicies: profile.rowPolicies.length,
          columnPolicies: profile.columnPolicies.length,
        },
      });
      sendJson(response, 200, profile);
    },
  });

  table.add({
    id: 'users.bootstrap',
    method: 'GET',
    path: '/api/bootstrap',
    tags: ['users'],
    summary: '前端启动所需的全量上下文',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, application, agent, indicatorClient, getRequestUser, sendJson, toPublicTheme, toPublicModel, supersonicAvailable } = ctx;
      const user = getRequestUser(request, database);
      const themes = agent.getThemesForUser(user.id);
      const canManage = user.role === 'ADMIN';
      const indicatorTypes = !canManage || !supersonicAvailable()
        ? []
        : await indicatorClient.listTypes().catch(() => []);
      sendJson(response, 200, {
        currentUser: user,
        users: canManage ? database.listUsers() : [user],
        themes: themes.map(toPublicTheme),
        managedThemes: canManage ? database.listThemes().map(toPublicTheme) : [],
        skills: database.listSkills(),
        datasetOptions: database.listDatasetOptions().items,
        indicatorSource: application.resolveIndicatorSource(),
        businessDatasets: canManage
          ? database.listBusinessDatasets({ includeDisabled: true })
          : database.listBusinessDatasets({ userId: user.id }),
        dataSources: user.role === 'ADMIN' ? database.listDataSources() : [],
        models: user.role === 'ADMIN' ? database.listModels().map(toPublicModel) : [],
        indicatorTypes,
        health: application.currentHealth(),
      });
    },
  });
}
