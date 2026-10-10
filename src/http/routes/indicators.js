// Serves the persisted indicator snapshot (P0-1) when the live Supersonic
// catalog is unavailable, so the platform never hard-depends on Supersonic.
function sendSnapshotIndicators({
  response,
  database,
  application,
  keyword = '',
  typeId = '',
  limit = 500,
  sendJson,
  error = null,
}) {
  const snapshot = database.listIndicators({ keyword, typeId, limit });
  const payload = {
    items: snapshot.items,
    total: snapshot.items.length,
    source: application.resolveIndicatorSource(),
    offline: true,
    message: snapshot.source === 'UNAVAILABLE'
      ? '指标平台未接入，且本地无指标快照'
      : '指标平台未接入，已使用本地指标快照',
  };
  if (error) {
    payload.warning = {
      code: 'SUPERSONIC_REALTIME_CATALOG_FAILED',
      message: error.message,
    };
  }
  sendJson(response, 200, payload);
}

export function registerIndicatorRoutes(table) {
  table.add({
    id: 'indicators.types',
    method: 'GET',
    path: '/api/indicator-types',
    tags: ['indicators'],
    summary: '列出指标类型',
    handler: async (ctx) => {
      const {
        response,
        database,
        application,
        indicatorClient,
        sendJson,
        supersonicAvailable,
      } = ctx;
      const indicatorTypes = !application.getSupersonicEnabled()
        ? database.localIndicators.listTypes()
        : !supersonicAvailable()
          ? []
          : await indicatorClient.listTypes().catch(() => []);
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
      const { request, response, url, database, application, agent, indicatorClient, getRequestUser, sendJson, parseIntParam, supersonicAvailable } = ctx;
      const user = getRequestUser(request, database);
      const localMode = !application.getSupersonicEnabled();
      const keyword = url.searchParams.get('keyword') ?? '';
      const typeId = url.searchParams.get('typeId') ?? '';
      const limit = parseIntParam(url.searchParams.get('limit'), 500);
      if (localMode) {
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
            disabled: true,
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
        const items = database.localIndicators.list({ keyword, typeId, limit });
        sendJson(response, 200, {
          items,
          total: items.length,
          source: application.resolveIndicatorSource(),
          disabled: true,
          localMode: true,
        });
        return;
      }
      const themeId = parseIntParam(url.searchParams.get('themeId'), null);
      if (themeId) {
        const context = await agent.getIndicatorsForUser(
          user.id,
          themeId,
          {
            keyword,
            typeId,
            limit: parseIntParam(url.searchParams.get('limit'), 500),
          },
        );
        sendJson(response, 200, {
          items: context.indicators,
          total: context.total,
          source: application.resolveIndicatorSource(),
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
      // Supersonic is optional. Without it we serve the local snapshot (which
      // may be empty) instead of failing, so admin editors stay usable; live
      // read failures degrade the same way rather than blocking the request.
      if (!supersonicAvailable()) {
        sendSnapshotIndicators({ response, database, application, keyword, typeId, limit: parseIntParam(url.searchParams.get('limit'), 500), sendJson });
        return;
      }
      try {
        const page = await indicatorClient.listIndicators({
          keyword,
          typeId,
          current: 1,
          pageSize: parseIntParam(url.searchParams.get('limit'), 500),
        });
        const indicators = (page.list ?? []).map((item) => ({
          ...item,
          id: String(item.id ?? ''),
          metrics: item.metrics ?? [],
          dimensions: item.dimensions ?? [],
          models: item.models ?? [],
        }));
        sendJson(response, 200, {
          items: indicators,
          total: page.total,
          source: application.resolveIndicatorSource(),
        });
      } catch (error) {
        sendSnapshotIndicators({ response, database, application, keyword, typeId, limit: parseIntParam(url.searchParams.get('limit'), 500), sendJson, error });
      }
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
      const { request, response, url, database, application, agent, indicatorClient, params, getRequestUser, sendJson, parseIntParam, supersonicAvailable } = ctx;
      const indicatorDetailRoute = params;
      const user = getRequestUser(request, database);
      const localMode = !application.getSupersonicEnabled();
      const themeId = parseIntParam(url.searchParams.get('themeId'), null);
      const indicatorId = indicatorDetailRoute[0];
      if (localMode) {
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
        const localIndicator = database.localIndicators.get(indicatorId);
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
      if (themeId) {
        const context = await agent.getIndicatorsForUser(user.id, themeId);
        const indicator = context.indicators.find(
          (item) => String(item.id) === String(indicatorId),
        );
        if (!indicator) {
          throw Object.assign(new Error('indicator permission denied'), { statusCode: 403 });
        }
      } else if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('themeId is required'), { statusCode: 400 });
      }
      if (!supersonicAvailable()) {
        const cached = database.listIndicators({ limit: 2000 }).items.find(
          (item) => String(item.id) === String(indicatorId),
        );
        if (!cached) {
          throw Object.assign(new Error('indicator not found'), { statusCode: 404 });
        }
        const cachedColumns = (cached.metrics ?? []).map((metric2) => ({
          name: metric2.metricName,
          bizName: metric2.metricBizName,
          showType: 'NUMBER',
          type: 'DECIMAL',
        }));
        sendJson(response, 200, {
          indicator: cached,
          columns: cachedColumns,
          dimensions: cached.dimensions ?? [],
          source: application.resolveIndicatorSource(),
          offline: true,
        });
        return;
      }
      const remote = await indicatorClient.getIndicator(indicatorId);
      const detail = remote?.indicator ? remote : { indicator: remote };
      const columns = (remote?.metrics ?? []).map((metric2) => ({
        name: metric2.metricName,
        bizName: metric2.metricBizName,
        showType: 'NUMBER',
        type: 'DECIMAL',
      }));
      const dimensions = remote?.dimensions ?? [];
      sendJson(response, 200, {
        ...detail,
        columns,
        dimensions,
      });
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
      const { request, response, database, application, getRequestUser, sendJson, supersonicAvailable } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      if (!application.getSupersonicEnabled()) {
        const localCount = database.localIndicators.count();
        database.addAuditLog({
          userId: user.id,
          action: 'INDICATOR_LOCAL_MODE_CONFIRMED',
          detail: { localCount },
        });
        sendJson(response, 200, {
          localMode: true,
          localCount,
          persisted: false,
          message: '本地指标管理已启用',
          source: application.resolveIndicatorSource(),
          health: application.currentHealth(),
        });
        return;
      }
      // Enabled but not configured: skip instead of failing. Supersonic is an
      // optional dependency, and any existing local snapshot stays usable.
      if (application.getSupersonicEnabled() && !supersonicAvailable()) {
        const source = application.resolveIndicatorSource();
        database.addAuditLog({
          userId: user.id,
          action: 'INDICATOR_CONNECT',
          detail: { skipped: true, reason: 'SUPERSONIC_NOT_CONFIGURED', snapshot: source },
        });
        sendJson(response, 200, {
          skipped: true,
          reason: 'SUPERSONIC_NOT_CONFIGURED',
          types: 0,
          indicators: 0,
          persisted: false,
          message: '指标平台未接入，已跳过同步；已有的本地指标快照仍然可用',
          source,
          health: application.currentHealth(),
        });
        return;
      }
      const result = await application.syncIndicators({ persist: true });
      database.addAuditLog({
        userId: user.id,
        action: 'INDICATOR_CONNECT',
        detail: {
          ...result,
          snapshot: application.resolveIndicatorSource(),
        },
      });
      sendJson(response, 200, { ...result, health: application.currentHealth() });
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
      const { request, response, database, application, getRequestUser, readJson, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      if (application.getSupersonicEnabled()) {
        throw Object.assign(
          new Error('在线指标集成已启用，当前不能新增本地指标'),
          { statusCode: 409 },
        );
      }
      const body = await readJson(request);
      const indicator = database.localIndicators.save(body);
      database.addAuditLog({
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
      const { request, response, database, application, params, getRequestUser, readJson, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      if (application.getSupersonicEnabled()) {
        throw Object.assign(
          new Error('在线指标集成已启用，当前不能编辑本地指标'),
          { statusCode: 409 },
        );
      }
      const indicatorId = decodeURIComponent(String(params[0]));
      if (!database.localIndicators.get(indicatorId)) {
        throw Object.assign(new Error('local indicator not found'), { statusCode: 404 });
      }
      const body = await readJson(request);
      const indicator = database.localIndicators.save(body, indicatorId);
      database.addAuditLog({
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
      const { request, response, database, application, params, getRequestUser, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      if (application.getSupersonicEnabled()) {
        throw Object.assign(
          new Error('在线指标集成已启用，当前不能删除本地指标'),
          { statusCode: 409 },
        );
      }
      const indicatorId = decodeURIComponent(String(params[0]));
      if (!database.localIndicators.delete(indicatorId)) {
        throw Object.assign(new Error('local indicator not found'), { statusCode: 404 });
      }
      database.addAuditLog({
        userId: user.id,
        action: 'INDICATOR_LOCAL_DELETE',
        detail: { indicatorId },
      });
      sendJson(response, 200, { ok: true, id: indicatorId });
    },
  });
}
