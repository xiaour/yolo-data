import { buildOpenApi } from '../openapi.js';

export function registerSystemRoutes(table) {
  table.add({
    id: 'system.health',
    method: 'GET',
    path: '/api/health',
    tags: ['system'],
    summary: '运行健康与指标来源状态',
    handler: async (ctx) => {
      const { response, application, sendJson } = ctx;
      sendJson(response, 200, application.currentHealth());
    },
  });

  table.add({
    id: 'system.settings.read',
    method: 'GET',
    path: '/api/settings',
    tags: ['system'],
    summary: '读取 Supersonic 设置（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, application, config, getRequestUser, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const health = application.currentHealth();
      sendJson(response, 200, {
        supersonic: {
          enabled: application.getSupersonicEnabled(),
          configured: Boolean(config.supersonic.baseUrl),
          baseUrl: config.supersonic.baseUrl || null,
          mode: health.source.mode,
          lastSyncAt: health.source.lastSyncAt,
          lastSyncCount: health.source.lastSyncCount,
          error: health.source.error,
        },
      });
    },
  });

  table.add({
    id: 'system.settings.supersonic',
    method: 'PUT',
    path: '/api/settings/supersonic',
    tags: ['system'],
    summary: '启停 Supersonic 指标源（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, application, getRequestUser, readJson, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      const enabled = body.enabled !== false;
      const result = await application.applySupersonicSetting(enabled);
      database.addAuditLog({
        userId: user.id,
        action: 'SUPERSONIC_SETTING_UPDATE',
        detail: { enabled },
      });
      sendJson(response, 200, {
        supersonic: {
          enabled,
          sourceMode: result.sourceMode,
          sync: result.sync ?? null,
          syncError: result.syncError ?? null,
        },
        health: application.currentHealth(),
      });
    },
  });

  table.add({
    id: 'system.metrics',
    method: 'GET',
    path: '/metrics',
    tags: ['system'],
    summary: 'Prometheus 指标（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { response, renderMetrics } = ctx;
      const body = renderMetrics();
      response.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      response.end(body);
    },
  });

  table.add({
    id: 'system.openapi',
    method: 'GET',
    path: '/api/openapi.json',
    tags: ['system'],
    summary: '由路由表生成的 OpenAPI 3.1 文档',
    handler: async (ctx) => {
      const { response, router, sendJson } = ctx;
      sendJson(response, 200, buildOpenApi(router.list(), {
        title: 'YOLO Data API',
        version: '0.1.0',
      }));
    },
  });

  table.add({
    id: 'system.traces.read',
    method: 'GET',
    path: '/api/traces/:traceId',
    tags: ['system'],
    summary: '按 traceId 还原完整证据链',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { response, database, params, getRequestUser, sendJson, request } = ctx;
      const traceRoute = params;
      const user = getRequestUser(request, database);
      const evidence = database.getTraceEvidence(traceRoute[0]);
      if (!evidence || evidence.counts.queryPlans + evidence.counts.audit
        + evidence.counts.llmCalls + evidence.counts.datasetQueries === 0) {
        throw Object.assign(new Error('trace not found'), { statusCode: 404 });
      }
      const rows = [
        ...evidence.queryPlans,
        ...evidence.audit,
        ...evidence.llmCalls,
        ...evidence.datasetQueries,
      ];
      const ownsTrace = rows.some(
        (row) => Number(row.userId) === Number(user.id),
      );
      if (user.role !== 'ADMIN' && !ownsTrace) {
        throw Object.assign(new Error('trace not found'), { statusCode: 404 });
      }
      if (user.role === 'ADMIN') {
        sendJson(response, 200, evidence);
        return;
      }
      // Business users never see contracts, SQL, prompts or token usage.
      sendJson(response, 200, {
        traceId: evidence.traceId,
        counts: evidence.counts,
        queryPlans: evidence.queryPlans.map((plan) => ({
          id: plan.id,
          themeId: plan.themeId,
          sessionId: plan.sessionId,
          sourceType: plan.sourceType,
          question: plan.question,
          status: plan.status,
          createdAt: plan.createdAt,
        })),
        audit: evidence.audit.map((row) => ({
          id: row.id,
          action: row.action,
          createdAt: row.createdAt,
        })),
        llmCalls: [],
        datasetQueries: [],
      });
    },
  });
}
