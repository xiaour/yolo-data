export function registerDatasetRoutes(table) {
  table.add({
    id: 'dataSources.list',
    method: 'GET',
    path: '/api/data-sources',
    tags: ['datasets'],
    summary: '列出数据源（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, application, getRequestUser, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      sendJson(response, 200, application.businessDatasets.listDataSources());
    },
  });

  table.add({
    id: 'dataSources.create',
    method: 'POST',
    path: '/api/data-sources',
    tags: ['datasets'],
    summary: '创建数据源（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, application, getRequestUser, readJson, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      const source = application.businessDatasets.saveDataSource(body);
      database.addAuditLog({
        userId: user.id,
        action: 'DATASOURCE_CREATE',
        detail: {
          datasourceId: source.id,
          code: source.code,
          host: source.host,
          databaseName: source.databaseName,
        },
      });
      sendJson(response, 200, source);
    },
  });

  table.add({
    id: 'dataSources.test',
    method: 'POST',
    path: '/api/data-sources/:id(\\d+)/test',
    tags: ['datasets'],
    summary: '测试数据源连接（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, application, params, getRequestUser, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const source = await application.businessDatasets.testDataSource(Number(params[0]));
      sendJson(response, 200, source);
    },
  });

  for (const action of ['databases', 'tables', 'columns']) {
    table.add({
      id: `dataSources.${action}`,
      method: 'GET',
      path: `/api/data-sources/:id(\\d+)/${action}`,
      tags: ['datasets'],
      summary: `读取数据源 ${action}（管理员）`,
      middleware: ['auth', 'admin'],
      adminOnly: true,
      handler: async (ctx) => {
        const { request, response, url, database, application, params, getRequestUser, sendJson } = ctx;
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const id = Number(params[0]);
        if (action === 'databases') {
          sendJson(response, 200, await application.businessDatasets.listDatabases(id));
        } else if (action === 'tables') {
          sendJson(response, 200, await application.businessDatasets.listTables(
            id,
            url.searchParams.get('schema'),
          ));
        } else {
          sendJson(response, 200, await application.businessDatasets.listColumns(
            id,
            url.searchParams.get('schema'),
            url.searchParams.get('table'),
          ));
        }
      },
    });
  }

  table.add({
    id: 'businessDatasets.list',
    method: 'GET',
    path: '/api/business-datasets',
    tags: ['datasets'],
    summary: '列出业务数据集',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, application, getRequestUser, sendJson } = ctx;
      const user = getRequestUser(request, database);
      sendJson(response, 200, application.businessDatasets.listDatasets({
        userId: user.role === 'ADMIN' ? null : user.id,
        includeDisabled: user.role === 'ADMIN',
      }));
    },
  });

  table.add({
    id: 'businessDatasets.create',
    method: 'POST',
    path: '/api/business-datasets',
    tags: ['datasets'],
    summary: '创建业务数据集（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, application, getRequestUser, readJson, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      const dataset = await application.businessDatasets.createDataset(body);
      database.addAuditLog({
        userId: user.id,
        action: 'DATASET_CREATE',
        detail: {
          datasetId: dataset.id,
          code: dataset.code,
          schemaName: dataset.schemaName,
          primaryTable: dataset.primaryTable,
        },
      });
      sendJson(response, 200, dataset);
    },
  });

  table.add({
    id: 'businessDatasets.sync',
    method: 'POST',
    path: '/api/business-datasets/:id(\\d+)/sync',
    tags: ['datasets'],
    summary: '同步数据集字段（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, application, params, getRequestUser, sendJson } = ctx;
      const datasetActionRoute = params;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const fields = await application.businessDatasets.syncDatasetFields(
        Number(datasetActionRoute[0]),
      );
      database.addAuditLog({
        userId: user.id,
        action: 'DATASET_SYNC',
        detail: { datasetId: Number(datasetActionRoute[0]), fieldCount: fields.length },
      });
      sendJson(response, 200, { fields });
    },
  });

  table.add({
    id: 'businessDatasets.fields',
    method: 'GET',
    path: '/api/business-datasets/:id(\\d+)/fields',
    tags: ['datasets'],
    summary: '读取数据集字段（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, application, params, getRequestUser, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      sendJson(response, 200, application.businessDatasets.getDatasetFields(Number(params[0])));
    },
  });

  table.add({
    id: 'businessDatasets.fields.setEnabled',
    method: 'PUT',
    path: '/api/business-datasets/:id(\\d+)/fields/:fieldName',
    tags: ['datasets'],
    summary: '启用/禁用数据集字段（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const {
        request, response, database, application, params, getRequestUser, readJson, sendJson,
      } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const datasetId = Number(params[0]);
      const fieldName = String(params[1] ?? '');
      const body = await readJson(request);
      if (typeof body.enabled !== 'boolean') {
        throw Object.assign(new Error('enabled must be a boolean'), { statusCode: 400 });
      }
      const result = application.businessDatasets.setFieldEnabled(
        datasetId,
        fieldName,
        body.enabled,
      );
      database.addAuditLog({
        userId: user.id,
        action: 'DATASET_FIELD_TOGGLE',
        detail: {
          datasetId,
          fieldName,
          enabled: body.enabled,
          enabledFieldCount: result.summary.enabled,
        },
      });
      sendJson(response, 200, result);
    },
  });

  table.add({
    id: 'businessDatasets.sample',
    method: 'GET',
    path: '/api/business-datasets/:id(\\d+)/sample',
    tags: ['datasets'],
    summary: '采样数据集（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, url, database, application, params, getRequestUser, sendJson, parseIntParam } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      sendJson(response, 200, await application.businessDatasets.sampleDataset(
        Number(params[0]),
        parseIntParam(url.searchParams.get('limit'), 20),
      ));
    },
  });

  table.add({
    id: 'businessDatasets.profile.analyze',
    method: 'POST',
    path: '/api/business-datasets/:id(\\d+)/profile',
    tags: ['datasets'],
    summary: '智能识别数据集字段口径与默认时间条件（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, application, params, getRequestUser, readJson, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const datasetId = Number(params[0]);
      const body = await readJson(request);
      const profile = await application.businessDatasets.profileDataset(datasetId, {
        sampleSize: body.sampleSize,
      });
      database.addAuditLog({
        userId: user.id,
        action: 'DATASET_PROFILE_ANALYZE',
        detail: {
          datasetId,
          sampleSize: profile.sampleSize,
          changedCount: profile.summary.changedCount,
        },
      });
      sendJson(response, 200, profile);
    },
  });

  table.add({
    id: 'businessDatasets.profile.apply',
    method: 'PUT',
    path: '/api/business-datasets/:id(\\d+)/profile',
    tags: ['datasets'],
    summary: '应用智能识别结果（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, application, params, getRequestUser, readJson, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const datasetId = Number(params[0]);
      const body = await readJson(request);
      const result = application.businessDatasets.applyDatasetProfile(datasetId, {
        fields: Array.isArray(body.fields) ? body.fields : [],
        config: body.config ?? null,
      });
      database.addAuditLog({
        userId: user.id,
        action: 'DATASET_PROFILE_APPLY',
        detail: {
          datasetId,
          fieldCount: result.applied.fieldCount,
          config: result.applied.config,
        },
      });
      sendJson(response, 200, result);
    },
  });

  table.add({
    id: 'datasetQueryLogs.list',
    method: 'GET',
    path: '/api/dataset-query-logs',
    tags: ['datasets'],
    summary: '列出数据集查询日志（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, url, database, getRequestUser, sendJson, parseIntParam } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      sendJson(response, 200, database.listDatasetQueryLogs(
        parseIntParam(url.searchParams.get('limit'), 100),
      ));
    },
  });
}
