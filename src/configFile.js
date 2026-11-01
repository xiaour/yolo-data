// 配置文件层：yolo-conf.yaml 是唯一的配置面，环境变量做覆盖。
//
// 分层优先级：真实环境变量（非空值） > yolo-conf.yaml > 代码内置默认。
// 做法是把 YAML 换算成同名环境变量，只填补「未设置或空串」的键，
// 因此 Docker / CI 仍可用环境变量覆盖，而不需要改配置文件。
//
// 平台不再读取 .env 文件：配置写在 yolo-conf.yaml，机密用真实环境变量提供
// （docker compose 的 environment、systemd 的 EnvironmentFile、shell export 等）。
// yolo-conf.yaml 可以随仓库分发，机密不落盘到版本库。

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const CONFIG_FILE_NAMES = ['yolo-conf.yaml', 'yolo-conf.yml'];

// YAML 路径 → 环境变量名。这张表是唯一事实源：
// 只有登记过的路径会生效，写错的键在启动时告警，避免「配了但不生效」的沉默故障。
export const CONFIG_FILE_MAP = {
  'server.port': 'PORT',
  'server.host': 'HOST',

  'auth.mode': 'AUTH_MODE',
  'auth.sessionTtlHours': 'SESSION_TTL_HOURS',
  'auth.secureCookies': 'SESSION_COOKIE_SECURE',
  'auth.defaultUserPassword': 'DEFAULT_USER_PASSWORD',
  'auth.oidc.issuer': 'AUTH_OIDC_ISSUER',
  'auth.oidc.clientId': 'AUTH_OIDC_CLIENT_ID',
  'auth.oidc.audience': 'AUTH_OIDC_AUDIENCE',
  'auth.oidc.jwksUri': 'AUTH_OIDC_JWKS_URI',

  'platformDatabase.backend': 'PLATFORM_DB_BACKEND',
  'platformDatabase.path': 'PLATFORM_DB_PATH',
  'platformDatabase.bootstrapResources': 'PLATFORM_BOOTSTRAP_RESOURCES',
  'platformDatabase.mysql.host': 'PLATFORM_DB_HOST',
  'platformDatabase.mysql.port': 'PLATFORM_DB_PORT',
  'platformDatabase.mysql.database': 'PLATFORM_DB_NAME',
  'platformDatabase.mysql.user': 'PLATFORM_DB_USER',
  'platformDatabase.mysql.password': 'PLATFORM_DB_PASSWORD',
  'platformDatabase.mysql.charset': 'PLATFORM_DB_CHARSET',
  'platformDatabase.mysql.initialize': 'PLATFORM_DB_INIT',
  'platformDatabase.mysql.initSqlPath': 'PLATFORM_DB_INIT_SQL',

  'skills.directories': 'AGENT_SKILL_DIRECTORIES',

  'models.baseUrl': 'API_BASE_URL',
  'models.apiKey': 'API_KEY',
  'models.model': 'MODEL',
  'models.temperature': 'TEMPERATURE',
  'models.maxTokens': 'MAX_TOKENS',
  'models.timeoutMs': 'TIMEOUT_MS',
  'models.maxToolRounds': 'MAX_TOOL_ROUNDS',

  'chat.memoryMessageLimit': 'CHAT_MEMORY_MESSAGE_LIMIT',

  'userMemory.autoConsolidateAt': 'USER_MEMORY_AUTO_CONSOLIDATE_AT',
  'userMemory.compactRatio': 'USER_MEMORY_COMPACT_RATIO',
  'userMemory.maintenanceIntervalMs': 'USER_MEMORY_MAINTENANCE_INTERVAL_MS',
  'userMemory.maintenanceStartupDelayMs': 'USER_MEMORY_MAINTENANCE_STARTUP_DELAY_MS',
  'userMemory.maintenanceBatchSize': 'USER_MEMORY_MAINTENANCE_BATCH_SIZE',
  'userMemory.preInject.enabled': 'USER_MEMORY_PREINJECT_ENABLED',
  'userMemory.preInject.topN': 'USER_MEMORY_PREINJECT_TOPN',
  'userMemory.preInject.maxChars': 'USER_MEMORY_PREINJECT_MAXCHARS',

  'reflection.enabled': 'REFLECTION_ENABLED',
  'reflection.maxReplan': 'REFLECTION_MAX_REPLAN',
  'reflection.judgeTimeoutMs': 'REFLECTION_JUDGE_TIMEOUT_MS',
  'recovery.maxAttempts': 'AGENT_RECOVERY_MAX_ATTEMPTS',

  'codeExecution.root': 'CODE_EXECUTION_ROOT',
  'codeExecution.pythonBin': 'PYTHON_BIN',
  'codeExecution.sandbox.backend': 'SANDBOX_BACKEND',
  'codeExecution.sandbox.image': 'SANDBOX_IMAGE',
  'codeExecution.sandbox.seccomp': 'SANDBOX_SECCOMP',

  'tokenBudget.userDaily': 'TOKEN_BUDGET_USER_DAILY',
  'tokenBudget.themeDaily': 'TOKEN_BUDGET_THEME_DAILY',

  'distributedLock.redisUrl': 'REDIS_URL',

  'uploads.maxBytes': 'UPLOAD_MAX_BYTES',
  'uploads.maxFilesPerSession': 'UPLOAD_MAX_FILES_PER_SESSION',
  'uploads.maxTotalBytesPerSession': 'UPLOAD_MAX_TOTAL_BYTES_PER_SESSION',
  'uploads.maxTableRows': 'UPLOAD_MAX_TABLE_ROWS',
  'uploads.allowedExtensions': 'UPLOAD_ALLOWED_EXTENSIONS',

  'datasource.secretKey': 'DATASOURCE_SECRET_KEY',

  'bootstrapDatasource.enabled': 'DORIS_BOOTSTRAP_ENABLED',
  'bootstrapDatasource.host': 'DORIS_BOOTSTRAP_HOST',
  'bootstrapDatasource.port': 'DORIS_BOOTSTRAP_PORT',
  'bootstrapDatasource.username': 'DORIS_BOOTSTRAP_USER',
  'bootstrapDatasource.password': 'DORIS_BOOTSTRAP_PASSWORD',
  'bootstrapDatasource.database': 'DORIS_BOOTSTRAP_DATABASE',
  'bootstrapDatasource.salesTable': 'DORIS_BOOTSTRAP_SALES_TABLE',
  'bootstrapDatasource.goodsTable': 'DORIS_BOOTSTRAP_GOODS_TABLE',

  'bootstrapDatasource.demo.enabled': 'DEMO_DATA_ENABLED',
  'bootstrapDatasource.demo.loadData': 'DEMO_DATA_LOAD',
  'bootstrapDatasource.demo.appendToExisting': 'DEMO_DATA_APPEND',
  'bootstrapDatasource.demo.rows': 'DEMO_DATA_ROWS',
  'bootstrapDatasource.demo.seed': 'DEMO_DATA_SEED',
  'bootstrapDatasource.demo.startDate': 'DEMO_DATA_START',
  'bootstrapDatasource.demo.endDate': 'DEMO_DATA_END',
  'bootstrapDatasource.demo.datasourceCode': 'DEMO_DATA_DATASOURCE',
  'bootstrapDatasource.demo.db.type': 'DEMO_DB_TYPE',
  'bootstrapDatasource.demo.db.host': 'DEMO_DB_HOST',
  'bootstrapDatasource.demo.db.port': 'DEMO_DB_PORT',
  'bootstrapDatasource.demo.db.database': 'DEMO_DB_DATABASE',
  'bootstrapDatasource.demo.db.user': 'DEMO_DB_USER',
  'bootstrapDatasource.demo.db.password': 'DEMO_DB_PASSWORD',
};

// 只允许标量转成环境变量字符串；对象是分组，数组按逗号拼（parsePathList 认逗号）。
function toEnvString(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).join(',');
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return null;
  return String(value);
}

function flattenLeaves(node, prefix = '', result = []) {
  for (const [key, value] of Object.entries(node ?? {})) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenLeaves(value, next, result);
    } else {
      result.push([next, value]);
    }
  }
  return result;
}

export function resolveConfigFilePath(projectRoot) {
  const override = String(process.env.YOLO_CONF_FILE ?? '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(projectRoot, override);
  }
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = path.join(projectRoot, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// 读文件并换算成「环境变量名 → 字符串」，同时挑出未知键，供调用方告警。
export function readConfigFile(filePath) {
  if (!filePath) return { values: {}, unknownKeys: [], error: null };
  let document;
  try {
    document = YAML.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { values: {}, unknownKeys: [], error: `yolo 配置解析失败（${path.basename(filePath)}）：${error.message}` };
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { values: {}, unknownKeys: [], error: null };
  }
  const values = {};
  const unknownKeys = [];
  for (const [yamlPath, value] of flattenLeaves(document)) {
    const envKey = CONFIG_FILE_MAP[yamlPath];
    if (!envKey) {
      unknownKeys.push(yamlPath);
      continue;
    }
    const text = toEnvString(value);
    if (text === null) continue;
    values[envKey] = text;
  }
  return { values, unknownKeys, error: null };
}

/**
 * 把 yolo-conf.yaml 填进目标 env：只补「未设置或空串」的键，真实环境变量永远优先。
 * @returns {{filePath: string|null, applied: string[], skipped: string[], unknownKeys: string[]}}
 */
export function applyConfigFile({
  projectRoot,
  target = process.env,
  logger = console,
  filePath = resolveConfigFilePath(projectRoot),
} = {}) {
  const { values, unknownKeys, error } = readConfigFile(filePath);
  if (error) {
    logger.warn?.(`[config] ${error}`);
  }
  if (unknownKeys.length > 0) {
    logger.warn?.(`[config] yolo 配置里这些键不会生效（未登记或拼写错误）：${unknownKeys.join(', ')}`);
  }
  const applied = [];
  const skipped = [];
  for (const [key, value] of Object.entries(values)) {
    const current = target[key];
    if (current === undefined || current === '') {
      target[key] = value;
      applied.push(key);
    } else if (current !== value) {
      skipped.push(key);
    }
  }
  return { filePath, applied, skipped, unknownKeys };
}

export default applyConfigFile;
