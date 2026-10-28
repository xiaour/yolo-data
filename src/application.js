import { loadConfig } from './config.js';
import { resolveAuthMode, seedDefaultPasswordsAsync } from './auth.js';
import path from 'node:path';
import { createPlatformDatabase, initializePlatformDatabase } from './platformDatabase.js';
import { LocalIndicatorRepository } from './localIndicatorRepository.js';
import { LocalIndicatorService } from './indicatorService.js';
import { createHarness, HarnessFactory } from './harness.js';
import { MetricAgentService } from './agent.js';
import { SessionMemoryStore } from './memory.js';
import { UserMemoryStore } from './userMemory.js';
import { UserMemoryDistiller } from './userMemoryDistiller.js';
import { startMemoryMaintenance } from './userMemoryMaintenance.js';
import { SkillRegistry } from './skills.js';
import { SkillCatalog } from './skillCatalog.js';
import { SemanticCompiler } from './semanticCompiler.js';
import { QueryContractCompiler } from './queryContractCompiler.js';
import { FeedbackService } from './feedback.js';
import { GrowthService } from './growth.js';
import { LlmAuditService } from './llmAudit.js';
import { TokenBudgetService } from './tokenBudget.js';
import { DatasourceCrypto } from './datasourceCrypto.js';
import { BusinessDatasetService } from './businessDatasets.js';
import { configureBusinessLexicon, getPlatformLexicon } from './businessLexicon.js';
import { WorkspaceService } from './workspace.js';
import { SemanticValueRegistry } from './semanticValues.js';
import { CodeExecutionService } from './codeExecution.js';
import { UploadService } from './uploads.js';
import { assertGateCoverage } from './gateRegistry.js';
import { STAGE_DEFINITIONS } from './workflow.js';

export async function ensurePlatformMysqlDatasource({ backend, mysql = {}, businessDatasets }) {
  if (String(backend ?? '').toLowerCase() !== 'mysql'
    || !mysql.host || !mysql.database || !mysql.user) return null;
  const code = 'platform_mysql';
  const existing = await businessDatasets.getDataSourceByCodeAsync(code);
  if (existing) return existing;
  return businessDatasets.saveDataSourceAsync({
    code,
    name: '平台 MySQL 数据源',
    dbType: 'MYSQL',
    host: mysql.host,
    port: mysql.port ?? 3306,
    databaseName: mysql.database,
    username: mysql.user,
    password: mysql.password ?? '',
    status: 1,
    options: { readonly: true, maxRows: 1000, queryTimeoutMs: 20_000 },
  });
}

async function seedConfiguredModel(database, modelConfig) {
  if (!String(modelConfig?.apiKey ?? '').trim() || !String(modelConfig?.model ?? '').trim()) return;
  const isAsync = database.isAsyncPlatformStore === true;
  const models = isAsync ? await database.listModelsAsync() : database.listModels();
  const configured = models.find((model) => (
    model.modelName === modelConfig.model
    && model.baseUrl === modelConfig.baseUrl
    && model.apiKeyEnv === 'API_KEY'
  ));
  const model = configured ?? (isAsync
    ? await database.modelRepository.saveModelAsync({
      name: `${modelConfig.model} (yolo-conf)`,
      provider: 'openai-compatible',
      modelName: modelConfig.model,
      baseUrl: modelConfig.baseUrl,
      apiKeyEnv: 'API_KEY',
      temperature: modelConfig.temperature,
      maxTokens: modelConfig.maxTokens,
      timeoutMs: modelConfig.timeoutMs,
      maxToolRounds: modelConfig.maxToolRounds,
      isDefault: true,
      status: 1,
    })
    : database.saveModel({
      name: `${modelConfig.model} (yolo-conf)`,
      provider: 'openai-compatible',
      modelName: modelConfig.model,
      baseUrl: modelConfig.baseUrl,
      apiKeyEnv: 'API_KEY',
      temperature: modelConfig.temperature,
      maxTokens: modelConfig.maxTokens,
      timeoutMs: modelConfig.timeoutMs,
      maxToolRounds: modelConfig.maxToolRounds,
      isDefault: true,
      status: 1,
    }));
  if (!model) return;

  const themes = isAsync ? await database.listThemesAsync() : database.listThemes();
  for (const theme of themes) {
    if ((theme.modelIds ?? []).length > 0) continue;
    const payload = { ...theme, modelIds: [model.id], defaultModelId: model.id };
    if (isAsync) await database.saveThemeAsync(payload, theme.id);
    else database.saveTheme(payload, theme.id);
  }
}

export async function createApplication(config = loadConfig()) {
  resolveAuthMode(config);
  const platformDatabaseConfig = {
    ...(config.platformDatabase ?? {}),
    backend: config.platformDatabase?.backend ?? 'sqlite',
    // Legacy embedding configs omit the nested block; keep them deterministic.
    // loadConfig() supplies the block for installed deployments.
    seedResources: config.platformDatabase?.seedResources === true,
    // Test/embedding callers historically override dbPath directly. Keep that
    // contract authoritative so the new nested config cannot accidentally
    // reopen the default platform.db.
    path: config.dbPath ?? config.platformDatabase?.path,
  };
  const platformHandle = platformDatabaseConfig.backend === 'mysql'
    ? await initializePlatformDatabase(platformDatabaseConfig)
    : { database: createPlatformDatabase(platformDatabaseConfig), backend: 'sqlite' };
  const database = platformHandle.database;
  const listThemesAsync = () => database.isAsyncPlatformStore
    ? database.listThemesAsync() : Promise.resolve(database.listThemes());
  const saveThemeAsync = (payload, id) => database.isAsyncPlatformStore
    ? database.saveThemeAsync(payload, id) : Promise.resolve(database.saveTheme(payload, id));
  const listSkillsAsync = () => database.isAsyncPlatformStore
    ? database.listSkillsAsync() : Promise.resolve(database.listSkills());
  const countRowsAsync = async (table) => {
    if (!database.isAsyncPlatformStore) return database.countRows(table);
    const [row] = await database.query(`SELECT COUNT(*) AS count FROM ${table}`);
    return Number(row?.count ?? 0);
  };
  const countRowsManyAsync = async (tables) => {
    if (!database.isAsyncPlatformStore) {
      return Object.fromEntries(tables.map((table) => [table, database.countRows(table)]));
    }
    const allowed = new Set([
      'app_users', 'themes', 'conversations', 'chat_sessions', 'chat_messages', 'workspaces',
      'workspace_artifacts', 'artifact_versions', 'audit_logs', 'query_plans', 'qa_feedback',
      'knowledge_gaps', 'llm_call_logs', 'data_sources', 'business_datasets', 'models',
      'dataset_fields', 'theme_semantic_value_domains', 'semantic_value_domains',
    ]);
    const safeTables = tables.filter((table) => allowed.has(table));
    if (safeTables.length === 0) return {};
    const selections = safeTables.map((table) => `(SELECT COUNT(*) FROM ${table}) AS \`${table}\``).join(', ');
    const [row] = await database.query(`SELECT ${selections}`);
    return Object.fromEntries(safeTables.map((table) => [table, Number(row?.[table] ?? 0)]));
  };
  await seedDefaultPasswordsAsync(database);
  await seedConfiguredModel(database, config.deepseek);
  database.localIndicators = new LocalIndicatorRepository(database.db, database);
  const indicatorService = new LocalIndicatorService(database.localIndicators);
  // 业务词表以平台设置为准，首次启动时用仓库配置初始化成可维护的设置项。
  const storedLexicon = database.isAsyncPlatformStore
    ? (await database.getPlatformSettingAsync('business.lexicon', null))?.value ?? null
    : database.getPlatformSetting('business.lexicon', null)?.value ?? null;
  if (!storedLexicon) {
    if (database.isAsyncPlatformStore) {
      await database.savePlatformSettingAsync('business.lexicon', getPlatformLexicon());
    } else {
      database.savePlatformSetting('business.lexicon', getPlatformLexicon());
    }
  }
  configureBusinessLexicon(storedLexicon);
  const harness = createHarness(config.deepseek);
  const llmAudit = new LlmAuditService(database);
  const tokenBudget = new TokenBudgetService(database);
  const datasourceCrypto = new DatasourceCrypto({
    keyFilePath: config.datasourceSecretKeyPath
      ?? path.resolve(config.projectRoot ?? process.cwd(), 'data', '.datasource-key'),
    secretKey: config.datasourceSecretKey,
  });
  if (String(config.deepseek.apiKey ?? '').startsWith('ENC:')) {
    // A deployment may still have an older encrypted key in yolo-conf.yaml.
    // Prefer the plain .env/process credential and only decrypt legacy config
    // when no environment key is available.
    const environmentApiKey = String(
      process.env.API_KEY || process.env.DEEPSEEK_API_KEY || '',
    ).trim();
    config.deepseek.apiKey = environmentApiKey
      || datasourceCrypto.decrypt(config.deepseek.apiKey);
  }
  const businessDatasets = new BusinessDatasetService({
    database,
    crypto: datasourceCrypto,
    config,
  });
  await ensurePlatformMysqlDatasource({
    backend: platformDatabaseConfig.backend,
    mysql: platformDatabaseConfig.mysql,
    businessDatasets,
  });
  const harnessFactory = new HarnessFactory(
    config.deepseek,
    fetch,
    (entry) => llmAudit.record(entry),
    datasourceCrypto,
  );
  const userMemories = new UserMemoryStore(database);
  const memory = new SessionMemoryStore(database, {
    contextLimit: config.chatMemoryMessageLimit,
    userMemories,
  });
  const skillRegistry = new SkillRegistry(database, {
    skillDirectories: config.skillDirectories ?? [],
  });
  const skillCatalog = new SkillCatalog(database);
  const semanticCompiler = new SemanticCompiler();
  const queryContractCompiler = new QueryContractCompiler();
  const growth = new GrowthService(database);
  const feedback = new FeedbackService(database, growth);
  const workspace = new WorkspaceService(database);
  const codeExecution = new CodeExecutionService({ database, workspace, config });
  const uploads = new UploadService({ database, workspace, config });
  const semanticValues = new SemanticValueRegistry(database);
  const agent = new MetricAgentService({
    database,
    harness,
    harnessFactory,
    memory,
    skillRegistry,
    semanticCompiler,
    queryContractCompiler,
    feedback,
    growth,
    businessDatasets,
    workspace,
    codeExecution,
    semanticValues,
    userMemories,
    tokenBudget,
    config,
    indicatorService,
  });
  // 长期记忆沉淀依赖主题可用模型：有 key 时用模型提炼并压缩，否则只沉淀用户显式要求记住的内容。
  const userMemoryConfig = config.userMemory ?? {};
  const userMemoryDistiller = new UserMemoryDistiller({
    store: userMemories,
    resolveHarness: async (themeId) => {
      const theme = database.themeRepository?.getThemeAsync
        ? await database.themeRepository.getThemeAsync(themeId)
        : database.getTheme(themeId);
      return harnessFactory.forTheme(await agent.resolveThemeModel(theme) ?? {});
    },
    autoConsolidateAt: userMemoryConfig.autoConsolidateAt,
    compactRatio: userMemoryConfig.compactRatio,
  });
  memory.attachDistiller(userMemoryDistiller);
  // 后台巡检：周期性把待合并笔记并进文档、压缩过长正文；间隔为 0 时保持关闭。
  const memoryMaintenance = startMemoryMaintenance({
    distiller: userMemoryDistiller,
    intervalMs: userMemoryConfig.maintenanceIntervalMs ?? 0,
    startupDelayMs: userMemoryConfig.maintenanceStartupDelayMs ?? 60_000,
    batchSize: userMemoryConfig.maintenanceBatchSize ?? 20,
    onError: (error, target) => {
      try {
        void database.addAuditLogAsync({
          userId: target?.userId ?? null,
          themeId: target?.themeId ?? null,
          action: 'USER_MEMORY_MAINTENANCE_FAILED',
          detail: { scopeKey: target?.scopeKey ?? null, message: error.message },
        });
      } catch {
        // 审计写入失败不影响后台巡检
      }
    },
  });
  const runtime = {
    sourceMode: 'local',
    sourceError: null,
    skillSync: null,
    indicatorSource: { source: 'LOCAL', freshAt: null, snapshotCount: 0 },
  };

  function resolveIndicatorSource() {
    runtime.indicatorSource = { source: 'LOCAL', freshAt: null, snapshotCount: 0 };
    return runtime.indicatorSource;
  }

  async function init() {
    assertGateCoverage(STAGE_DEFINITIONS.map((stage) => stage.code));
    try {
      runtime.skillSync = await skillRegistry.refreshExternalSkills();
    } catch (error) {
      runtime.skillSync = {
        error: error.message,
        configuredRoots: config.skillDirectories ?? [],
      };
    }
    for (const theme of await listThemesAsync()) {
      const llmConfig = theme.llmConfig ?? {};
      if (Number(llmConfig.deterministicDefaultsVersion) >= 3) {
        continue;
      }
      await saveThemeAsync({
        ...theme,
        llmConfig: {
          ...llmConfig,
          temperature: llmConfig.temperature === undefined
            || Number(llmConfig.temperature) === 0.1
            ? 0
            : Number(llmConfig.temperature),
          maxToolRounds: llmConfig.maxToolRounds === undefined
            || [4, 6, 8].includes(Number(llmConfig.maxToolRounds))
            ? 12
            : Number(llmConfig.maxToolRounds),
          deterministicDefaultsVersion: 3,
        },
      }, theme.id);
    }
    runtime.sourceMode = 'local';
    runtime.sourceError = null;
    try {
      const bootstrapped = await businessDatasets.bootstrap(
        config.bootstrapDatasource ?? {},
      );
      if (bootstrapped?.length) {
        const bootstrappedIds = bootstrapped.map((dataset) => dataset.id);
        for (const theme of await listThemesAsync()) {
          const businessDatasetIds = [...new Set([
            ...(theme.businessDatasetIds ?? []),
            ...bootstrappedIds,
          ])];
          await saveThemeAsync({
            ...theme,
            businessDatasetIds,
            skillCodes: [...new Set([
              ...(theme.skillCodes ?? []),
              'business_dataset_list',
              'business_dataset_query',
            ])],
          }, theme.id);
        }
        for (const user of await database.listUsersAsync()) {
          if (user.role === 'ADMIN') {
            continue;
          }
          for (const datasetId of bootstrappedIds) {
            if (!database.isAsyncPlatformStore) database.grantDatasetAccess(user.id, datasetId, true);
          }
        }
      }
    } catch (error) {
      runtime.sourceError ??= `业务数据集初始化失败：${error.message}`;
    }
    for (const theme of await listThemesAsync()) {
      if ((theme.businessDatasetIds ?? []).length === 0) {
        continue;
      }
      await saveThemeAsync({
        ...theme,
        skillCodes: [...new Set([
          ...(theme.skillCodes ?? []),
          'business_dataset_list',
          'business_dataset_schema',
          'business_dataset_query',
        ])],
      }, theme.id);
    }
    return runtime;
  }

  async function currentHealth() {
    const [models, themes, skills, localIndicatorCount, localIndicatorTypes, counts] = await Promise.all([
      database.modelRepository.listModelsAsync(),
      listThemesAsync(),
      listSkillsAsync(),
      database.localIndicators.countAsync(),
      database.localIndicators.listTypesAsync(),
      countRowsManyAsync([
        'app_users', 'themes', 'conversations', 'chat_sessions', 'chat_messages', 'workspaces',
        'workspace_artifacts', 'artifact_versions', 'audit_logs', 'query_plans', 'qa_feedback',
        'knowledge_gaps', 'llm_call_logs', 'data_sources', 'business_datasets', 'models',
        'dataset_fields', 'theme_semantic_value_domains', 'semantic_value_domains',
      ]),
    ]);
    const indicatorSource = resolveIndicatorSource();
    return {
      status: 'ok',
      now: new Date().toISOString(),
      source: {
        mode: 'local',
        enabled: false,
        configured: false,
        localIndicatorManagement: true,
        localIndicatorCount,
        indicatorSource: indicatorSource.source,
        indicatorSourceDetail: indicatorSource,
        error: runtime.sourceError,
      },
      llm: {
        mode: harness.mode,
        model: harness.mode === 'local-rule' ? null : config.deepseek.model,
        configured: Boolean(config.deepseek.apiKey) && harness.mode !== 'local-rule',
        themeCredentials: themes
          .filter((theme) => (
            Boolean(theme.llmConfig?.apiKeyEncrypted)
            || (theme.modelIds ?? []).some((modelId) => (
              Boolean(models.find((model) => model.id === Number(modelId))?.hasApiKey)
            ))
          ))
          .length,
        capabilities: harness.capabilities ?? {},
      },
      skills: {
        externalCount: skills
          .filter((skill) => skill.source === 'SKILL_MD')
          .length,
        sync: runtime.skillSync,
      },
      memory: memoryMaintenance.stats(),
      counts: {
        users: counts.app_users,
        themes: counts.themes,
        indicators: localIndicatorCount,
        indicatorTypes: localIndicatorTypes.length,
        localIndicators: localIndicatorCount,
        conversations: counts.conversations,
        chatSessions: counts.chat_sessions,
        chatMessages: counts.chat_messages,
        workspaces: counts.workspaces,
        workspaceArtifacts: counts.workspace_artifacts,
        artifactVersions: counts.artifact_versions,
        audits: counts.audit_logs,
        queryPlans: counts.query_plans,
        feedback: counts.qa_feedback,
        knowledgeGaps: counts.knowledge_gaps,
        llmCalls: counts.llm_call_logs,
        dataSources: counts.data_sources,
        businessDatasets: counts.business_datasets,
        models: counts.models,
        datasetFields: counts.dataset_fields,
        semanticValueDomains: counts.theme_semantic_value_domains,
        legacySemanticValueDomains: counts.semantic_value_domains,
      },
    };
  }

  return {
    config,
    database,
    harness,
    memory,
    userMemories,
    userMemoryDistiller,
    memoryMaintenance,
    skillRegistry,
    skillCatalog,
    semanticCompiler,
    queryContractCompiler,
    feedback,
    growth,
    llmAudit,
    datasourceCrypto,
    businessDatasets,
    workspace,
    codeExecution,
    uploads,
    indicatorService,
    harnessFactory,
    agent,
    runtime,
    init,
    resolveIndicatorSource,
    currentHealth,
  };
}
