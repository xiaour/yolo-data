import { registerModelConnectionRoute } from './modelConnection.js';

export function registerModelRoutes(table) {
  table.add({
    id: 'models.list',
    method: 'GET',
    path: '/api/models',
    tags: ['models'],
    summary: '列出模型（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, getRequestUser, sendJson, toPublicModel } = ctx;
      const user = await getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      sendJson(response, 200, (await database.modelRepository.listModelsAsync()).map(toPublicModel));
    },
  });

  registerModelConnectionRoute(table);

  table.add({
    id: 'models.create',
    method: 'POST',
    path: '/api/models',
    tags: ['models'],
    summary: '创建模型（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, application, getRequestUser, readJson, sendJson, toPublicModel, prepareModelPayload } = ctx;
      const user = await getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      const model = await database.modelRepository.saveModelAsync(
        prepareModelPayload(body, null, application.datasourceCrypto),
      );
      await database.addAuditLogAsync({
        userId: user.id,
        action: 'MODEL_CREATE',
        detail: { modelId: model.id, name: model.name, modelName: model.modelName },
      });
      sendJson(response, 200, toPublicModel(model));
    },
  });

  table.add({
    id: 'models.update',
    method: 'PUT',
    path: '/api/models/:id(\\d+)',
    tags: ['models'],
    summary: '更新模型（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, application, params, getRequestUser, readJson, sendJson, toPublicModel, prepareModelPayload } = ctx;
      const modelRoute = params;
      const user = await getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const existing = await database.modelRepository.getModelAsync(Number(modelRoute[0]));
      if (!existing) {
        throw Object.assign(new Error('model not found'), { statusCode: 404 });
      }
      const body = await readJson(request);
      const model = await database.modelRepository.saveModelAsync(
        prepareModelPayload(body, existing, application.datasourceCrypto),
        Number(modelRoute[0]),
      );
      await database.addAuditLogAsync({
        userId: user.id,
        action: 'MODEL_UPDATE',
        detail: { modelId: model.id, name: model.name, modelName: model.modelName },
      });
      sendJson(response, 200, toPublicModel(model));
    },
  });

  table.add({
    id: 'models.setDefault',
    method: 'PUT',
    path: '/api/models/:id(\\d+)/default',
    tags: ['models'],
    summary: '设为默认模型（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, params, getRequestUser, sendJson, toPublicModel } = ctx;
      const modelDefaultRoute = params;
      const user = await getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const model = await database.modelRepository.setModelDefaultAsync(Number(modelDefaultRoute[0]));
      if (!model) {
        throw Object.assign(new Error('model not found'), { statusCode: 404 });
      }
      await database.addAuditLogAsync({
        userId: user.id,
        action: 'MODEL_DEFAULT_UPDATE',
        detail: { modelId: model.id, name: model.name },
      });
      sendJson(response, 200, toPublicModel(model));
    },
  });

  table.add({
    id: 'models.delete',
    method: 'DELETE',
    path: '/api/models/:id(\\d+)',
    tags: ['models'],
    summary: '删除模型（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, params, getRequestUser, sendJson } = ctx;
      const modelDeleteRoute = params;
      const user = await getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const deleted = await database.modelRepository.deleteModelAsync(Number(modelDeleteRoute[0]));
      await database.addAuditLogAsync({
        userId: user.id,
        action: 'MODEL_DELETE',
        detail: { modelId: Number(modelDeleteRoute[0]), deleted },
      });
      sendJson(response, 200, { deleted });
    },
  });
}
