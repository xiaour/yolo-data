export function registerIndicatorRoutes(table) {
  table.add({
    id: 'indicators.themes.replace',
    method: 'PUT',
    path: '/api/indicators/:indicatorId/themes',
    tags: ['indicators'],
    summary: '更新指标与主题的挂载关系（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, params, getRequestUser, readJson, sendJson } = ctx;
      const user = await getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      const relations = await database.themeRepository.replaceIndicatorThemesAsync(params[0], body.themeIds ?? []);
      await database.addAuditLogAsync({
        userId: user.id,
        action: 'INDICATOR_THEME_RELATIONS_UPDATE',
        detail: { indicatorId: String(params[0]), themeIds: relations.map((item) => item.themeId) },
      });
      sendJson(response, 200, {
        indicatorId: String(params[0]),
        themeIds: relations.map((item) => item.themeId),
      });
    },
  });

  table.add({
    id: 'indicators.types',
    method: 'GET',
    path: '/api/indicator-types',
    tags: ['indicators'],
    summary: '列出指标类型',
    handler: async (ctx) => {
      const { response, database, sendJson } = ctx;
      const indicatorTypes = await database.localIndicators.listTypesAsync();
      sendJson(response, 200, indicatorTypes);
    },
  });

  table.add({
    id: 'indicators.list',
    method: 'GET',
    path: '/api/indicators',
    tags: ['indicators'],
    summary: '按授权范围列出指标',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, url, database, application, agent, getRequestUser, sendJson, parseIntParam } = ctx;
      const user = await getRequestUser(request, database);
      const keyword = url.searchParams.get('keyword') ?? '';
      const typeId = url.searchParams.get('typeId') ?? '';
      const limit = parseIntParam(url.searchParams.get('limit'), 500);
      {
        const themeId = parseIntParam(url.searchParams.get('themeId'), null);
        if (themeId) {
          const context = await agent.getIndicatorsForUser(
            user.id,
            themeId,
            { keyword, typeId, limit },
          );
          sendJson(response, 200, {
            items: context.indicators,
            total: context.total,
            source: application.resolveIndicatorSource(),
            localMode: true,
            scope: {
              allowedIndicatorCount: context.scope.allowedIndicatorIds.length,
              rowPolicyCount: context.scope.rowPolicies.length,
              canManage: context.scope.canManage,
            },
          });
          return;
        }
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('themeId is required'), { statusCode: 400 });
        }
        const items = await database.localIndicators.listAsync({ keyword, typeId, limit });
        sendJson(response, 200, {
          items,
          total: items.length,
          source: application.resolveIndicatorSource(),
          localMode: true,
        });
        return;
      }
      throw Object.assign(new Error('themeId is required'), { statusCode: 400 });
    },
  });

  table.add({
    id: 'indicators.detail',
    method: 'GET',
    path: '/api/indicators/:indicatorId/detail',
    tags: ['indicators'],
    summary: '读取指标详情',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, url, database, application, agent, params, getRequestUser, sendJson, parseIntParam } = ctx;
      const indicatorDetailRoute = params;
      const user = await getRequestUser(request, database);
      const themeId = parseIntParam(url.searchParams.get('themeId'), null);
      const indicatorId = indicatorDetailRoute[0];
      {
        if (themeId) {
          const context = await agent.getIndicatorsForUser(user.id, themeId);
          const indicator = context.indicators.find(
            (item) => String(item.id) === String(indicatorId),
          );
          if (!indicator) {
            throw Object.assign(new Error('indicator permission denied'), { statusCode: 403 });
          }
          sendJson(response, 200, {
            indicator,
            metrics: indicator.metrics ?? [],
            dimensions: indicator.dimensions ?? [],
            source: application.resolveIndicatorSource(),
            localMode: true,
          });
          return;
        }
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('themeId is required'), { statusCode: 400 });
        }
        const localIndicator = await database.localIndicators.getAsync(indicatorId);
        if (!localIndicator) {
          throw Object.assign(new Error('indicator not found'), { statusCode: 404 });
        }
        sendJson(response, 200, {
          indicator: localIndicator,
          metrics: localIndicator.metrics ?? [],
          dimensions: localIndicator.dimensions ?? [],
          source: application.resolveIndicatorSource(),
          localMode: true,
        });
        return;
      }
      throw Object.assign(new Error('indicator not found'), { statusCode: 404 });
    },
  });

  table.add({
    id: 'indicators.sync',
    method: 'POST',
    path: '/api/indicators/sync',
    tags: ['indicators'],
    summary: '显式同步并持久化指标快照（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, getRequestUser, sendJson } = ctx;
      const user = await getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const localCount = await database.localIndicators.countAsync();
      await database.addAuditLogAsync({
        userId: user.id,
        action: 'INDICATOR_LOCAL_MODE_CONFIRMED',
        detail: { localCount },
      });
      sendJson(response, 200, { localMode: true, localCount, persisted: false, message: '本地指标管理已启用' });
    },
  });

  table.add({
    id: 'localIndicators.listForThemeEditor',
    method: 'GET',
    path: '/api/local-indicators',
    tags: ['indicators'],
    summary: '列出本地指标供智能体配置（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, getRequestUser, url, sendJson } = ctx;
      const user = await getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const keyword = url.searchParams.get('keyword') ?? '';
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 500, 2000));
      const items = await database.localIndicators.listAsync({ keyword, limit, enabledOnly: true });
      sendJson(response, 200, { items, total: items.length, source: 'LOCAL' });
    },
  });

  table.add({
    id: 'localIndicators.create',
    method: 'POST',
    path: '/api/local-indicators',
    tags: ['indicators'],
    summary: '新增本地指标（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, getRequestUser, readJson, sendJson } = ctx;
      const user = await getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      const indicator = await database.localIndicators.save(body);
      await database.addAuditLogAsync({
        userId: user.id,
        action: 'INDICATOR_LOCAL_CREATE',
        detail: { indicatorId: indicator.id, name: indicator.name },
      });
      sendJson(response, 200, indicator);
    },
  });

  table.add({
    id: 'localIndicators.update',
    method: 'PUT',
    path: '/api/local-indicators/:indicatorId(.*)',
    tags: ['indicators'],
    summary: '更新本地指标（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, params, getRequestUser, readJson, sendJson } = ctx;
      const user = await getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const indicatorId = decodeURIComponent(String(params[0]));
      if (!await database.localIndicators.getAsync(indicatorId)) {
        throw Object.assign(new Error('local indicator not found'), { statusCode: 404 });
      }
      const body = await readJson(request);
      const indicator = await database.localIndicators.save(body, indicatorId);
      await database.addAuditLogAsync({
        userId: user.id,
        action: 'INDICATOR_LOCAL_UPDATE',
        detail: { indicatorId, name: indicator.name },
      });
      sendJson(response, 200, indicator);
    },
  });

  table.add({
    id: 'localIndicators.delete',
    method: 'DELETE',
    path: '/api/local-indicators/:indicatorId(.*)',
    tags: ['indicators'],
    summary: '删除本地指标（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, params, getRequestUser, sendJson } = ctx;
      const user = await getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const indicatorId = decodeURIComponent(String(params[0]));
      if (!await database.localIndicators.deleteAsync(indicatorId)) {
        throw Object.assign(new Error('local indicator not found'), { statusCode: 404 });
      }
      await database.addAuditLogAsync({
        userId: user.id,
        action: 'INDICATOR_LOCAL_DELETE',
        detail: { indicatorId },
      });
      sendJson(response, 200, { ok: true, id: indicatorId });
    },
  });
}
