import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { readSessionToken, resolveAuthMode, resolveSession } from '../auth.js';
import { isPromptSemanticRule, parseSemanticBlock } from '../themeSemanticRules.js';

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
export const publicRoot = path.join(projectRoot, 'public');

export function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

export function startNdjsonStream(response) {
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

export function toPublicTheme(themeRecord) {
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

export function toPublicModel(modelRecord) {
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

export function prepareModelPayload(body, existingModel, crypto) {
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

// 提示词里声明的规则由读取时解析，持久化时剔除，避免数据库里出现同一条规则的副本。
function stripPromptSemanticRules(policy) {
  if (!policy || typeof policy !== 'object') {
    return policy;
  }
  const keep = (list) => (Array.isArray(list)
    ? list.filter((rule) => !isPromptSemanticRule(rule))
    : list);
  return {
    ...policy,
    metrics: keep(policy.metrics),
    dimensions: keep(policy.dimensions),
    filters: keep(policy.filters),
    enumGroups: keep(policy.enumGroups),
  };
}

export function prepareThemePayload(body, existingTheme, crypto) {
  const { issues } = parseSemanticBlock(body?.systemPrompt);
  if (issues.length > 0) {
    throw Object.assign(
      new Error(`提示词里的业务口径块无法解析：${issues.join('；')}`),
      { statusCode: 400 },
    );
  }
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
    // 提示词里的规则每次读取时重新解析，不写回数据库，避免同一份规则存两处。
    semanticPolicy: stripPromptSemanticRules(body?.semanticPolicy),
    llmConfig,
  };
}

export function sendError(response, error) {
  const statusCode = error.statusCode ?? 400;
  sendJson(response, statusCode, {
    code: statusCode,
    message: error.message ?? 'request failed',
  });
}

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

export async function readJson(request, maxBytes = MAX_JSON_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
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

export function getRequestUser(request, database, config) {
  const token = readSessionToken(request);
  if (token) {
    const sessionUser = resolveSession(database, token);
    if (sessionUser) {
      return sessionUser;
    }
  }
  // 生产环境只认登录会话；开发模式保留 x-user-id 直连，方便脚本与测试。
  if (resolveAuthMode(config) !== 'dev') {
    const error = new Error(token ? '登录状态已失效，请重新登录' : '请先登录');
    error.statusCode = 401;
    throw error;
  }
  const userId = request.headers['x-user-id']
    ?? new URL(request.url, 'http://localhost').searchParams.get('userId')
    ?? '1';
  const user = database.getUser(Number(userId));
  if (!user) {
    const error = new Error('user not found');
    error.statusCode = 401;
    throw error;
  }
  if (Number(user.status ?? 1) === 0) {
    const error = new Error('user is disabled');
    error.statusCode = 401;
    throw error;
  }
  return user;
}

export function parseIntParam(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function requireAdmin(user) {
  if (String(user?.role ?? '').toUpperCase() !== 'ADMIN') {
    throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
  }
  return user;
}

export async function serveStatic(request, response, pathname) {
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
