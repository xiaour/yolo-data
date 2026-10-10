import { loadConfig } from './config.js';
import path from 'node:path';
import { PlatformDatabase } from './database.js';
import { LocalIndicatorRepository } from './localIndicatorRepository.js';
import { createHarness, HarnessFactory } from './harness.js';
import {
  createSupersonicIndicatorClient,
  UnavailableIndicatorClient,
} from './indicatorClient.js';
import { MetricAgentService } from './agent.js';
import { SessionMemoryStore } from './memory.js';
import { UserMemoryStore } from './userMemory.js';
import { UserMemoryDistiller } from './userMemoryDistiller.js';
import { startMemoryMaintenance } from './userMemoryMaintenance.js';
import { SkillRegistry } from './skills.js';
import { SemanticCompiler } from './semanticCompiler.js';
import { QueryContractCompiler } from './queryContractCompiler.js';
import { FeedbackService } from './feedback.js';
import { GrowthService } from './growth.js';
import { LlmAuditService } from './llmAudit.js';
import { DatasourceCrypto } from './datasourceCrypto.js';
import { BusinessDatasetService } from './businessDatasets.js';
import { configureBusinessLexicon, getPlatformLexicon } from './businessLexicon.js';
import { WorkspaceService } from './workspace.js';
import { SemanticValueRegistry } from './semanticValues.js';
import { CodeExecutionService } from './codeExecution.js';
import { UploadService } from './uploads.js';
import { describeIndicatorSource } from './indicatorSource.js';
import { assertGateCoverage } from './gateRegistry.js';
import { STAGE_DEFINITIONS } from './workflow.js';

export async function createApplication(
  config = loadConfig(),
  indicatorClientOverride = null,
) {
  const database = new PlatformDatabase(config.dbPath);
  database.localIndicators = new LocalIndicatorRepository(database.db);
  // 业务词表以平台设置为准，首次启动时用仓库配置初始化成可维护的设置项。
  const storedLexicon = database.getPlatformSetting('business.lexicon', null)?.value ?? null;
  if (!storedLexicon) {
    database.savePlatformSetting('business.lexicon', getPlatformLexicon());
  }
  configureBusinessLexicon(storedLexicon);
  const indicatorClient = indicatorClientOverride
    ?? (config.supersonic.baseUrl
      ? createSupersonicIndicatorClient(config.supersonic)
      : new UnavailableIndicatorClient());
  function getSupersonicEnabled() {
    const stored = database.getPlatformSetting('supersonic.enabled', true);
    return Boolean(stored?.value ?? stored);
  }
  const harness = createHarness(config.deepseek);
  const llmAudit = new LlmAuditService(database);
  const datasourceCrypto = new DatasourceCrypto({
    keyFilePath: config.datasourceSecretKeyPath
      ?? path.resolve(config.projectRoot ?? process.cwd(), 'data', '.datasource-key'),
    secretKey: config.datasourceSecretKey,
  });
  const businessDatasets = new BusinessDatasetService({
    database,
    crypto: datasourceCrypto,
    config,
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
  const semanticCompiler = new SemanticCompiler();
  const queryContractCompiler = new QueryContractCompiler();
  const growth = new GrowthService(database);
  const feedback = new FeedbackService(database, growth);
  const workspace = new WorkspaceService(database);
  const codeExecution = new CodeExecutionService({
    database,
    workspace,
    config,
  });
  const uploads = new UploadService({ database, workspace, config });
  const semanticValues = new SemanticValueRegistry(database);
  const agent = new MetricAgentService({
    database,
    indicatorClient,
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
  });
  // 长期记忆沉淀依赖主题可用模型：有 key 时用模型提炼并压缩，否则只沉淀用户显式要求记住的内容。
  const userMemoryConfig = config.userMemory ?? {};
  const userMemoryDistiller = new UserMemoryDistiller({
    store: userMemories,
    resolveHarness: (themeId) => harnessFactory.forTheme(
      agent.resolveThemeModel(database.getTheme(themeId)) ?? {},
    ),
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
        database.addAuditLog({
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
    sourceMode: getSupersonicEnabled()
      ? indicatorClient.mode ?? (config.supersonic.baseUrl ? 'supersonic' : 'unconfigured')
      : 'direct-llm',
    supersonicEnabled: getSupersonicEnabled(),
    sourceError: null,
    lastSyncAt: null,
    lastSyncCount: 0,
    lastTypeCount: 0,
    skillSync: null,
    indicatorSource: { source: 'UNAVAILABLE', freshAt: null, snapshotCount: 0 },
    indicatorSnapshot: { count: 0, freshAt: null, typeCount: 0 },
  };

  function resolveIndicatorSource() {
    const snapshot = database.indicatorCacheStats();
    const live = getSupersonicEnabled()
      && indicatorClient.mode !== 'unconfigured'
      && indicatorClient.mode !== 'unavailable'
      && !runtime.sourceError;
    const local = !getSupersonicEnabled();
    runtime.indicatorSnapshot = snapshot;
    runtime.indicatorSource = describeIndicatorSource({
      live: { available: live },
      local,
      snapshot,
    });
    return runtime.indicatorSource;
  }

  async function syncIndicators({ persist = false } = {}) {
    if (!getSupersonicEnabled()) {
      runtime.sourceMode = 'direct-llm';
      runtime.supersonicEnabled = false;
      runtime.sourceError = null;
      resolveIndicatorSource();
      return {
        disabled: true,
        types: 0,
        indicators: 0,
        source: runtime.indicatorSource,
      };
    }
    try {
      const [types, page] = await Promise.all([
        indicatorClient.listTypes(),
        indicatorClient.listIndicators({ current: 1, pageSize: 500 }),
      ]);
      if (persist) {
        // Snapshot persistence is an explicit management action only; startup
        // must not write to (or clear) the indicator cache.
        const list = page.list ?? [];
        const total = Number(page.total ?? list.length);
        database.syncIndicatorTypes(types ?? []);
        database.syncIndicators(list, { prune: total <= list.length });
      }
      runtime.sourceMode = indicatorClient.mode ?? 'supersonic';
      runtime.supersonicEnabled = true;
      runtime.sourceError = null;
      runtime.lastSyncAt = new Date().toISOString();
      runtime.lastSyncCount = Number(page.total ?? page.list?.length ?? 0);
      runtime.lastTypeCount = types?.length ?? 0;
      resolveIndicatorSource();
      return {
        types: types?.length ?? 0,
        indicators: runtime.lastSyncCount,
        persisted: persist,
        source: runtime.indicatorSource,
      };
    } catch (error) {
      runtime.sourceError = error.message;
      resolveIndicatorSource();
      throw error;
    }
  }

  async function applySupersonicSetting(enabled) {
    const normalized = enabled !== false;
    database.savePlatformSetting('supersonic.enabled', normalized);
    runtime.supersonicEnabled = normalized;
    if (!normalized) {
      runtime.sourceMode = 'direct-llm';
      runtime.sourceError = null;
      return {
        enabled: false,
        sourceMode: runtime.sourceMode,
      };
    }
    try {
      const result = await syncIndicators();
      return {
        enabled: true,
        sourceMode: runtime.sourceMode,
        sync: result,
      };
    } catch (error) {
      runtime.sourceError = `指标平台启用后同步失败：${error.message}`;
      return {
        enabled: true,
        sourceMode: runtime.sourceMode,
        syncError: error.message,
      };
    }
  }

  async function init() {
    assertGateCoverage(STAGE_DEFINITIONS.map((stage) => stage.code));
    try {
      runtime.skillSync = skillRegistry.refreshExternalSkills();
    } catch (error) {
      runtime.skillSync = {
        error: error.message,
        configuredRoots: config.skillDirectories ?? [],
      };
    }
    for (const theme of database.listThemes()) {
      const llmConfig = theme.llmConfig ?? {};
      if (Number(llmConfig.deterministicDefaultsVersion) >= 3) {
        continue;
      }
      database.saveTheme({
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
    try {
      if (getSupersonicEnabled()) {
        await syncIndicators();
      } else {
        runtime.sourceMode = 'direct-llm';
        runtime.supersonicEnabled = false;
        runtime.sourceError = null;
      }
    } catch (error) {
      runtime.sourceError = getSupersonicEnabled()
        ? `指标平台初始化失败：${error.message}`
        : error.message;
    }
    try {
      const bootstrapped = await businessDatasets.bootstrap(
        config.bootstrapDatasource ?? {},
      );
      if (bootstrapped?.length) {
        const bootstrappedIds = bootstrapped.map((dataset) => dataset.id);
        for (const theme of database.listThemes()) {
          const businessDatasetIds = [...new Set([
            ...(theme.businessDatasetIds ?? []),
            ...bootstrappedIds,
          ])];
          database.saveTheme({
            ...theme,
            businessDatasetIds,
            skillCodes: [...new Set([
              ...(theme.skillCodes ?? []),
              'business_dataset_list',
              'business_dataset_query',
            ])],
          }, theme.id);
        }
        for (const user of database.listUsers()) {
          if (user.role === 'ADMIN') {
            continue;
          }
          for (const datasetId of bootstrappedIds) {
            database.grantDatasetAccess(user.id, datasetId, true);
          }
        }
      }
    } catch (error) {
      runtime.sourceError ??= `业务数据集初始化失败：${error.message}`;
    }
    for (const theme of database.listThemes()) {
      if ((theme.businessDatasetIds ?? []).length === 0) {
        continue;
      }
      database.saveTheme({
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

  function currentHealth() {
    runtime.supersonicEnabled = getSupersonicEnabled();
    if (!runtime.supersonicEnabled) {
      runtime.sourceMode = 'direct-llm';
    }
    const indicatorSource = resolveIndicatorSource();
    return {
      status: 'ok',
      now: new Date().toISOString(),
      source: {
        mode: runtime.sourceMode,
        enabled: runtime.supersonicEnabled,
        configured: runtime.supersonicEnabled && runtime.sourceMode === 'supersonic',
        localIndicatorManagement: !runtime.supersonicEnabled,
        localIndicatorCount: database.localIndicators.count(),
        indicatorSource: indicatorSource.source,
        indicatorSourceDetail: indicatorSource,
        snapshot: runtime.indicatorSnapshot,
        baseUrl: config.supersonic.baseUrl || null,
        lastSyncAt: runtime.lastSyncAt,
        lastSyncCount: runtime.lastSyncCount,
        error: runtime.sourceError,
      },
      llm: {
        mode: harness.mode,
        model: harness.mode === 'local-rule' ? null : config.deepseek.model,
        configured: Boolean(config.deepseek.apiKey) && harness.mode !== 'local-rule',
        themeCredentials: database.listThemes()
          .filter((theme) => (
            Boolean(theme.llmConfig?.apiKeyEncrypted)
            || (theme.modelIds ?? []).some((modelId) => (
              Boolean(database.getModel(modelId)?.hasApiKey)
            ))
          ))
          .length,
        capabilities: harness.capabilities ?? {},
      },
      skills: {
        externalCount: database.listSkills()
          .filter((skill) => skill.source === 'SKILL_MD')
          .length,
        sync: runtime.skillSync,
      },
      memory: memoryMaintenance.stats(),
      counts: {
        users: database.countRows('app_users'),
        themes: database.countRows('themes'),
        indicators: runtime.supersonicEnabled
          ? runtime.lastSyncCount
          : database.localIndicators.count(),
        indicatorTypes: runtime.supersonicEnabled
          ? runtime.lastTypeCount
          : database.localIndicators.listTypes().length,
        localIndicators: database.localIndicators.count(),
        conversations: database.countRows('conversations'),
        chatSessions: database.countRows('chat_sessions'),
        chatMessages: database.countRows('chat_messages'),
        workspaces: database.countRows('workspaces'),
        workspaceArtifacts: database.countRows('workspace_artifacts'),
        artifactVersions: database.countRows('artifact_versions'),
        audits: database.countRows('audit_logs'),
        queryPlans: database.countRows('query_plans'),
        feedback: database.countRows('qa_feedback'),
        knowledgeGaps: database.countRows('knowledge_gaps'),
        llmCalls: database.countRows('llm_call_logs'),
        dataSources: database.countRows('data_sources'),
        businessDatasets: database.countRows('business_datasets'),
        models: database.countRows('models'),
        datasetFields: database.countRows('dataset_fields'),
        semanticValueDomains: database.countRows('theme_semantic_value_domains'),
        legacySemanticValueDomains: database.countRows('semantic_value_domains'),
      },
    };
  }

  return {
    config,
    database,
    indicatorClient,
    harness,
    memory,
    userMemories,
    userMemoryDistiller,
    memoryMaintenance,
    skillRegistry,
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
    harnessFactory,
    agent,
    runtime,
    init,
    syncIndicators,
    resolveIndicatorSource,
    applySupersonicSetting,
    getSupersonicEnabled,
    currentHealth,
  };
}
