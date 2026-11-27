import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAuthMode } from './auth.js';
import { resolveBootstrapDatasourceConfig } from './bootstrapDatasourceConfig.js';
import { applyConfigFile } from './configFile.js';
import { loadEnvFile } from './envFile.js';
import { normalizeBaseUrl, parsePathList, readInt } from './envValues.js';
import { projectCodexBin, projectPythonBin } from './runtimeBinaries.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  // 配置面：yolo-conf.yaml 提供结构与默认值；优先级为进程环境变量 > .env > yolo-conf.yaml > 内置默认值。
  // `env === process.env` 是「真实进程」守卫：测试传自定义 env 时不读工作区的 .env 和配置文件。
  if (env === process.env) {
    loadEnvFile({ projectRoot, target: env });
    applyConfigFile({ projectRoot, target: env });
  }
  const nodeEnv = String(env.NODE_ENV ?? '').trim().toLowerCase();
  const authMode = resolveAuthMode({ authMode: env.AUTH_MODE ?? '', nodeEnv });
  const host = String(env.HOST ?? '').trim() || (authMode === 'dev' ? '127.0.0.1' : '0.0.0.0');
  const dbPath = String(env.PLATFORM_DB_PATH ?? './data/platform.db').trim();
  const platformDbBackend = String(
    env.PLATFORM_DB_BACKEND ?? env.DATABASE_BACKEND ?? 'sqlite',
  ).trim().toLowerCase() || 'sqlite';
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
  const codexProvider = String(env.CODEX_PROVIDER ?? 'ollama').trim().toLowerCase() || 'ollama';
  const defaultCodexModel = codexProvider === 'ollama' ? 'gpt-oss:20b' : '';

  return {
    projectRoot,
    port: readInt(env.PORT, 8088),
    host,
    dbPath: path.isAbsolute(dbPath) ? dbPath : path.resolve(projectRoot, dbPath),
    platformDatabase: {
      backend: platformDbBackend,
      path: path.isAbsolute(dbPath) ? dbPath : path.resolve(projectRoot, dbPath),
      // Programmatic/test configs stay isolated by default; the real process
      // config enables install-package resources unless explicitly disabled.
      seedResources: env === process.env
        && String(env.PLATFORM_BOOTSTRAP_RESOURCES ?? 'true').toLowerCase() !== 'false',
      mysql: {
        host: String(env.PLATFORM_DB_HOST ?? '').trim(),
        port: readInt(env.PLATFORM_DB_PORT, 3306),
        database: String(env.PLATFORM_DB_NAME ?? 'yolo_platform').trim(),
        user: String(env.PLATFORM_DB_USER ?? 'yolo').trim(),
        password: String(env.PLATFORM_DB_PASSWORD ?? ''),
        charset: String(env.PLATFORM_DB_CHARSET ?? 'utf8mb4').trim(),
        initialize: String(env.PLATFORM_DB_INIT ?? 'true').toLowerCase() !== 'false',
        initSqlPath: String(env.PLATFORM_DB_INIT_SQL ?? './config/platform/mysql-init.sql').trim(),
      },
    },
    deepseek: {
      // 通用环境变量优先；保留旧变量作为兼容回退。
      baseUrl: normalizeBaseUrl(env.API_BASE_URL || env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1'),
      apiKey: String(env.API_KEY ?? env.DEEPSEEK_API_KEY ?? '').trim(),
      model: String(env.MODEL || env.DEEPSEEK_MODEL || 'deepseek-chat').trim(),
      temperature: Number.isFinite(Number(env.TEMPERATURE ?? env.DEEPSEEK_TEMPERATURE))
        ? Number(env.TEMPERATURE ?? env.DEEPSEEK_TEMPERATURE)
        : 0,
      maxTokens: readInt(env.MAX_TOKENS ?? env.DEEPSEEK_MAX_TOKENS, 0),
      timeoutMs: readInt(env.TIMEOUT_MS ?? env.DEEPSEEK_TIMEOUT_MS, 180_000),
      maxToolRounds: readInt(env.MAX_TOOL_ROUNDS ?? env.DEEPSEEK_MAX_TOOL_ROUNDS, 12),
    },
    chatMemoryMessageLimit: readInt(env.CHAT_MEMORY_MESSAGE_LIMIT, 20),
    // 长期记忆的自动整理：攒够多少条笔记自动合并、正文到预算多少比例自动压缩、
    // 后台巡检间隔（0 表示关闭巡检，只保留每轮问答后的顺带整理）。
    userMemory: {
      autoConsolidateAt: Math.max(1, readInt(env.USER_MEMORY_AUTO_CONSOLIDATE_AT, 8)),
      compactRatio: Math.min(1, Math.max(0.2, Number(env.USER_MEMORY_COMPACT_RATIO ?? 0.8) || 0.8)),
      maintenanceIntervalMs: Math.max(0, readInt(env.USER_MEMORY_MAINTENANCE_INTERVAL_MS, 900_000)),
      maintenanceStartupDelayMs: Math.max(0, readInt(env.USER_MEMORY_MAINTENANCE_STARTUP_DELAY_MS, 60_000)),
      maintenanceBatchSize: Math.max(1, readInt(env.USER_MEMORY_MAINTENANCE_BATCH_SIZE, 20)),
      // 问数前置注入：用当前问题确定性检索用户长期记忆，把命中片段直接注入上下文，
      // 替代「只注入摘要 + 依赖模型主动调 search_user_memory 工具」的弱召回，确保记忆对提问真正生效。
      // 检索走 userMemory.search 的精确/关键词匹配，不引入向量近似，守住平台确定性命根。
      retrieval: {
        preInject: {
          enabled: (env.USER_MEMORY_PREINJECT_ENABLED ?? 'true') !== 'false',
          topN: Math.max(1, readInt(env.USER_MEMORY_PREINJECT_TOPN, 6)),
          maxChars: Math.max(200, readInt(env.USER_MEMORY_PREINJECT_MAXCHARS, 1200)),
        },
      },
    },
    reflection: {
      enabled: (env.REFLECTION_ENABLED ?? 'true') !== 'false',
      maxReplan: Math.max(0, Math.min(3, readInt(env.REFLECTION_MAX_REPLAN, 2))),
      judgeTimeoutMs: Math.max(1_000, readInt(env.REFLECTION_JUDGE_TIMEOUT_MS, 20_000)),
    },
    recovery: {
      // Number of model-led recovery replans after the initial attempt.
      maxAttempts: Math.max(5, Math.min(8, readInt(env.AGENT_RECOVERY_MAX_ATTEMPTS, 5))),
    },
    agentRuntime: {
      defaultMode: ['fast', 'auto', 'deep'].includes(String(env.AGENT_COMPUTE_MODE ?? '').toLowerCase())
        ? String(env.AGENT_COMPUTE_MODE).toLowerCase()
        : 'auto',
      codex: {
        enabled: String(env.CODEX_RUNTIME_ENABLED ?? 'true').toLowerCase() !== 'false',
        command: String(env.CODEX_COMMAND ?? '').trim()
          || projectCodexBin(),
        provider: codexProvider,
        providerBaseUrl: String(env.CODEX_PROVIDER_BASE_URL ?? '').trim().replace(/\/+$/, ''),
        providerApiKey: String(env.CODEX_PROVIDER_API_KEY ?? '').trim(),
        wireApi: String(env.CODEX_WIRE_API ?? 'responses').trim().toLowerCase() || 'responses',
        model: String(env.CODEX_MODEL ?? defaultCodexModel).trim() || defaultCodexModel,
        effort: String(env.CODEX_REASONING_EFFORT ?? 'high').trim() || 'high',
        timeoutMs: Math.max(10_000, readInt(env.CODEX_TIMEOUT_MS, 300_000)),
        workingDirectory: path.resolve(
          projectRoot,
          String(env.CODEX_WORKING_DIRECTORY ?? './data/codex-runtime').trim(),
        ),
      },
    },
    codeExecutionRoot: path.resolve(
      projectRoot,
      String(env.CODE_EXECUTION_ROOT ?? './data/code-runs').trim(),
    ),
    codeExecution: {
      backend: String(env.SANDBOX_BACKEND ?? 'container').trim().toLowerCase(),
      allowUnsafeInprocess: env.SANDBOX_ALLOW_UNSAFE_INPROCESS === 'true',
      image: String(env.SANDBOX_IMAGE ?? 'yolo-data-sandbox:local').trim(),
      seccompProfile: String(env.SANDBOX_SECCOMP ?? '').trim(),
    },
    pythonBin: String(env.PYTHON_BIN ?? '').trim() || projectPythonBin(),
    uploads: {
      maxBytes: Math.max(1, readInt(env.UPLOAD_MAX_BYTES, 8 * 1024 * 1024)),
      maxFilesPerSession: Math.max(1, readInt(env.UPLOAD_MAX_FILES_PER_SESSION, 20)),
      maxTotalBytesPerSession: Math.max(1, readInt(
        env.UPLOAD_MAX_TOTAL_BYTES_PER_SESSION,
        40 * 1024 * 1024,
      )),
      maxTableRows: Math.max(1, readInt(env.UPLOAD_MAX_TABLE_ROWS, 50_000)),
      allowedExtensions: parsePathList(
        env.UPLOAD_ALLOWED_EXTENSIONS,
        ['csv', 'xls', 'xlsx'],
      ),
    },
    nodeEnv,
    authMode,
    sessionTtlHours: Math.max(1, readInt(env.SESSION_TTL_HOURS, 12)),
    secureCookies: String(env.SESSION_COOKIE_SECURE ?? '').toLowerCase() === 'true'
      || nodeEnv === 'production',
    skillDirectories,
    datasourceSecretKey: String(env.DATASOURCE_SECRET_KEY ?? '').trim(),
    datasourceSecretKeyPath: path.resolve(projectRoot, 'data', '.datasource-key'),
    bootstrapDatasource: resolveBootstrapDatasourceConfig(env),
  };
}

export { projectRoot };
