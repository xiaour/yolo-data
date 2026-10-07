import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from './application.js';
import { probePythonRuntime } from './codeExecution.js';
import { createTraceId, currentTraceId, normalizeTraceId, runWithTrace } from './trace.js';
import { renderMetrics } from './metrics.js';
import { createRouteTable, runRoute } from './http/router.js';
import { createMiddlewareRegistry } from './http/middleware.js';
import {
  getRequestUser,
  parseIntParam,
  prepareModelPayload,
  prepareThemePayload,
  readJson,
  sendError,
  sendJson,
  serveStatic,
  startNdjsonStream,
  toPublicModel,
  toPublicTheme,
} from './http/support.js';
import { registerSystemRoutes } from './http/routes/system.js';
import { registerModelRoutes } from './http/routes/models.js';
import { registerUserRoutes } from './http/routes/users.js';
import { registerThemeRoutes } from './http/routes/themes.js';
import { registerDatasetRoutes } from './http/routes/datasets.js';
import { registerIndicatorRoutes } from './http/routes/indicators.js';
import { registerChatRoutes } from './http/routes/chat.js';
import { registerUploadRoutes } from './http/routes/uploads.js';
import { registerMemoryRoutes } from './http/routes/memory.js';
import { registerAuthRoutes } from './http/routes/auth.js';

// Declarative route table (P0-8). Dispatch and the generated OpenAPI document
// both read from this single list, so they cannot drift apart.
export function buildRouteTable() {
  const table = createRouteTable();
  registerAuthRoutes(table);
  registerSystemRoutes(table);
  registerModelRoutes(table);
  registerUserRoutes(table);
  registerThemeRoutes(table);
  registerDatasetRoutes(table);
  registerIndicatorRoutes(table);
  registerChatRoutes(table);
  registerUploadRoutes(table);
  registerMemoryRoutes(table);
  return table;
}

function applyCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-user-id, x-trace-id, Authorization',
  );
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
}

export async function startServer(configOverride, indicatorClientOverride = null) {
  const application = await createApplication(
    configOverride,
    indicatorClientOverride,
  );
  await application.init();
  const {
    config,
    database,
    indicatorClient,
    agent,
    workspace,
  } = application;

  const router = buildRouteTable();
  const middleware = createMiddlewareRegistry();
  const supersonicAvailable = () => (
    application.getSupersonicEnabled()
    && indicatorClient.mode !== 'unconfigured'
  );

  // Shared request-scoped context. Middleware may enrich it (e.g. `user`);
  // handlers destructure only what they need, exactly as they did before the
  // route table existed, which keeps every response byte-identical.
  const baseContext = {
    application,
    config,
    database,
    indicatorClient,
    agent,
    workspace,
    uploads: application.uploads,
    router,
    supersonicAvailable,
    renderMetrics,
    getRequestUser: (request, targetDatabase) => (
      getRequestUser(request, targetDatabase ?? database, config)
    ),
    parseIntParam,
    prepareModelPayload,
    prepareThemePayload,
    readJson,
    sendError,
    sendJson,
    startNdjsonStream,
    toPublicModel,
    toPublicTheme,
  };

  async function handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const method = request.method ?? 'GET';

    applyCorsHeaders(response);
    if (method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const matched = router.match(method, pathname);
      if (matched) {
        const ctx = {
          ...baseContext,
          request,
          response,
          method,
          pathname,
          url,
          query: url.searchParams,
          params: matched.params,
          traceId: currentTraceId(),
        };
        // 鉴权单一事实源：`auth`/`admin` 中间件解析出来的 ctx.user 就是唯一答案。
        // 路由里的 getRequestUser(request, database) 直接复用它，不再做第二次解析
        // （第二次解析既多一次会话查询，也给了它与中间件结论不一致的机会）；
        // 只有没挂 auth 的公开路由才回落到真实解析，并带上本请求的 config。
        ctx.getRequestUser = (scopedRequest, scopedDatabase) => (
          ctx.user ?? baseContext.getRequestUser(scopedRequest, scopedDatabase)
        );
        await runRoute(ctx, matched.route, middleware);
        return;
      }
      await serveStatic(request, response, pathname);
    } catch (error) {
      if (!response.headersSent) {
        sendError(response, error);
      } else {
        response.end();
      }
    }
  }

  const server = http.createServer((request, response) => {
    const traceId = normalizeTraceId(request.headers['x-trace-id']) ?? createTraceId();
    response.setHeader('x-trace-id', traceId);
    runWithTrace(traceId, () => handleRequest(request, response)).catch((error) => {
      if (!response.headersSent) {
        sendError(response, error);
      } else {
        response.end();
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', resolve);
  });

  return {
    server,
    application,
    url: `http://localhost:${config.port}`,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer()
    .then(({ url, application }) => {
      const health = application.currentHealth();
      console.log(`YOLO Data running at ${url}`);
      console.log(`Indicator source: ${health.source.mode}${health.source.error ? ` (${health.source.error})` : ''}`);
      console.log(`Agent runtime: ${health.llm.mode}`);
      const python = probePythonRuntime(application.config.pythonBin);
      if (python.message) {
        console.warn(`Python runtime: ${python.message}`);
      } else {
        console.log(`Python runtime: ${python.pythonBin} ${python.version ?? ''}`.trim());
      }
      if (application.config.authMode === 'dev') {
        console.warn(
          'Auth mode: dev —— 未启用登录会话校验（x-user-id 直连，缺省落到管理员）。'
          + ' 生产部署请设置 NODE_ENV=production 或 AUTH_MODE=session。',
        );
      }
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
