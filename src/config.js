import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

function parsePathList(value, fallback = []) {
  const items = String(value ?? '')
    .split(new RegExp(`[${path.delimiter},;]+`))
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(items.length > 0 ? items : fallback)];
}

export function loadConfig(env = process.env) {
  const envFilePath = path.resolve(projectRoot, '.env');
  if (env === process.env && fs.existsSync(envFilePath)) {
    const existing = { ...process.env };
    process.loadEnvFile(envFilePath);
    Object.assign(process.env, existing);
  }
  const dbPath = String(env.PLATFORM_DB_PATH ?? './data/platform.db').trim();
  const skillDirectories = parsePathList(
    env.AGENT_SKILL_DIRECTORIES,
    [
      path.join(projectRoot, 'skills'),
      path.join(os.homedir(), '.codex', 'skills'),
    ],
  ).map((directory) => {
    const expanded = directory === '~' || directory.startsWith('~/') || directory.startsWith('~\\')
      ? path.join(os.homedir(), directory.slice(1))
      : directory;
    return path.isAbsolute(expanded)
      ? expanded
      : path.resolve(projectRoot, expanded);
  });

  return {
    projectRoot,
    port: readInt(env.PORT, 8088),
    dbPath: path.isAbsolute(dbPath) ? dbPath : path.resolve(projectRoot, dbPath),
    supersonic: {
      baseUrl: normalizeBaseUrl(env.SUPERSONIC_BASE_URL),
      token: String(env.SUPERSONIC_TOKEN ?? '').trim(),
      appKey: String(env.SUPERSONIC_APP_KEY ?? '').trim(),
      serviceClientId: String(env.SUPERSONIC_SERVICE_CLIENT_ID ?? '').trim(),
      serviceClientSecret: String(
        env.SUPERSONIC_SERVICE_CLIENT_SECRET ?? '',
      ).trim(),
      timeoutMs: readInt(env.SUPERSONIC_TIMEOUT_MS, 30_000),
    },
    allowDemoIndicatorSource: String(
      env.ALLOW_DEMO_INDICATOR_SOURCE ?? '',
    ).toLowerCase() === 'true',
    deepseek: {
      baseUrl: normalizeBaseUrl(env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1'),
      apiKey: String(env.DEEPSEEK_API_KEY ?? '').trim(),
      model: String(env.DEEPSEEK_MODEL || 'deepseek-chat').trim(),
      temperature: Number.isFinite(Number(env.DEEPSEEK_TEMPERATURE))
        ? Number(env.DEEPSEEK_TEMPERATURE)
        : 0,
      maxTokens: readInt(env.DEEPSEEK_MAX_TOKENS, 0),
      timeoutMs: readInt(env.DEEPSEEK_TIMEOUT_MS, 180_000),
      maxToolRounds: readInt(env.DEEPSEEK_MAX_TOOL_ROUNDS, 12),
    },
    chatMemoryMessageLimit: readInt(env.CHAT_MEMORY_MESSAGE_LIMIT, 20),
    codeExecutionRoot: path.resolve(
      projectRoot,
      String(env.CODE_EXECUTION_ROOT ?? './data/code-runs').trim(),
    ),
    pythonBin: String(env.PYTHON_BIN ?? 'python').trim() || 'python',
    skillDirectories,
    datasourceSecretKey: String(env.DATASOURCE_SECRET_KEY ?? '').trim(),
    datasourceSecretKeyPath: path.resolve(projectRoot, 'data', '.datasource-key'),
    bootstrapDatasource: {
      enabled: String(env.DORIS_BOOTSTRAP_ENABLED ?? '').toLowerCase() === 'true',
      host: String(env.DORIS_BOOTSTRAP_HOST ?? '').trim(),
      port: readInt(env.DORIS_BOOTSTRAP_PORT, 9030),
      username: String(env.DORIS_BOOTSTRAP_USER ?? '').trim(),
      password: String(env.DORIS_BOOTSTRAP_PASSWORD ?? ''),
      database: String(env.DORIS_BOOTSTRAP_DATABASE ?? '').trim(),
      salesTable: String(env.DORIS_BOOTSTRAP_SALES_TABLE ?? '').trim(),
      goodsTable: String(env.DORIS_BOOTSTRAP_GOODS_TABLE ?? '').trim(),
    },
  };
}

export { projectRoot };
