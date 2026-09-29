import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';
import { createApplication } from './application.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function startNdjsonStream(response) {
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders?.();
  let closed = false;
  response.on('close', () => {
    closed = true;
  });
  return (event) => {
    if (closed || response.writableEnded) {
      return;
    }
    response.write(`${JSON.stringify(event)}\n`);
  };
}

function toPublicTheme(themeRecord) {
  if (!themeRecord) {
    return themeRecord;
  }
  const {
    indicatorIdsJson,
    allowedDimensionsJson,
    llmConfigJson,
    datasetIdsJson,
    businessDatasetIdsJson,
    semanticValueConfigJson,
    semanticPolicyJson,
    examplesJson,
    ...theme
  } = themeRecord;
  const {
    apiKey,
    apiKeyEncrypted,
    hasApiKey,
    ...llmConfig
  } = theme.llmConfig ?? {};
  const envName = String(llmConfig.apiKeyEnv ?? '').trim();
  const envConfigured = Boolean(envName && process.env[envName]);
  return {
    ...theme,
    llmConfig: {
      ...llmConfig,
      hasApiKey: Boolean(apiKeyEncrypted),
      apiKeySource: apiKeyEncrypted
        ? 'THEME'
        : envConfigured
          ? 'ENV'
          : 'NONE',
    },
  };
}

function toPublicModel(modelRecord) {
  if (!modelRecord) {
    return modelRecord;
  }
  const {
    apiKeyEncrypted,
    hasApiKey,
    ...model
  } = modelRecord;
  const envName = String(model.apiKeyEnv ?? '').trim();
  const envConfigured = Boolean(envName && process.env[envName]);
  return {
    ...model,
    hasApiKey: Boolean(apiKeyEncrypted),
    apiKeySource: apiKeyEncrypted
      ? 'MODEL'
      : envConfigured
        ? 'ENV'
        : 'NONE',
  };
}

function prepareModelPayload(body, existingModel, crypto) {
  const incoming = body && typeof body === 'object' ? { ...body } : {};
  const apiKey = String(incoming.apiKey ?? '').trim();
  const clearApiKey = incoming.clearApiKey === true;
  const existing = existingModel ?? {};
  const payload = {
    ...existing,
    ...incoming,
  };
  delete payload.apiKeyEncrypted;
  delete payload.hasApiKey;
  delete payload.apiKeySource;
  delete payload.apiKey;
  delete payload.clearApiKey;
  if (apiKey) {
    payload.apiKeyEncrypted = crypto.encrypt(apiKey);
  } else if (clearApiKey) {
    delete payload.apiKeyEncrypted;
  } else if (existing.apiKeyEncrypted) {
    payload.apiKeyEncrypted = existing.apiKeyEncrypted;
  }
  return payload;
}

function prepareThemePayload(body, existingTheme, crypto) {
  const incoming = body?.llmConfig && typeof body.llmConfig === 'object'
    ? { ...body.llmConfig }
    : {};
  const apiKey = String(incoming.apiKey ?? '').trim();
  const clearApiKey = incoming.clearApiKey === true;
  const existing = existingTheme?.llmConfig ?? {};
  const llmConfig = {
    ...existing,
    ...incoming,
  };
  delete llmConfig.apiKeyEncrypted;
  delete llmConfig.hasApiKey;
  delete llmConfig.apiKeySource;
  delete llmConfig.apiKey;
  delete llmConfig.clearApiKey;
  if (apiKey) {
    llmConfig.apiKeyEncrypted = crypto.encrypt(apiKey);
  } else if (clearApiKey) {
    delete llmConfig.apiKeyEncrypted;
  } else if (existing.apiKeyEncrypted) {
    llmConfig.apiKeyEncrypted = existing.apiKeyEncrypted;
  }
  return {
    ...body,
    llmConfig,
  };
}

function sendError(response, error) {
  const statusCode = error.statusCode ?? 400;
  sendJson(response, statusCode, {
    code: statusCode,
    message: error.message ?? 'request failed',
  });
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) {
      const error = new Error('request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('invalid JSON body');
    error.statusCode = 400;
    throw error;
  }
}

function getRequestUser(request, database) {
  const userId = request.headers['x-user-id']
    ?? new URL(request.url, 'http://localhost').searchParams.get('userId')
    ?? '1';
  const user = database.getUser(Number(userId));
  if (!user) {
    const error = new Error('user not found');
    error.statusCode = 401;
    throw error;
  }
  return user;
}

function parseIntParam(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function matchRoute(method, pathname, pattern) {
  if (method !== pattern.method) {
    return null;
  }
  const match = pathname.match(pattern.regex);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

async function serveStatic(request, response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidate = path.resolve(publicRoot, relativePath);
  if (!candidate.startsWith(publicRoot)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  let filePath = candidate;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(publicRoot, 'index.html');
  }
  const extension = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  const cacheControl = ['.html', '.js', '.css'].includes(extension)
    ? 'no-store'
    : 'public, max-age=3600';
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
  });
  fs.createReadStream(filePath).pipe(response);
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
    applySupersonicSetting,
    getSupersonicEnabled,
  } = application;
  const isSupersonicEnabled = () => application.getSupersonicEnabled();
  const supersonicAvailable = () => (
    application.getSupersonicEnabled()
    && indicatorClient.mode !== 'unconfigured'
  );

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const method = request.method ?? 'GET';

    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id, Authorization');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      if (pathname === '/api/health' && method === 'GET') {
        sendJson(response, 200, application.currentHealth());
        return;
      }

      if (pathname === '/api/settings' && method === 'GET') {
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
        return;
      }

      if (pathname === '/api/settings/supersonic' && method === 'PUT') {
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
        return;
      }

      if (pathname === '/api/models' && method === 'GET') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        sendJson(response, 200, database.listModels().map(toPublicModel));
        return;
      }

      if (pathname === '/api/models' && method === 'POST') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const body = await readJson(request);
        const model = database.saveModel(
          prepareModelPayload(body, null, application.datasourceCrypto),
        );
        database.addAuditLog({
          userId: user.id,
          action: 'MODEL_CREATE',
          detail: { modelId: model.id, name: model.name, modelName: model.modelName },
        });
        sendJson(response, 200, toPublicModel(model));
        return;
      }

      const modelRoute = matchRoute(method, pathname, {
        method: 'PUT',
        regex: /^\/api\/models\/(\d+)$/,
      });
      if (modelRoute) {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const existing = database.getModel(Number(modelRoute[0]));
        if (!existing) {
          throw Object.assign(new Error('model not found'), { statusCode: 404 });
        }
        const body = await readJson(request);
        const model = database.saveModel(
          prepareModelPayload(body, existing, application.datasourceCrypto),
          Number(modelRoute[0]),
        );
        database.addAuditLog({
          userId: user.id,
          action: 'MODEL_UPDATE',
          detail: { modelId: model.id, name: model.name, modelName: model.modelName },
        });
        sendJson(response, 200, toPublicModel(model));
        return;
      }

      const modelDefaultRoute = matchRoute(method, pathname, {
        method: 'PUT',
        regex: /^\/api\/models\/(\d+)\/default$/,
      });
      if (modelDefaultRoute) {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const model = database.setModelDefault(Number(modelDefaultRoute[0]));
        if (!model) {
          throw Object.assign(new Error('model not found'), { statusCode: 404 });
        }
        database.addAuditLog({
          userId: user.id,
          action: 'MODEL_DEFAULT_UPDATE',
          detail: { modelId: model.id, name: model.name },
        });
        sendJson(response, 200, toPublicModel(model));
        return;
      }

      const modelDeleteRoute = matchRoute(method, pathname, {
        method: 'DELETE',
        regex: /^\/api\/models\/(\d+)$/,
      });
      if (modelDeleteRoute) {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const deleted = database.deleteModel(Number(modelDeleteRoute[0]));
        database.addAuditLog({
          userId: user.id,
          action: 'MODEL_DELETE',
          detail: { modelId: Number(modelDeleteRoute[0]), deleted },
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (pathname === '/api/bootstrap' && method === 'GET') {
        const user = getRequestUser(request, database);
        const themes = agent.getThemesForUser(user.id);
        const canManage = user.role === 'ADMIN';
        const indicatorTypes = !supersonicAvailable()
          ? []
          : await indicatorClient.listTypes().catch(() => []);
        sendJson(response, 200, {
          currentUser: user,
          users: canManage ? database.listUsers() : [user],
          themes: themes.map(toPublicTheme),
          skills: database.listSkills(),
          datasetOptions: database.listDatasetOptions(),
          businessDatasets: database.listBusinessDatasets(),
          dataSources: user.role === 'ADMIN' ? database.listDataSources() : [],
          models: user.role === 'ADMIN' ? database.listModels().map(toPublicModel) : [],
          indicatorTypes,
          health: application.currentHealth(),
        });
        return;
      }

      if (pathname === '/api/users' && method === 'GET') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        sendJson(response, 200, database.listUsers());
        return;
      }

      if (pathname === '/api/users' && method === 'POST') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const body = await readJson(request);
        const saved = database.saveUser(body);
        database.addAuditLog({
          userId: user.id,
          action: 'USER_CREATE',
          detail: { targetUserId: saved.id, username: saved.username },
        });
        sendJson(response, 200, saved);
        return;
      }

      const userRoute = matchRoute(method, pathname, {
        method: 'PUT',
        regex: /^\/api\/users\/(\d+)$/,
      });
      if (userRoute) {
        const current = getRequestUser(request, database);
        if (current.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const body = await readJson(request);
        const saved = database.saveUser(body, Number(userRoute[0]));
        database.addAuditLog({
          userId: current.id,
          action: 'USER_UPDATE',
          detail: { targetUserId: saved.id, username: saved.username },
        });
        sendJson(response, 200, saved);
        return;
      }

      const permissionRoute = matchRoute(method, pathname, {
        method: 'GET',
        regex: /^\/api\/users\/(\d+)\/permissions$/,
      });
      if (permissionRoute) {
        const current = getRequestUser(request, database);
        if (current.role !== 'ADMIN' && Number(permissionRoute[0]) !== current.id) {
          throw Object.assign(new Error('permission denied'), { statusCode: 403 });
        }
        sendJson(response, 200, database.getPermissionProfile(Number(permissionRoute[0])));
        return;
      }

      const permissionSaveRoute = matchRoute(method, pathname, {
        method: 'PUT',
        regex: /^\/api\/users\/(\d+)\/permissions$/,
      });
      if (permissionSaveRoute) {
        const current = getRequestUser(request, database);
        if (current.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const body = await readJson(request);
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
        return;
      }

      if (pathname === '/api/themes' && method === 'GET') {
        const user = getRequestUser(request, database);
        sendJson(response, 200, agent.getThemesForUser(user.id).map(toPublicTheme));
        return;
      }

      if (pathname === '/api/skills' && method === 'GET') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        sendJson(response, 200, database.listSkills());
        return;
      }

      if (pathname === '/api/skill-registry' && method === 'GET') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        sendJson(response, 200, {
          roots: application.config.skillDirectories ?? [],
          sync: application.runtime.skillSync,
          skills: database.listSkills(),
        });
        return;
      }

      if (pathname === '/api/skill-registry/sync' && method === 'POST') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const sync = application.skillRegistry.refreshExternalSkills();
        application.runtime.skillSync = sync;
        database.addAuditLog({
          userId: user.id,
          action: 'SKILL_REGISTRY_SYNC',
          detail: {
            count: sync.count ?? 0,
            roots: sync.roots ?? [],
            warnings: sync.warnings?.length ?? 0,
          },
        });
        sendJson(response, 200, {
          ...sync,
          skills: database.listSkills(),
        });
        return;
      }

      if (pathname === '/api/themes' && method === 'POST') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const body = await readJson(request);
        const theme = database.saveTheme(
          prepareThemePayload(body, null, application.datasourceCrypto),
        );
        database.addAuditLog({
          userId: user.id,
          action: 'THEME_CREATE',
          detail: {
            themeId: theme.id,
            name: theme.name,
            modelKeyConfigured: Boolean(theme.llmConfig?.apiKeyEncrypted),
          },
        });
        sendJson(response, 200, toPublicTheme(theme));
        return;
      }

      const themeRoute = matchRoute(method, pathname, {
        method: 'PUT',
        regex: /^\/api\/themes\/(\d+)$/,
      });
      if (themeRoute) {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const body = await readJson(request);
        const existingTheme = database.getTheme(Number(themeRoute[0]));
        if (!existingTheme) {
          throw Object.assign(new Error('theme not found'), { statusCode: 404 });
        }
        const theme = database.saveTheme(
          prepareThemePayload(body, existingTheme, application.datasourceCrypto),
          Number(themeRoute[0]),
        );
        database.addAuditLog({
          userId: user.id,
          action: 'THEME_UPDATE',
          detail: {
            themeId: theme.id,
            name: theme.name,
            modelKeyConfigured: Boolean(theme.llmConfig?.apiKeyEncrypted),
          },
        });
        sendJson(response, 200, toPublicTheme(theme));
        return;
      }

      const themeDeleteRoute = matchRoute(method, pathname, {
        method: 'DELETE',
        regex: /^\/api\/themes\/(\d+)$/,
      });
      if (themeDeleteRoute) {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const deleted = database.deleteTheme(Number(themeDeleteRoute[0]));
        database.addAuditLog({
          userId: user.id,
          action: 'THEME_DELETE',
          detail: { themeId: Number(themeDeleteRoute[0]), deleted },
        });
        sendJson(response, 200, { deleted });
        return;
      }

      const themePromptRoute = matchRoute(method, pathname, {
        method: 'PUT',
        regex: /^\/api\/themes\/(\d+)\/prompt$/,
      });
      if (themePromptRoute) {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const body = await readJson(request);
        const theme = database.updateThemePrompt(Number(themePromptRoute[0]), body.systemPrompt);
        if (!theme) {
          throw Object.assign(new Error('theme not found'), { statusCode: 404 });
        }
        database.addAuditLog({
          userId: user.id,
          action: 'THEME_PROMPT_UPDATE',
          detail: { themeId: theme.id, name: theme.name },
        });
        sendJson(response, 200, theme);
        return;
      }

      if (pathname === '/api/semantic-values/preview' && method === 'POST') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const body = await readJson(request);
        const themeId = Number(body.themeId);
        sendJson(response, 200, await agent.listSemanticValueFields(
          Number.isFinite(themeId) && themeId > 0 ? themeId : null,
          {
            indicatorIds: Array.isArray(body.indicatorIds) ? body.indicatorIds : [],
            businessDatasetIds: Array.isArray(body.businessDatasetIds)
              ? body.businessDatasetIds
              : [],
            semanticValueConfig: body.semanticValueConfig ?? {},
            systemPrompt: String(body.systemPrompt ?? ''),
          },
        ));
        return;
      }

      const themeSemanticValuesRoute = matchRoute(method, pathname, {
        method: 'GET',
        regex: /^\/api\/themes\/(\d+)\/semantic-values$/,
      }) ?? matchRoute(method, pathname, {
        method: 'PUT',
        regex: /^\/api\/themes\/(\d+)\/semantic-values$/,
      });
      if (themeSemanticValuesRoute) {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const themeId = Number(themeSemanticValuesRoute[0]);
        const theme = database.getTheme(themeId);
        if (!theme) {
          throw Object.assign(new Error('theme not found'), { statusCode: 404 });
        }
        if (method === 'GET') {
          sendJson(response, 200, await agent.listSemanticValueFields(themeId));
          return;
        }
        const body = await readJson(request);
        const updated = database.saveTheme({
          ...theme,
          semanticValueConfig: body,
        }, themeId);
        database.addAuditLog({
          userId: user.id,
          action: 'THEME_SEMANTIC_VALUES_UPDATE',
          detail: {
            themeId,
            enabled: updated.semanticValueConfig?.enabled !== false,
            fieldCount: Object.keys(updated.semanticValueConfig?.fields ?? {}).length,
          },
        });
        sendJson(response, 200, await agent.listSemanticValueFields(themeId));
        return;
      }

      const themeSemanticValuesRefreshRoute = matchRoute(method, pathname, {
        method: 'POST',
        regex: /^\/api\/themes\/(\d+)\/semantic-values\/refresh$/,
      });
      if (themeSemanticValuesRefreshRoute) {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const themeId = Number(themeSemanticValuesRefreshRoute[0]);
        const result = await agent.refreshSemanticValueFields(themeId);
        database.addAuditLog({
          userId: user.id,
          action: 'THEME_SEMANTIC_VALUES_REFRESH',
          detail: {
            themeId,
            fieldCount: result.fields.length,
            warningCount: result.warnings.length,
          },
        });
        sendJson(response, 200, result);
        return;
      }

      if (pathname === '/api/semantic-domains' && method === 'GET') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const themeId = Number(
          new URL(request.url, 'http://localhost').searchParams.get('themeId'),
        );
        if (!Number.isFinite(themeId) || themeId <= 0) {
          throw Object.assign(new Error('themeId is required'), { statusCode: 400 });
        }
        sendJson(response, 200, await agent.listSemanticValueFields(themeId));
        return;
      }

      if (pathname === '/api/semantic-domains/refresh' && method === 'POST') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const body = await readJson(request);
        const result = await agent.refreshSemanticValueDomain(body);
        database.addAuditLog({
          userId: user.id,
          action: 'SEMANTIC_DOMAIN_REFRESH',
          detail: {
            themeId: body.themeId,
            sourceType: body.sourceType,
            sourceId: body.sourceId,
            fieldName: body.fieldName,
            status: result?.status,
          },
        });
        sendJson(response, 200, result);
        return;
      }

      if (pathname === '/api/semantic-domains/override' && method === 'POST') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const body = await readJson(request);
        const result = await agent.saveSemanticValueOverride({
          ...body,
          updatedBy: user.id,
        });
        database.addAuditLog({
          userId: user.id,
          action: 'SEMANTIC_DOMAIN_OVERRIDE',
          detail: {
            themeId: body.themeId,
            sourceType: body.sourceType,
            sourceId: body.sourceId,
            fieldName: body.fieldName,
            concept: body.concept,
            action: body.action,
          },
        });
        sendJson(response, 200, result);
        return;
      }

      if (pathname === '/api/indicator-types' && method === 'GET') {
        const indicatorTypes = !supersonicAvailable()
          ? []
          : await indicatorClient.listTypes().catch(() => []);
        sendJson(response, 200, indicatorTypes);
        return;
      }

      if (pathname === '/api/data-sources' && method === 'GET') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        sendJson(response, 200, application.businessDatasets.listDataSources());
        return;
      }

      if (pathname === '/api/data-sources' && method === 'POST') {
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
        return;
      }

      const datasourceActionRoute = matchRoute(method, pathname, {
        method: 'POST',
        regex: /^\/api\/data-sources\/(\d+)\/(test)$/,
      });
      if (datasourceActionRoute) {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const source = await application.businessDatasets.testDataSource(
          Number(datasourceActionRoute[0]),
        );
        sendJson(response, 200, source);
        return;
      }

      const datasourceMetadataRoute = matchRoute(method, pathname, {
        method: 'GET',
        regex: /^\/api\/data-sources\/(\d+)\/(databases|tables|columns)$/,
      });
      if (datasourceMetadataRoute) {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const [id, action] = datasourceMetadataRoute;
        if (action === 'databases') {
          sendJson(response, 200, await application.businessDatasets.listDatabases(Number(id)));
        } else if (action === 'tables') {
          sendJson(response, 200, await application.businessDatasets.listTables(
            Number(id),
            url.searchParams.get('schema'),
          ));
        } else {
          sendJson(response, 200, await application.businessDatasets.listColumns(
            Number(id),
            url.searchParams.get('schema'),
            url.searchParams.get('table'),
          ));
        }
        return;
      }

      if (pathname === '/api/business-datasets' && method === 'GET') {
        const user = getRequestUser(request, database);
        sendJson(response, 200, application.businessDatasets.listDatasets({
          userId: user.role === 'ADMIN' ? null : user.id,
          includeDisabled: user.role === 'ADMIN',
        }));
        return;
      }

      if (pathname === '/api/business-datasets' && method === 'POST') {
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
        return;
      }

      const datasetActionRoute = matchRoute(method, pathname, {
        method: 'POST',
        regex: /^\/api\/business-datasets\/(\d+)\/(sync)$/,
      });
      if (datasetActionRoute) {
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
        return;
      }

      const datasetDetailRoute = matchRoute(method, pathname, {
        method: 'GET',
        regex: /^\/api\/business-datasets\/(\d+)\/(fields|sample)$/,
      });
      if (datasetDetailRoute) {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const [id, action] = datasetDetailRoute;
        if (action === 'fields') {
          sendJson(response, 200, application.businessDatasets.getDatasetFields(Number(id)));
        } else {
          sendJson(response, 200, await application.businessDatasets.sampleDataset(
            Number(id),
            parseIntParam(url.searchParams.get('limit'), 20),
          ));
        }
        return;
      }

      if (pathname === '/api/dataset-query-logs' && method === 'GET') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        sendJson(response, 200, database.listDatasetQueryLogs(
          parseIntParam(url.searchParams.get('limit'), 100),
        ));
        return;
      }

      if (pathname === '/api/indicators' && method === 'GET') {
        const user = getRequestUser(request, database);
        if (!application.getSupersonicEnabled()) {
          sendJson(response, 200, {
            items: [],
            total: 0,
            disabled: true,
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
        sendJson(response, 200, { items: indicators, total: page.total });
        return;
      }

      const indicatorDetailRoute = matchRoute(method, pathname, {
        method: 'GET',
        regex: /^\/api\/indicators\/([^/]+)\/detail$/,
      });
      if (indicatorDetailRoute) {
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
        return;
      }

      if (pathname === '/api/indicators/sync' && method === 'POST') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const result = await application.syncIndicators();
        database.addAuditLog({
          userId: user.id,
          action: 'INDICATOR_CONNECT',
          detail: result,
        });
        sendJson(response, 200, { ...result, health: application.currentHealth() });
        return;
      }

      if (pathname === '/api/chat/query/stream' && method === 'POST') {
        const user = getRequestUser(request, database);
        const body = await readJson(request);
        const writeEvent = startNdjsonStream(response);
        const abortController = new AbortController();
        const abortOnClose = () => {
          if (!response.writableEnded) {
            abortController.abort();
          }
        };
        request.on('aborted', abortOnClose);
        response.on('close', abortOnClose);
        try {
          const answer = await agent.answer({
            userId: user.id,
            themeId: body.themeId ? Number(body.themeId) : undefined,
            sessionId: body.sessionId ? Number(body.sessionId) : undefined,
            question: body.question,
            preferredChart: body.preferredChart,
            clarificationOptionId: body.clarificationOptionId,
            modelId: body.modelId ? Number(body.modelId) : null,
            signal: abortController.signal,
            onEvent: writeEvent,
          });
          writeEvent({ type: 'final', answer });
          writeEvent({
            type: 'stream_done',
            messageId: answer.messageId,
            sessionId: answer.sessionId,
          });
        } catch (error) {
          writeEvent({
            type: 'stream_error',
            message: error.message ?? 'query failed',
          });
        } finally {
          request.off('aborted', abortOnClose);
          response.off('close', abortOnClose);
          if (!response.writableEnded) {
            response.end();
          }
        }
        return;
      }

      if (pathname === '/api/chat/query' && method === 'POST') {
        const user = getRequestUser(request, database);
        const body = await readJson(request);
        const result = await agent.answer({
          userId: user.id,
          themeId: body.themeId ? Number(body.themeId) : undefined,
          sessionId: body.sessionId ? Number(body.sessionId) : undefined,
          question: body.question,
          preferredChart: body.preferredChart === 'auto' ? 'auto' : body.preferredChart,
          clarificationOptionId: body.clarificationOptionId,
          modelId: body.modelId ? Number(body.modelId) : null,
        });
        sendJson(response, 200, result);
        return;
      }

      if (pathname === '/api/workspaces' && method === 'GET') {
        const user = getRequestUser(request, database);
        const sessionId = request.url.includes('?')
          ? Number(new URL(request.url, 'http://localhost').searchParams.get('sessionId'))
          : null;
        sendJson(response, 200, workspace.listForUser({
          userId: user.id,
          sessionId: Number.isFinite(sessionId) && sessionId > 0 ? sessionId : null,
        }));
        return;
      }

      const workspaceArtifactsRoute = matchRoute(method, pathname, {
        method: 'GET',
        regex: /^\/api\/workspaces\/(\d+)\/artifacts$/,
      });
      if (workspaceArtifactsRoute) {
        const user = getRequestUser(request, database);
        sendJson(response, 200, workspace.listArtifacts({
          workspaceId: Number(workspaceArtifactsRoute[0]),
          userId: user.id,
        }));
        return;
      }

      const artifactRoute = matchRoute(method, pathname, {
        method: 'GET',
        regex: /^\/api\/artifacts\/([^/]+)$/,
      });
      if (artifactRoute) {
        const user = getRequestUser(request, database);
        sendJson(response, 200, workspace.getArtifact({
          artifactId: decodeURIComponent(artifactRoute[0]),
          userId: user.id,
        }));
        return;
      }

      const artifactTransformRoute = matchRoute(method, pathname, {
        method: 'POST',
        regex: /^\/api\/artifacts\/([^/]+)\/transform$/,
      });
      if (artifactTransformRoute) {
        const user = getRequestUser(request, database);
        const body = await readJson(request);
        const result = workspace.transformArtifact({
          artifactId: decodeURIComponent(artifactTransformRoute[0]),
          userId: user.id,
          operation: body.operation,
          params: body.params ?? {},
        });
        database.addAuditLog({
          userId: user.id,
          action: 'WORKSPACE_ARTIFACT_TRANSFORM',
          detail: {
            artifactId: result.id,
            operation: body.operation,
            version: result.currentVersion,
          },
        });
        sendJson(response, 200, result);
        return;
      }

      const artifactDownloadRoute = matchRoute(method, pathname, {
        method: 'GET',
        regex: /^\/api\/artifacts\/([^/]+)\/download$/,
      });
      if (artifactDownloadRoute) {
        const user = getRequestUser(request, database);
        const url = new URL(request.url, 'http://localhost');
        const exported = workspace.exportArtifact({
          artifactId: decodeURIComponent(artifactDownloadRoute[0]),
          userId: user.id,
          format: url.searchParams.get('format') ?? 'csv',
        });
        response.writeHead(200, {
          'Content-Type': exported.contentType,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(exported.filename)}`,
          'Cache-Control': 'no-store',
        });
        response.end(exported.content);
        return;
      }

      if (pathname === '/api/chat/sessions' && method === 'GET') {
        const user = getRequestUser(request, database);
        sendJson(response, 200, agent.listSessions(user.id));
        return;
      }

      if (pathname === '/api/chat/sessions' && method === 'POST') {
        const user = getRequestUser(request, database);
        const body = await readJson(request);
        const session = agent.createSession({
          userId: user.id,
          themeId: Number(body.themeId),
          title: body.title,
          modelId: body.modelId ? Number(body.modelId) : null,
        });
        database.addAuditLog({
          userId: user.id,
          themeId: session.themeId,
          action: 'CHAT_SESSION_CREATE',
          detail: {
            sessionId: session.id,
            themeId: session.themeId,
            modelId: session.modelId ?? null,
          },
        });
        sendJson(response, 200, session);
        return;
      }

      const sessionMessagesRoute = matchRoute(method, pathname, {
        method: 'GET',
        regex: /^\/api\/chat\/sessions\/(\d+)\/messages$/,
      });
      if (sessionMessagesRoute) {
        const user = getRequestUser(request, database);
        const messages = agent.listMessages(Number(sessionMessagesRoute[0]), user.id);
        sendJson(response, 200, messages);
        return;
      }

      const sessionDeleteRoute = matchRoute(method, pathname, {
        method: 'DELETE',
        regex: /^\/api\/chat\/sessions\/(\d+)$/,
      });
      if (sessionDeleteRoute) {
        const user = getRequestUser(request, database);
        const deleted = agent.deleteSession(Number(sessionDeleteRoute[0]), user.id);
        database.addAuditLog({
          userId: user.id,
          action: 'CHAT_SESSION_DELETE',
          detail: { sessionId: Number(sessionDeleteRoute[0]), deleted },
        });
        sendJson(response, 200, { deleted });
        return;
      }

      if (pathname === '/api/feedback' && method === 'POST') {
        const user = getRequestUser(request, database);
        const body = await readJson(request);
        const result = application.feedback.submit({
          userId: user.id,
          themeId: body.themeId ? Number(body.themeId) : null,
          sessionId: body.sessionId ? Number(body.sessionId) : null,
          messageId: body.messageId ? Number(body.messageId) : null,
          question: body.question,
          correct: Boolean(body.correct),
          comment: body.comment,
          corrected: body.corrected ?? {},
        });
        database.addAuditLog({
          userId: user.id,
          themeId: body.themeId ? Number(body.themeId) : null,
          action: 'QA_FEEDBACK',
          detail: {
            feedbackId: result.id,
            messageId: body.messageId,
            correct: result.correct,
          },
        });
        sendJson(response, 200, result);
        return;
      }

      if (pathname === '/api/feedback' && method === 'GET') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        sendJson(response, 200, application.feedback.list({
          themeId: url.searchParams.get('themeId'),
          correct: url.searchParams.has('correct')
            ? url.searchParams.get('correct') === 'true'
            : null,
          limit: parseIntParam(url.searchParams.get('limit'), 200),
        }));
        return;
      }

      if (pathname === '/api/knowledge-gaps' && method === 'GET') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        sendJson(response, 200, application.growth.list({
          includeClosed: url.searchParams.get('includeClosed') === 'true',
          limit: parseIntParam(url.searchParams.get('limit'), 200),
        }));
        return;
      }

      const gapActionRoute = matchRoute(method, pathname, {
        method: 'POST',
        regex: /^\/api\/knowledge-gaps\/(\d+)\/(dismiss|resolve|reopen)$/,
      });
      if (gapActionRoute) {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const [id, action] = gapActionRoute;
        const body = await readJson(request);
        const resolution = body.resolution ?? { note: body.note ?? '' };
        const gap = action === 'dismiss'
          ? application.growth.dismiss(Number(id), resolution)
          : action === 'resolve'
            ? application.growth.resolve(Number(id), resolution)
            : application.growth.reopen(Number(id));
        database.addAuditLog({
          userId: user.id,
          action: 'KNOWLEDGE_GAP_UPDATE',
          detail: { gapId: Number(id), action, resolution },
        });
        sendJson(response, 200, gap);
        return;
      }

      const queryPlanRoute = matchRoute(method, pathname, {
        method: 'GET',
        regex: /^\/api\/query-plans\/([^/]+)$/,
      });
      if (queryPlanRoute) {
        const user = getRequestUser(request, database);
        const plan = database.getQueryPlan(
          queryPlanRoute[0],
          user.role === 'ADMIN' ? null : user.id,
        );
        if (!plan) {
          throw Object.assign(new Error('query plan not found'), { statusCode: 404 });
        }
        sendJson(response, 200, plan);
        return;
      }

      if (pathname === '/api/llm-logs' && method === 'GET') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        sendJson(response, 200, {
          stats: application.llmAudit.stats(),
          items: application.llmAudit.list(parseIntParam(url.searchParams.get('limit'), 200)),
        });
        return;
      }

      if (pathname === '/api/audit' && method === 'GET') {
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        sendJson(response, 200, database.listAuditLogs(
          parseIntParam(url.searchParams.get('limit'), 100),
        ));
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
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
