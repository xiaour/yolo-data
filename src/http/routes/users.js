import { registerBootstrapRoute } from './bootstrap.js';
import {
  deleteUserSessionsAsync,
  setDefaultUserPasswordAsync,
  setUserPasswordAsync,
} from '../../auth.js';
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
      const user = await getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      sendJson(response, 200, await database.userRepository.listUsersAsync());
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
      const user = await getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      const saved = await database.userRepository.saveUserAsync(body);
      const password = String(body.password ?? '');
      if (password) {
        await setUserPasswordAsync(database, saved.id, password);
      } else {
        await setDefaultUserPasswordAsync(database, saved.id);
      }
      await database.addAuditLogAsync({
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
      const current = await getRequestUser(request, database);
      if (current.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      const saved = await database.userRepository.saveUserAsync(body, Number(userRoute[0]));
      if (Number(saved.status ?? 1) === 0) {
        await deleteUserSessionsAsync(database, saved.id);
      }
      await database.addAuditLogAsync({
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
      const current = await getRequestUser(request, database);
      const targetId = Number(params[0]);
      const target = await database.userRepository.getUserAsync(targetId);
      if (!target) {
        throw Object.assign(new Error('user not found'), { statusCode: 404 });
      }
      const body = await readJson(request);
      const password = String(body.password ?? '');
      if (password) {
        await setUserPasswordAsync(database, targetId, password);
      } else {
        await setDefaultUserPasswordAsync(database, targetId);
      }
      await deleteUserSessionsAsync(database, targetId);
      await database.addAuditLogAsync({
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
      const current = await getRequestUser(request, database);
      if (current.role !== 'ADMIN' && Number(permissionRoute[0]) !== current.id) {
        throw Object.assign(new Error('permission denied'), { statusCode: 403 });
      }
      sendJson(response, 200, await database.permissionRepository.getProfile(Number(permissionRoute[0])));
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
      const current = await getRequestUser(request, database);
      if (current.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      assertRowPoliciesSupported(body.rowPolicies);
      const profile = await database.permissionRepository.replaceProfile(Number(permissionSaveRoute[0]), body);
      await database.addAuditLogAsync({
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
      const { request, response, database, application, agent, getRequestUser, sendJson, toPublicTheme, toPublicModel } = ctx;
      const user = await getRequestUser(request, database);
      const canManage = user.role === 'ADMIN';
      const [themes, preferences, managedThemes, skills, datasetOptions, businessDatasets,
        dataSources, models, health, indicatorTypes] = await Promise.all([
        agent.getThemesForUserAsync(user.id),
        database.isAsyncPlatformStore
          ? database.getUserPreferencesAsync(user.id) : database.getUserPreferences(user.id),
        canManage
          ? (database.isAsyncPlatformStore ? database.listThemesAsync() : database.listThemes())
          : Promise.resolve([]),
        database.isAsyncPlatformStore ? database.listSkillsAsync() : Promise.resolve(database.listSkills()),
        database.isAsyncPlatformStore
          ? database.listDatasetOptionsAsync() : Promise.resolve(database.listDatasetOptions()),
        database.listBusinessDatasetsAsync(canManage ? { includeDisabled: true } : { userId: user.id }),
        user.role === 'ADMIN' ? database.dataSourceRepository.listDataSourcesAsync() : Promise.resolve([]),
        user.role === 'ADMIN' ? database.modelRepository.listModelsAsync() : Promise.resolve([]),
        application.currentHealth(),
        !canManage ? Promise.resolve([]) : database.localIndicators.listTypesAsync(),
      ]);
      sendJson(response, 200, {
        currentUser: user,
        preferences,
        themes: themes.map(toPublicTheme),
        managedThemes: managedThemes.map(toPublicTheme),
        skills,
        datasetOptions: datasetOptions.items,
        indicatorSource: application.resolveIndicatorSource(),
        businessDatasets,
        dataSources,
        models: models.map(toPublicModel),
        indicatorTypes,
        health,
        compute: health.compute,
      });
    },
  });
  registerBootstrapRoute(table);

  table.add({
    id: 'users.preferences.replace',
    method: 'PUT',
    path: '/api/preferences',
    tags: ['users'],
    summary: '保存当前用户界面偏好',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, getRequestUser, readJson, sendJson } = ctx;
      const user = await getRequestUser(request, database);
      const body = await readJson(request);
      const allowedKeys = new Set([
        'selectedThemeId',
        'selectedModelId',
        'chatDensity',
        'datasetTab',
        'auditTab',
      ]);
      const patch = {};
      for (const [key, value] of Object.entries(body ?? {})) {
        if (!allowedKeys.has(key)) {
          continue;
        }
        if (
          key === 'selectedThemeId'
          || key === 'selectedModelId'
        ) {
          const id = Number(value);
          patch[key] = Number.isFinite(id) && id > 0 ? id : null;
        } else if (value === null || value === undefined) {
          patch[key] = null;
        } else {
          patch[key] = String(value);
        }
      }
      const preferences = database.isAsyncPlatformStore
        ? await database.saveUserPreferencesAsync(user.id, patch)
        : database.saveUserPreferences(user.id, patch);
      sendJson(response, 200, { preferences });
    },
  });
}
