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
      ? 'Supersonic 指标系统未接入，且本地无指标快照'
      : 'Supersonic 指标系统未接入，已使用本地指标快照',
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
      const { response, indicatorClient, sendJson, supersonicAvailable } = ctx;
      const indicatorTypes = !supersonicAvailable()
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
      if (!application.getSupersonicEnabled()) {
        sendJson(response, 200, {
          items: [],
          total: 0,
          disabled: true,
          source: application.resolveIndicatorSource(),
          message: 'Supersonic 指标模块已停用',
        });
        return;
      }
      const themeId = parseIntParam(url.searchParams.get('themeId'), null);
      const keyword = url.searchParams.get('keyword') ?? '';
      const typeId = url.searchParams.get('typeId') ?? '';
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
      if (!application.getSupersonicEnabled()) {
        throw Object.assign(
          new Error('Supersonic 指标模块已停用'),
          { statusCode: 404 },
        );
      }
      const themeId = parseIntParam(url.searchParams.get('themeId'), null);
      const indicatorId = indicatorDetailRoute[0];
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
          message: 'Supersonic 指标系统未接入，已跳过同步；已有的本地指标快照仍然可用',
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
}
