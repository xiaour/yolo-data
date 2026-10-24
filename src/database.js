import { WorkspaceRepository } from './workspaceRepository.js';
import { PlatformLogRepository } from './platformLogRepository.js';
import { SkillRepository } from './skillRepository.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { currentTraceId } from './trace.js';
import { CONTRACT_COMPILER_VERSION } from './contractVersion.js';
import { normalizeSemanticPolicy } from './semanticPolicy.js';
import { mergeThemeSemanticPolicy } from './themeSemanticRules.js';
import {
  mergeValueCandidates, normalizeValueOrigin, VALUE_DOMAIN_STATUSES,
} from './semanticDomain.js';
import { ModelRepository } from './modelRepository.js';
import { UserRepository } from './userRepository.js';
import { DataSourceRepository } from './dataSourceRepository.js';
import { ThemeRepository } from './themeRepository.js';
import { PermissionRepository } from './permissionRepository.js';
import { saveDataSourceTest } from './datasourceConnectionTest.js';
import { attachKnexPlatformStore, createKnexPlatformStore } from './knexPlatformStore.js';
function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function asJson(value) {
  return JSON.stringify(value ?? []);
}

function asBool(value) {
  return value === 1 || value === true;
}

const USER_ROLES = new Set(['ADMIN', 'ANALYST']);

// 平台只区分管理员和分析员两种角色，无法识别的角色一律按最低权限处理。
function normalizeUserRole(value) {
  const role = String(value ?? '').trim().toUpperCase();
  return USER_ROLES.has(role) ? role : 'ANALYST';
}

function loadBootstrapConfig() {
  const configPath = new URL('../config/bootstrap/default.json', import.meta.url);
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {
      users: [],
      themes: [],
      themeGrants: [],
      rowPolicies: [],
    };
  }
}

function normalizeSourceIdList(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  )];
}

function sanitizeSemanticValueConfig(config, {
  indicatorIds = [],
  businessDatasetIds = [],
} = {}) {
  const source = config && typeof config === 'object' ? config : {};
  const fieldConfig = source.fields && typeof source.fields === 'object'
    ? source.fields
    : {};
  const indicatorIdSet = new Set(normalizeSourceIdList(indicatorIds));
  const businessDatasetIdSet = new Set(normalizeSourceIdList(businessDatasetIds));
  const fields = {};

  for (const [key, value] of Object.entries(fieldConfig)) {
    const [sourceType, sourceId, ...fieldParts] = String(key).split(':');
    const fieldName = fieldParts.join(':');
    if (!sourceType || !sourceId || !fieldName) {
      continue;
    }
    const normalizedSourceType = sourceType.toUpperCase();
    const allowed = normalizedSourceType === 'INDICATOR'
      ? indicatorIdSet.size === 0 || indicatorIdSet.has(sourceId)
      : normalizedSourceType === 'DATASET'
        ? businessDatasetIdSet.size === 0 || businessDatasetIdSet.has(sourceId)
        : false;
    if (allowed) {
      fields[key] = value === false
        ? false
        : value === true
          ? true
          : value && typeof value === 'object'
            ? JSON.parse(JSON.stringify(value))
            : true;
    }
  }

  return {
    ...source,
    fields,
  };
}

function requireRecordId(value, label) {
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`${label} is required`);
  }
  return id;
}
export class PlatformDatabase {
  constructor(filePath, {
    seedBootstrapResources = false,
    initSqlPath = path.resolve('config/platform/sqlite-init.sql'),
  } = {}) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.isInMemory = filePath === ':memory:';
    this.initSqlPath = initSqlPath;
    this.db = new DatabaseSync(filePath);
    attachKnexPlatformStore(this, createKnexPlatformStore({ backend: 'sqlite', path: filePath }));
    this.workspaceRepository = new WorkspaceRepository(this.db);
    this.logRepository = new PlatformLogRepository(this.db, filePath === ':memory:' ? null : this);
    this.skillRepository = new SkillRepository(this.db, this);
    this.modelRepository = new ModelRepository(this.db, this);
    this.userRepository = new UserRepository(this.db, this);
    this.dataSourceRepository = new DataSourceRepository(this.db, this);
    this.themeRepository = new ThemeRepository(this);
    this.permissionRepository = new PermissionRepository(this);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
    this.seed({ seedBootstrapResources });
    this.migrateThemeIndicatorRelations();
    this.migrateThemeSemanticValueDomains();
    this.migrateThemeSemanticValueSources();
    this.migrateSemanticValueGovernanceV1();
    this.migrateSkillDefinitions();
  }

  migrate() {
    this.db.exec(fs.readFileSync(this.initSqlPath, 'utf8'));
    this.applySqlMigrations(path.join(path.dirname(this.initSqlPath), 'sqlite-migrations'));
  }

  applySqlMigrations(directory) {
    if (!fs.existsSync(directory)) return;
    const files = fs.readdirSync(directory)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const name of files) {
      const key = name.replace(/\.sql$/i, '');
      const applied = this.db.prepare(
        'SELECT 1 FROM schema_migrations WHERE key = ?',
      ).get(key);
      if (applied) continue;

      const source = fs.readFileSync(path.join(directory, name), 'utf8');
      const statements = source.split(/^\s*--\s*STATEMENT\s*$/m)
        .map((statement) => statement.replace(/^\s*--.*$/gm, '').trim())
        .filter(Boolean);
      this.db.exec('BEGIN');
      try {
        for (const statement of statements) {
          const addColumn = statement.match(
            /^ALTER\s+TABLE\s+([\w]+)\s+ADD\s+COLUMN\s+([\w]+)/i,
          );
          if (addColumn) {
            const [, table, column] = addColumn;
            const exists = this.db.prepare(`PRAGMA table_info(${table})`).all()
              .some((item) => item.name === column);
            if (exists) continue;
          }
          this.db.exec(statement);
        }
        this.db.prepare(
          'INSERT INTO schema_migrations (key, applied_at) VALUES (?, ?)',
        ).run(key, nowIso());
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  migrateThemeIndicatorRelations() {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO theme_indicators (theme_id, indicator_id, created_at)
      VALUES (?, ?, ?)
    `);
    for (const theme of this.db.prepare(
      'SELECT id, indicator_ids_json AS indicatorIdsJson FROM themes',
    ).all()) {
      for (const indicatorId of parseJson(theme.indicatorIdsJson, [])) {
        const value = String(indicatorId ?? '').trim();
        if (value) insert.run(Number(theme.id), value, nowIso());
      }
    }
  }

  seed({ seedBootstrapResources = false } = {}) {
    const timestamp = nowIso();
    const bootstrap = loadBootstrapConfig();
    const insertUser = this.db.prepare(`
      INSERT OR IGNORE INTO app_users
        (username, display_name, role, status, attributes_json, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
    `);
    for (const user of bootstrap.users ?? []) {
      insertUser.run(
        String(user.username ?? '').trim(),
        String(user.displayName ?? user.username ?? '').trim(),
        normalizeUserRole(user.role),
        asJson(user.attributes ?? {}),
        timestamp,
        timestamp,
      );
    }

    const insertTheme = this.db.prepare(`
      INSERT OR IGNORE INTO themes
        (name, description, system_prompt, indicator_ids_json, allowed_dimensions_json,
         default_chart, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    for (const theme of bootstrap.themes ?? []) {
      insertTheme.run(
        String(theme.name ?? '').trim(),
        String(theme.description ?? '').trim(),
        String(theme.systemPrompt ?? '').trim(),
        asJson(theme.indicatorIds ?? []),
        asJson(theme.allowedDimensions ?? []),
        String(theme.defaultChart ?? 'auto'),
        timestamp,
        timestamp,
      );
    }

    const themes = this.listThemes();
    const grantTheme = this.db.prepare(`
      INSERT OR IGNORE INTO user_theme_grants
        (user_id, theme_id, can_query, can_manage)
      VALUES (?, ?, 1, ?)
    `);
    for (const grant of bootstrap.themeGrants ?? []) {
      const user = this.getUserByUsername(grant.username);
      const theme = themes.find((item) => item.name === grant.theme);
      if (user && theme) {
        grantTheme.run(user.id, theme.id, grant.canManage ? 1 : 0);
      }
    }

    this.seedSkills(themes);
    if (seedBootstrapResources) {
      this.seedBootstrapResources(bootstrap);
    }

    const rowPolicyCount = this.db.prepare('SELECT COUNT(*) AS count FROM row_policies').get().count;
    if (rowPolicyCount === 0) {
      for (const policy of bootstrap.rowPolicies ?? []) {
        const user = this.getUserByUsername(policy.username);
        if (!user) {
          continue;
        }
        this.createRowPolicy({
          userId: user.id,
          themeId: policy.theme ? themes.find((theme) => theme.name === policy.theme)?.id : null,
          dimension: policy.dimension,
          operator: policy.operator ?? 'IN',
          values: policy.values ?? [],
          valueSource: policy.valueSource ?? 'FIXED',
          enabled: policy.enabled !== false,
        });
      }
    }
  }

  seedBootstrapResources(bootstrap = {}) {
    const timestamp = nowIso();
    const models = Array.isArray(bootstrap.models) ? bootstrap.models : [];
    const insertModel = this.db.prepare(`
      INSERT OR IGNORE INTO models
        (name, provider, model_name, base_url, api_key_env,
         temperature, max_tokens, timeout_ms, max_tool_rounds,
         is_default, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const model of models) {
      const name = String(model.name ?? '').trim();
      const modelName = String(model.modelName ?? model.model ?? '').trim();
      if (!name || !modelName) continue;
      insertModel.run(
        name,
        String(model.provider ?? 'deepseek').trim().toLowerCase(),
        modelName,
        String(model.baseUrl ?? '').trim(),
        String(model.apiKeyEnv ?? '').trim(),
        Number(model.temperature ?? 0),
        Math.max(0, Number(model.maxTokens ?? 0) || 0),
        Math.max(1000, Number(model.timeoutMs ?? 60000) || 60000),
        Math.max(1, Number(model.maxToolRounds ?? 12) || 12),
        model.isDefault === true ? 1 : 0,
        Number(model.status ?? 1),
        timestamp,
        timestamp,
      );
    }

    const dataSources = Array.isArray(bootstrap.dataSources) ? bootstrap.dataSources : [];
    for (const source of dataSources) {
      const code = String(source.code ?? '').trim();
      if (!code || this.getDataSourceByCode(code)) continue;
      this.saveDataSource({
        code,
        name: String(source.name ?? code).trim(),
        dbType: source.dbType,
        host: source.host,
        port: source.port,
        databaseName: source.databaseName,
        username: source.username,
        encryptedPassword: source.encryptedPassword ?? '',
        options: source.options ?? {},
        status: source.status ?? 0,
      });
    }

    const datasets = Array.isArray(bootstrap.businessDatasets)
      ? bootstrap.businessDatasets
      : [];
    for (const definition of datasets) {
      const code = String(definition.code ?? '').trim();
      if (!code || this.getBusinessDatasetByCode(code)) continue;
      const source = this.getDataSourceByCode(definition.datasourceCode);
      if (!source) continue;
      const dataset = this.saveBusinessDataset({
        code,
        name: String(definition.name ?? code).trim(),
        description: String(definition.description ?? '').trim(),
        datasourceId: source.id,
        schemaName: String(definition.schemaName ?? '').trim(),
        primaryTable: String(definition.primaryTable ?? '').trim(),
        config: definition.config ?? {},
        status: definition.status ?? 0,
      });
      if (Array.isArray(definition.fields) && definition.fields.length > 0) {
        this.replaceDatasetFields(dataset.id, definition.fields);
      }
    }
  }

  migrateThemeSemanticValueDomains() {
    const migrationKey = 'theme_semantic_value_domains_v2';
    const applied = this.db.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE key = ?
    `).get(migrationKey).count > 0;
    if (applied) {
      return;
    }
    const hasLegacyTable = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name = 'semantic_value_domains'
    `).get().count > 0;
    const legacyRows = hasLegacyTable
      ? this.db.prepare(`
        SELECT source_type AS sourceType, source_id AS sourceId,
               field_name AS fieldName, display_name AS displayName,
               value, normalized_value AS normalizedValue,
               aliases_json AS aliasesJson, description, source,
               confidence, enabled, created_at AS createdAt,
               updated_at AS updatedAt
        FROM semantic_value_domains
        ORDER BY id
      `).all()
      : [];
    if (legacyRows.length > 0) {
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO theme_semantic_value_domains
          (theme_id, source_type, source_id, field_name, display_name, value,
           normalized_value, aliases_json, description, source, confidence,
           enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.db.exec('BEGIN');
      try {
        for (const theme of this.listThemes()) {
          for (const row of legacyRows) {
            const sourceId = String(row.sourceId ?? '');
            const matchesIndicator = row.sourceType === 'INDICATOR' && (
              (theme.indicatorIds ?? []).length === 0
              || (theme.indicatorIds ?? []).map(String).includes(sourceId)
            );
            const matchesDataset = row.sourceType === 'DATASET' && (
              (theme.businessDatasetIds ?? []).length === 0
              || (theme.businessDatasetIds ?? []).map(Number).includes(Number(sourceId))
            );
            if (!matchesIndicator && !matchesDataset) {
              continue;
            }
            insert.run(
              Number(theme.id),
              String(row.sourceType),
              sourceId,
              String(row.fieldName),
              String(row.displayName ?? ''),
              String(row.value),
              String(row.normalizedValue),
              String(row.aliasesJson ?? '[]'),
              String(row.description ?? ''),
              String(row.source ?? 'DESCRIPTION'),
              Number(row.confidence ?? 1),
              Number(row.enabled ?? 1),
              String(row.createdAt ?? nowIso()),
              String(row.updatedAt ?? nowIso()),
            );
          }
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }

    const listThemeDomains = this.db.prepare(`
      SELECT DISTINCT source_type AS sourceType, source_id AS sourceId,
             field_name AS fieldName
      FROM theme_semantic_value_domains
      WHERE theme_id = ?
    `);
    for (const theme of this.listThemes()) {
      const current = theme.semanticValueConfig ?? {};
      const fields = {
        ...(current.fields && typeof current.fields === 'object'
          ? current.fields
          : {}),
      };
      for (const row of listThemeDomains.all(Number(theme.id))) {
        const sourceType = String(row.sourceType ?? '').toUpperCase();
        const key = `${sourceType}:${String(row.sourceId ?? '')}:${String(row.fieldName ?? '')}`;
        if (!Object.prototype.hasOwnProperty.call(fields, key)) {
          fields[key] = true;
        }
      }
      this.saveTheme({
        ...theme,
        semanticValueConfig: {
          ...current,
          enabled: current.enabled !== false,
          autoDiscover: current.autoDiscover !== false,
          fields,
        },
      }, theme.id);
    }
    this.db.prepare(`
      INSERT INTO schema_migrations (key, applied_at) VALUES (?, ?)
    `).run(migrationKey, nowIso());
  }

  migrateThemeSemanticValueSources() {
    const migrationKey = 'theme_semantic_value_sources_v3';
    const applied = this.db.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE key = ?
    `).get(migrationKey).count > 0;
    if (applied) {
      return;
    }

    const updateConfig = this.db.prepare(`
      UPDATE themes
      SET semantic_value_config_json = ?, updated_at = ?
      WHERE id = ?
    `);
    this.db.exec('BEGIN');
    try {
      for (const theme of this.listThemes()) {
        const indicatorIds = normalizeSourceIdList(theme.indicatorIds);
        const businessDatasetIds = normalizeSourceIdList(theme.businessDatasetIds);
        const semanticValueConfig = sanitizeSemanticValueConfig(
          theme.semanticValueConfig,
          { indicatorIds, businessDatasetIds },
        );
        if (
          JSON.stringify(theme.semanticValueConfig ?? {})
          !== JSON.stringify(semanticValueConfig)
        ) {
          updateConfig.run(
            asJson(semanticValueConfig),
            nowIso(),
            Number(theme.id),
          );
        }
        if (businessDatasetIds.length > 0) {
          this.pruneSemanticValueDomainsBySource({
            themeId: Number(theme.id),
            sourceType: 'DATASET',
            allowedSourceIds: businessDatasetIds,
          });
        }
        if (indicatorIds.length > 0) {
          this.pruneSemanticValueDomainsBySource({
            themeId: Number(theme.id),
            sourceType: 'INDICATOR',
            allowedSourceIds: indicatorIds,
          });
        }
      }
      this.db.prepare(`
        INSERT INTO schema_migrations (key, applied_at) VALUES (?, ?)
      `).run(migrationKey, nowIso());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  migrateSemanticValueGovernanceV1() {
    const migrationKey = 'semantic_value_governance_v1';
    const applied = this.db.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE key = ?
    `).get(migrationKey).count > 0;
    if (applied) {
      return;
    }

    const groups = this.db.prepare(`
      SELECT theme_id AS themeId, source_type AS sourceType,
             source_id AS sourceId, field_name AS fieldName,
             display_name AS displayName
      FROM theme_semantic_value_domains
      GROUP BY theme_id, source_type, source_id, field_name, display_name
    `).all();
    const itemsByGroup = this.db.prepare(`
      SELECT value, aliases_json AS aliasesJson, source, confidence,
             created_at AS createdAt
      FROM theme_semantic_value_domains
      WHERE theme_id = ? AND source_type = ? AND source_id = ?
        AND field_name = ? AND display_name = ?
      ORDER BY id
    `);
    const insertSnapshot = this.db.prepare(`
      INSERT INTO semantic_value_snapshots
        (theme_id, source_type, source_id, field_name, display_name, version,
         status, origin_mask_json, value_count, sample_size, checksum,
         scope_signature, schema_hash, error_message, refreshed_at,
         expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertItem = this.db.prepare(`
      INSERT INTO semantic_value_snapshot_items
        (snapshot_id, value, normalized_value, aliases_json, origin,
         origin_ref, confidence, enabled, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);

    this.db.exec('BEGIN');
    try {
      for (const group of groups) {
        const rows = itemsByGroup.all(
          Number(group.themeId),
          String(group.sourceType),
          String(group.sourceId),
          String(group.fieldName),
          String(group.displayName ?? ''),
        );
        const candidates = rows
          .map((row) => {
            const origin = normalizeValueOrigin(
              row.source,
              String(group.sourceType),
            );
            if (!origin) {
              return null;
            }
            return {
              value: String(row.value ?? ''),
              aliases: parseJson(row.aliasesJson, []),
              origin,
              originRef: 'legacy-theme-domain',
              confidence: Number(row.confidence ?? 1),
              firstSeenAt: String(row.createdAt ?? nowIso()),
            };
          })
          .filter(Boolean);
        const merged = mergeValueCandidates([candidates]);
        const origins = [...new Set(merged.map((item) => item.origin))];
        const hasSourceValues = origins.includes('DORIS_DISTINCT');
        const status = merged.length === 0
          ? VALUE_DOMAIN_STATUSES.UNKNOWN
          : hasSourceValues
            ? VALUE_DOMAIN_STATUSES.COMPLETE
            : VALUE_DOMAIN_STATUSES.PARTIAL;
        const checksum = merged.length > 0
          ? crypto
            .createHash('sha256')
            .update(JSON.stringify(merged.map((item) => item.value).sort()))
            .digest('hex')
          : '';
        const timestamp = nowIso();
        const result = insertSnapshot.run(
          Number(group.themeId),
          String(group.sourceType),
          String(group.sourceId),
          String(group.fieldName),
          String(group.displayName ?? ''),
          1,
          status,
          asJson(origins),
          merged.length,
          hasSourceValues ? merged.length : 0,
          checksum,
          '',
          'legacy-v1',
          '',
          timestamp,
          null,
          timestamp,
          timestamp,
        );
        const snapshotId = Number(result.lastInsertRowid);
        for (const item of merged) {
          insertItem.run(
            snapshotId,
            item.value,
            item.value.toLowerCase().replace(/\s+/g, ''),
            asJson(item.aliases ?? []),
            item.origin,
            item.originRef ?? '',
            Number(item.confidence ?? 1),
            String(item.firstSeenAt ?? timestamp),
            timestamp,
          );
        }
      }
      this.db.prepare(`
        INSERT INTO schema_migrations (key, applied_at) VALUES (?, ?)
      `).run(migrationKey, nowIso());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  migrateSkillDefinitions() {
    const migrationKey = 'skills_dimension_breakdown_v2';
    const applied = this.db.prepare(`
      SELECT COUNT(*) AS count FROM schema_migrations WHERE key = ?
    `).get(migrationKey).count > 0;
    if (applied) {
      return;
    }
    this.db.prepare(`
      UPDATE skills
      SET name = ?, description = ?, instruction = ?, updated_at = ?
      WHERE code = 'dimension_breakdown'
    `).run(
      '维度拆解与分别分析',
      '识别分类维度和枚举值，按维度分组并分别输出各项指标',
      '出现“分别、各自、分开、各是”等拆分语义，且多个值属于同一分类字段时，必须把该字段作为 GROUP BY 维度；如需限定枚举范围，可同时保留 IN 过滤，禁止只做过滤后汇总。涉及对比、排名、拆解时，选择与业务问题最相关的分类维度。',
      nowIso(),
    );
    this.db.prepare(`
      INSERT INTO schema_migrations (key, applied_at) VALUES (?, ?)
    `).run(migrationKey, nowIso());
  }

  seedSkills(themes) {
    const timestamp = nowIso();
    const insertSkill = this.db.prepare(`
      INSERT OR IGNORE INTO skills
        (code, name, description, category, kind, tool_name, instruction,
         default_enabled, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    const definitions = [
      {
        code: 'yolo-core-skill.temporal_expression',
        name: '时间表达式解析',
        description: '把自然语言中的日期范围和时间周期解析为结构化时间条件',
        category: 'CORE',
        kind: 'RESOLVER',
        toolName: null,
        instruction: '优先将自然语言日期、周期和时间范围转换为结构化时间条件。',
      },
      {
        code: 'yolo-core-skill.business_vocabulary',
        name: '业务词汇解析',
        description: '解析中文时间粒度、排名数量和常用业务表达为结构化意图',
        category: 'CORE',
        kind: 'RESOLVER',
        toolName: null,
        instruction: '将中文业务表达解析为结构化意图，避免在 Agent 工作流中散落正则。',
      },
      {
        code: 'indicator_search',
        name: '指标检索',
        description: '根据业务问题检索当前主题下的可用指标',
        category: 'CORE',
        kind: 'TOOL',
        toolName: 'search_indicators',
        instruction: '先检索与问题最相关的指标，再决定后续查询。',
      },
      {
        code: 'indicator_definition',
        name: '指标口径',
        description: '读取指标业务口径、指标业务名和可用维度',
        category: 'CORE',
        kind: 'TOOL',
        toolName: 'get_indicator',
        instruction: '执行查询前读取指标定义，确认指标和维度业务名。',
      },
      {
        code: 'indicator_query',
        name: '指标查询',
        description: '通过语义层执行指标聚合查询',
        category: 'CORE',
        kind: 'TOOL',
        toolName: 'query_indicator',
        instruction: '只通过 query_indicator 执行语义指标查询。',
      },
      {
        code: 'trend_analysis',
        name: '趋势分析',
        description: '识别时间趋势并优先使用日期维度和折线图',
        category: 'ANALYSIS',
        kind: 'INSTRUCTION',
        toolName: null,
        instruction: '涉及趋势、变化、走势时，优先使用 date 维度并解释变化方向。',
      },
      {
        code: 'dimension_breakdown',
        name: '维度拆解与分别分析',
        description: '识别分类维度和枚举值，按维度分组并分别输出各项指标',
        category: 'ANALYSIS',
        kind: 'INSTRUCTION',
        toolName: null,
        instruction: '出现“分别、各自、分开、各是”等拆分语义，且多个值属于同一分类字段时，必须把该字段作为 GROUP BY 维度；如需限定枚举范围，可同时保留 IN 过滤，禁止只做过滤后汇总。涉及对比、排名、拆解时，选择与业务问题最相关的分类维度。',
      },
      {
        code: 'period_comparison',
        name: '周期对比',
        description: '处理同比、环比、上期和区间对比问题',
        category: 'ANALYSIS',
        kind: 'INSTRUCTION',
        toolName: null,
        instruction: '涉及同比、环比或上期对比时，先明确两个统计周期，再执行查询。',
      },
      {
        code: 'contribution_analysis',
        name: '贡献分析',
        description: '识别总量变化中的主要贡献维度',
        category: 'ANALYSIS',
        kind: 'INSTRUCTION',
        toolName: null,
        instruction: '涉及贡献、拉动、影响来源时，优先按业务维度拆解并指出主要贡献项。',
      },
      {
        code: 'anomaly_detection',
        name: '异常检测',
        description: '识别异常波动并给出需要继续排查的方向',
        category: 'ANALYSIS',
        kind: 'INSTRUCTION',
        toolName: null,
        instruction: '观察到异常波动时，说明异常时间点或分类，并给出下一步拆解方向。',
      },
      {
        code: 'business_dataset_list',
        name: '业务数据集发现',
        description: '列出当前主题和用户可访问的业务数据集',
        category: 'DATA',
        kind: 'TOOL',
        toolName: 'list_business_datasets',
        instruction: '需要明细、事实或宽表分析时，先查看可访问的业务数据集。',
      },
      {
        code: 'business_dataset_query',
        name: '业务数据集查询',
        description: '通过受控语义字段查询已授权业务数据集',
        category: 'DATA',
        kind: 'TOOL',
        toolName: 'query_business_dataset',
        instruction: '只使用数据集字段业务名生成聚合查询，不得生成或传递原始 SQL。',
      },
      {
        code: 'business_dataset_schema',
        name: '业务字段口径确认',
        description: '读取业务数据集字段角色、类型、聚合方式和可用过滤操作符',
        category: 'DATA',
        kind: 'TOOL',
        toolName: 'get_business_dataset_definition',
        instruction: '执行业务数据集查询前，必须确认目标数据集字段口径。',
      },
    ];

    this.db.exec('BEGIN');
    try {
      for (const skill of definitions) {
        insertSkill.run(
          skill.code,
          skill.name,
          skill.description,
          skill.category,
          skill.kind,
          skill.toolName,
          skill.instruction,
          skill.defaultEnabled === false ? 0 : 1,
          timestamp,
          timestamp,
        );
      }

      const insertThemeSkill = this.db.prepare(`
        INSERT OR IGNORE INTO theme_skills
          (theme_id, skill_code, enabled, config_json)
        VALUES (?, ?, 1, '{}')
      `);
      const countThemeSkills = this.db.prepare(`
        SELECT COUNT(*) AS count FROM theme_skills WHERE theme_id = ?
      `);
      const skillCodesByTheme = Object.fromEntries(
        (loadBootstrapConfig().themes ?? []).map((theme) => [
          String(theme.name ?? ''),
          Array.isArray(theme.skillCodes) ? theme.skillCodes : [],
        ]),
      );
      for (const theme of themes) {
        if (countThemeSkills.get(Number(theme.id)).count > 0) {
          continue;
        }
        const skillCodes = skillCodesByTheme[theme.name]
          ?? definitions.map((skill) => skill.code);
        for (const skillCode of skillCodes) {
          insertThemeSkill.run(Number(theme.id), skillCode);
        }
      }
      // Backfill newly introduced core Skills for existing themes after the
      // normal default binding has run. INSERT OR IGNORE preserves an explicit
      // disabled assignment.
      const coreSkillCodes = definitions
        .filter((skill) => skill.category === 'CORE')
        .map((skill) => skill.code);
      for (const theme of themes) {
        for (const skillCode of coreSkillCodes) {
          insertThemeSkill.run(Number(theme.id), skillCode);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db.close();
    void this.knexStore.close();
  }

  async closeAsync() {
    this.db.close();
    await this.knexStore.close();
  }

  listUsers() {
    return this.userRepository.listUsers();
  }

  getUser(id) {
    return this.userRepository.getUser(id);
  }

  getUserByUsername(username) {
    return this.userRepository.getUserByUsername(username);
  }

  saveUser(payload, id = null) {
    return this.userRepository.saveUser(payload, id);
  }

  listModels() {
    return this.modelRepository.listModels();
  }

  getModel(id) {
    return this.modelRepository.getModel(id);
  }

  saveModel(payload, id = null) {
    return this.modelRepository.saveModel(payload, id);
  }

  setModelDefault(id) {
    return this.modelRepository.setModelDefault(id);
  }

  deleteModel(id) {
    return this.modelRepository.deleteModel(id);
  }

  listThemes() {
    return this.db.prepare(`
      SELECT id, name, description, system_prompt AS systemPrompt,
             indicator_ids_json AS indicatorIdsJson,
             allowed_dimensions_json AS allowedDimensionsJson,
             llm_config_json AS llmConfigJson,
             dataset_ids_json AS datasetIdsJson,
             business_dataset_ids_json AS businessDatasetIdsJson,
             primary_business_dataset_id AS primaryBusinessDatasetId,
             model_ids_json AS modelIdsJson,
             default_model_id AS defaultModelId,
             semantic_value_config_json AS semanticValueConfigJson,
             semantic_policy_json AS semanticPolicyJson,
             examples_json AS examplesJson,
             default_chart AS defaultChart, status,
             created_at AS createdAt, updated_at AS updatedAt
      FROM themes ORDER BY id
    `).all().map((row) => ({
      ...row,
      indicatorIds: this.listThemeIndicatorIds(row.id),
      allowedDimensions: parseJson(row.allowedDimensionsJson, []),
      llmConfig: parseJson(row.llmConfigJson, {}),
      datasetIds: parseJson(row.datasetIdsJson, []),
      businessDatasetIds: parseJson(row.businessDatasetIdsJson, []),
      primaryBusinessDatasetId: row.primaryBusinessDatasetId ?? null,
      modelIds: parseJson(row.modelIdsJson, []).map(Number).filter(Number.isFinite),
      defaultModelId: row.defaultModelId ? Number(row.defaultModelId) : null,
      semanticValueConfig: parseJson(row.semanticValueConfigJson, {}),
      semanticPolicy: mergeThemeSemanticPolicy(row.systemPrompt, parseJson(row.semanticPolicyJson, {})),
      examples: parseJson(row.examplesJson, []),
      skillCodes: this.listThemeSkillCodes(row.id),
    }));
  }

  getTheme(id) {
    const row = this.db.prepare(`
      SELECT id, name, description, system_prompt AS systemPrompt,
             indicator_ids_json AS indicatorIdsJson,
             allowed_dimensions_json AS allowedDimensionsJson,
             llm_config_json AS llmConfigJson,
             dataset_ids_json AS datasetIdsJson,
             business_dataset_ids_json AS businessDatasetIdsJson,
             primary_business_dataset_id AS primaryBusinessDatasetId,
             model_ids_json AS modelIdsJson,
             default_model_id AS defaultModelId,
             semantic_value_config_json AS semanticValueConfigJson,
             semantic_policy_json AS semanticPolicyJson,
             examples_json AS examplesJson,
             default_chart AS defaultChart, status,
             created_at AS createdAt, updated_at AS updatedAt
      FROM themes WHERE id = ?
    `).get(Number(id));
    return row ? {
      ...row,
      indicatorIds: this.listThemeIndicatorIds(row.id),
      allowedDimensions: parseJson(row.allowedDimensionsJson, []),
      llmConfig: parseJson(row.llmConfigJson, {}),
      datasetIds: parseJson(row.datasetIdsJson, []),
      businessDatasetIds: parseJson(row.businessDatasetIdsJson, []),
      primaryBusinessDatasetId: row.primaryBusinessDatasetId ?? null,
      modelIds: parseJson(row.modelIdsJson, []).map(Number).filter(Number.isFinite),
      defaultModelId: row.defaultModelId ? Number(row.defaultModelId) : null,
      semanticValueConfig: parseJson(row.semanticValueConfigJson, {}),
      semanticPolicy: mergeThemeSemanticPolicy(row.systemPrompt, parseJson(row.semanticPolicyJson, {})),
      examples: parseJson(row.examplesJson, []),
      skillCodes: this.listThemeSkillCodes(row.id),
    } : null;
  }

  saveTheme(payload, id = null) {
    const timestamp = nowIso();
    const name = String(payload.name ?? '').trim();
    const description = String(payload.description ?? '').trim();
    const systemPrompt = String(payload.systemPrompt ?? '').trim();
    let indicatorIdList = id
      ? this.listThemeIndicatorIds(id)
      : normalizeSourceIdList(payload.indicatorIds);
    if (id && Object.prototype.hasOwnProperty.call(payload, 'indicatorIds')) {
      this.replaceThemeIndicatorIds(id, payload.indicatorIds);
      indicatorIdList = normalizeSourceIdList(payload.indicatorIds);
    }
    const indicatorIds = asJson(indicatorIdList);
    const allowedDimensions = asJson(payload.allowedDimensions ?? []);
    const llmConfig = asJson(payload.llmConfig ?? {});
    const datasetIds = asJson(payload.datasetIds ?? []);
    const primaryBusinessDatasetId = Object.prototype.hasOwnProperty.call(payload, 'businessDatasetIds')
      && !Object.prototype.hasOwnProperty.call(payload, 'primaryBusinessDatasetId')
      ? null
      : payload.primaryBusinessDatasetId
      ? Number(payload.primaryBusinessDatasetId)
      : null;
    const modelIds = [...new Set(
      normalizeSourceIdList(payload.modelIds)
        .map(Number)
        .filter(Number.isFinite),
    )].filter((modelId) => Boolean(this.getModel(modelId)));
    const defaultModelId = payload.defaultModelId
      ? Number(payload.defaultModelId)
      : null;
    const effectiveDefaultModelId = defaultModelId && modelIds.includes(defaultModelId)
      ? defaultModelId
      : (modelIds[0] ?? null);
    const modelIdsJson = asJson(modelIds);
    const businessDatasetIdList = [...new Set(
      normalizeSourceIdList(payload.businessDatasetIds)
        .map(Number)
        .filter(Number.isFinite),
    )];
    if (
      primaryBusinessDatasetId
      && !businessDatasetIdList.map(String).includes(String(primaryBusinessDatasetId))
    ) {
      businessDatasetIdList.push(primaryBusinessDatasetId);
    }
    const businessDatasetIds = asJson(businessDatasetIdList);
    const semanticValueConfig = asJson(sanitizeSemanticValueConfig(
      payload.semanticValueConfig,
      {
        indicatorIds: indicatorIdList,
        businessDatasetIds: businessDatasetIdList,
      },
    ));
    const semanticPolicy = asJson(normalizeSemanticPolicy(payload.semanticPolicy));
    const examples = asJson(payload.examples ?? []);
    const defaultChart = String(payload.defaultChart ?? 'auto');
    const status = Number(payload.status ?? 1);
    const skillCodes = Array.isArray(payload.skillCodes) ? payload.skillCodes : null;
    if (!name) {
      throw new Error('theme name is required');
    }

    if (id) {
      this.db.prepare(`
        UPDATE themes
        SET name = ?, description = ?, system_prompt = ?,
            indicator_ids_json = ?, allowed_dimensions_json = ?,
            llm_config_json = ?, dataset_ids_json = ?, examples_json = ?,
            business_dataset_ids_json = ?, primary_business_dataset_id = ?,
            model_ids_json = ?, default_model_id = ?,
            semantic_value_config_json = ?,
            semantic_policy_json = ?,
            default_chart = ?, status = ?, updated_at = ?
        WHERE id = ?
      `).run(name, description, systemPrompt, indicatorIds, allowedDimensions,
        llmConfig, datasetIds, examples, businessDatasetIds,
        primaryBusinessDatasetId, modelIdsJson, effectiveDefaultModelId,
        semanticValueConfig, semanticPolicy,
        defaultChart, status,
        timestamp, Number(id));
      if (businessDatasetIdList.length > 0) {
        this.pruneSemanticValueDomainsBySource({
          themeId: Number(id),
          sourceType: 'DATASET',
          allowedSourceIds: businessDatasetIdList,
        });
      }
      if (indicatorIdList.length > 0) {
        this.pruneSemanticValueDomainsBySource({
          themeId: Number(id),
          sourceType: 'INDICATOR',
          allowedSourceIds: indicatorIdList,
        });
      }
      if (skillCodes) {
        this.replaceThemeSkills(Number(id), skillCodes);
      }
      return this.getTheme(id);
    }

    const result = this.db.prepare(`
      INSERT INTO themes
        (name, description, system_prompt, indicator_ids_json, allowed_dimensions_json,
         llm_config_json, dataset_ids_json, examples_json,
         business_dataset_ids_json, primary_business_dataset_id,
         model_ids_json, default_model_id,
         semantic_value_config_json, semantic_policy_json,
         default_chart, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, description, systemPrompt, indicatorIds, allowedDimensions,
      llmConfig, datasetIds, examples, businessDatasetIds,
      primaryBusinessDatasetId, modelIdsJson, effectiveDefaultModelId,
      semanticValueConfig, semanticPolicy,
      defaultChart, status,
      timestamp, timestamp);
    const themeId = Number(result.lastInsertRowid);
    this.replaceThemeSkills(
      themeId,
      skillCodes ?? this.listSkills()
        .filter((skill) => skill.defaultEnabled)
        .map((skill) => skill.code),
    );
    return this.getTheme(themeId);
  }

  deleteTheme(id) {
    const themeId = Number(id);
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        DELETE FROM theme_semantic_value_domains WHERE theme_id = ?
      `).run(themeId);
      const deleted = this.db.prepare(
        'DELETE FROM themes WHERE id = ?',
      ).run(themeId).changes > 0;
      this.db.exec('COMMIT');
      return deleted;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listThemeIndicatorIds(themeId) {
    return this.db.prepare(`
      SELECT indicator_id AS indicatorId
      FROM theme_indicators WHERE theme_id = ? ORDER BY indicator_id
    `).all(Number(themeId)).map((row) => String(row.indicatorId));
  }

  replaceThemeIndicatorIds(themeId, indicatorIds = []) {
    const normalizedThemeId = Number(themeId);
    const values = normalizeSourceIdList(indicatorIds);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM theme_indicators WHERE theme_id = ?').run(normalizedThemeId);
      const insert = this.db.prepare(`
        INSERT INTO theme_indicators (theme_id, indicator_id, created_at)
        VALUES (?, ?, ?)
      `);
      for (const indicatorId of values) insert.run(normalizedThemeId, indicatorId, nowIso());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  replaceIndicatorThemes(indicatorId, themeIds = []) {
    const normalizedIndicatorId = String(indicatorId ?? '').trim();
    if (!normalizedIndicatorId) {
      throw new Error('indicatorId is required');
    }
    const normalizedThemeIds = [...new Set((themeIds ?? [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0))];
    const timestamp = nowIso();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM theme_indicators WHERE indicator_id = ?')
        .run(normalizedIndicatorId);
      const insert = this.db.prepare(`
        INSERT INTO theme_indicators (theme_id, indicator_id, created_at)
        SELECT id, ?, ? FROM themes WHERE id = ?
      `);
      for (const themeId of normalizedThemeIds) {
        insert.run(normalizedIndicatorId, timestamp, themeId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return normalizedThemeIds
      .filter((themeId) => Boolean(this.getTheme(themeId)))
      .map((themeId) => ({ themeId, indicatorId: normalizedIndicatorId }));
  }

  syncExternalSkills(skills = []) {
    return this.skillRepository.syncExternalSkills(skills);
  }

  listSkills() {
    return this.db.prepare(`
      SELECT code, name, description, category, kind, tool_name AS toolName,
             instruction, default_enabled AS defaultEnabled, status,
             source, source_path AS sourcePath,
             metadata_json AS metadataJson,
             phase_tags_json AS phaseTagsJson
      FROM skills
      WHERE status = 1
      ORDER BY category, code
    `).all().map((row) => {
      const { metadataJson, phaseTagsJson, ...skill } = row;
      return {
        ...skill,
        defaultEnabled: asBool(skill.defaultEnabled),
        source: skill.source || 'BUILTIN',
        metadata: parseJson(metadataJson, {}),
        phaseTags: parseJson(phaseTagsJson, []),
      };
    });
  }

  async listSkillsAsync() {
    const rows = await this.query(`SELECT code, name, description, category, kind,
      tool_name AS toolName, instruction, default_enabled AS defaultEnabled, status,
      source, source_path AS sourcePath, metadata_json AS metadataJson, phase_tags_json AS phaseTagsJson
      FROM skills WHERE status=1 ORDER BY category, code`);
    return rows.map((row) => ({
      ...row,
      defaultEnabled: asBool(row.defaultEnabled),
      source: row.source || 'BUILTIN',
      metadata: parseJson(row.metadataJson, {}),
      phaseTags: parseJson(row.phaseTagsJson, []),
    }));
  }

  getSkill(code) {
    const row = this.db.prepare(`
      SELECT code, name, description, category, kind, tool_name AS toolName,
             instruction, default_enabled AS defaultEnabled, status,
             source, source_path AS sourcePath,
             metadata_json AS metadataJson,
             phase_tags_json AS phaseTagsJson,
             content, content_hash AS contentHash
      FROM skills
      WHERE code = ?
    `).get(String(code));
    return row ? {
      ...row,
      defaultEnabled: asBool(row.defaultEnabled),
      source: row.source || 'BUILTIN',
      metadata: parseJson(row.metadataJson, {}),
      phaseTags: parseJson(row.phaseTagsJson, []),
    } : null;
  }

  listThemeSkills(themeId) {
    return this.db.prepare(`
      SELECT s.code, s.name, s.description, s.category, s.kind,
             s.tool_name AS toolName, s.instruction,
             s.source, s.source_path AS sourcePath,
             s.metadata_json AS metadataJson,
             s.phase_tags_json AS phaseTagsJson,
             ts.enabled, ts.config_json AS configJson
      FROM theme_skills ts
      JOIN skills s ON s.code = ts.skill_code
      WHERE ts.theme_id = ? AND ts.enabled = 1 AND s.status = 1
      ORDER BY s.category, s.code
    `).all(Number(themeId)).map((row) => {
      const { metadataJson, phaseTagsJson, configJson, ...skill } = row;
      return {
        ...skill,
        enabled: asBool(skill.enabled),
        config: parseJson(configJson, {}),
        source: skill.source || 'BUILTIN',
        metadata: parseJson(metadataJson, {}),
        phaseTags: parseJson(phaseTagsJson, []),
      };
    });
  }

  listThemeSkillCodes(themeId) {
    return this.db.prepare(`
      SELECT skill_code AS code
      FROM theme_skills
      WHERE theme_id = ? AND enabled = 1
      ORDER BY skill_code
    `).all(Number(themeId)).map((row) => row.code);
  }

  replaceThemeSkills(themeId, skillCodes) {
    const normalized = [...new Set((skillCodes ?? []).map((code) => String(code)))];
    const existing = new Set(this.listSkills().map((skill) => skill.code));
    const validCodes = normalized.filter((code) => existing.has(code));
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM theme_skills WHERE theme_id = ?').run(Number(themeId));
      const insert = this.db.prepare(`
        INSERT INTO theme_skills (theme_id, skill_code, enabled, config_json)
        VALUES (?, ?, 1, '{}')
      `);
      for (const code of validCodes) {
        insert.run(Number(themeId), code);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  syncIndicators(indicators, { prune = true } = {}) {
    const timestamp = nowIso();
    const upsert = this.db.prepare(`
      INSERT INTO indicator_cache
        (source_id, name, biz_name, type_id, type_name, indicator_level,
         business_caliber, description, owner, department, status,
         metrics_json, dimensions_json, models_json, raw_json, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        name = excluded.name,
        biz_name = excluded.biz_name,
        type_id = excluded.type_id,
        type_name = excluded.type_name,
        indicator_level = excluded.indicator_level,
        business_caliber = excluded.business_caliber,
        description = excluded.description,
        owner = excluded.owner,
        department = excluded.department,
        status = excluded.status,
        metrics_json = excluded.metrics_json,
        dimensions_json = excluded.dimensions_json,
        models_json = excluded.models_json,
        raw_json = excluded.raw_json,
        synced_at = excluded.synced_at
    `);

    this.db.exec('BEGIN');
    try {
      for (const indicator of indicators) {
        upsert.run(
          String(indicator.id),
          String(indicator.name ?? ''),
          String(indicator.bizName ?? ''),
          String(indicator.typeId ?? ''),
          String(indicator.typeName ?? ''),
          String(indicator.indicatorLevel ?? ''),
          String(indicator.businessCaliber ?? ''),
          String(indicator.description ?? ''),
          String(indicator.owner ?? ''),
          String(indicator.department ?? ''),
          Number(indicator.status ?? 1),
          asJson(indicator.metrics ?? []),
          asJson(indicator.dimensions ?? []),
          asJson(indicator.models ?? []),
          asJson(indicator.raw ?? indicator),
          timestamp,
        );
      }
      // Only reconcile deletions when the caller supplied a complete catalog;
      // a partial page must never prune indicators it did not fetch.
      if (prune && indicators.length > 0) {
        const placeholders = indicators.map(() => '?').join(', ');
        this.db.prepare(`
          DELETE FROM indicator_cache
          WHERE source_id NOT IN (${placeholders})
        `).run(...indicators.map((indicator) => String(indicator.id)));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return indicators.length;
  }

  clearIndicatorCatalog() {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM indicator_cache').run();
      this.db.prepare('DELETE FROM indicator_types').run();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  indicatorCacheStats() {
    const indicators = this.db.prepare(`
      SELECT COUNT(*) AS count, MAX(synced_at) AS freshAt FROM indicator_cache
    `).get();
    const types = this.db.prepare(`
      SELECT COUNT(*) AS count, MAX(synced_at) AS freshAt FROM indicator_types
    `).get();
    return {
      count: Number(indicators?.count ?? 0),
      freshAt: indicators?.freshAt ?? null,
      typeCount: Number(types?.count ?? 0),
      typesFreshAt: types?.freshAt ?? null,
    };
  }

  syncIndicatorTypes(types) {
    const timestamp = nowIso();
    const upsert = this.db.prepare(`
      INSERT INTO indicator_types (source_id, name, code, parent_id, raw_json, synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        name = excluded.name,
        code = excluded.code,
        parent_id = excluded.parent_id,
        raw_json = excluded.raw_json,
        synced_at = excluded.synced_at
    `);
    this.db.exec('BEGIN');
    try {
      for (const type of types) {
        upsert.run(
          String(type.id),
          String(type.typeName ?? type.name ?? ''),
          String(type.typeCode ?? ''),
          String(type.parentId ?? ''),
          asJson(type.raw ?? type),
          timestamp,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return types.length;
  }

  listIndicatorTypes() {
    return this.db.prepare(`
      SELECT source_id AS id, name, code, parent_id AS parentId,
             raw_json AS rawJson, synced_at AS syncedAt
      FROM indicator_types ORDER BY name
    `).all().map((row) => ({ ...row, raw: parseJson(row.rawJson, {}) }));
  }

  listIndicators({ keyword = '', typeId = '', limit = 500 } = {}) {
    const stats = this.indicatorCacheStats();
    const rows = this.db.prepare(`
      SELECT source_id AS id, name, biz_name AS bizName, type_id AS typeId,
             type_name AS typeName, indicator_level AS indicatorLevel,
             business_caliber AS businessCaliber, description, owner, department,
             status, metrics_json AS metricsJson, dimensions_json AS dimensionsJson,
             models_json AS modelsJson, raw_json AS rawJson, synced_at AS syncedAt
      FROM indicator_cache ORDER BY name
    `).all().map((row) => ({
      ...row,
      metrics: parseJson(row.metricsJson, []),
      dimensions: parseJson(row.dimensionsJson, []),
      models: parseJson(row.modelsJson, []),
      raw: parseJson(row.rawJson, {}),
    }));

    const normalizedKeyword = String(keyword).trim().toLowerCase();
    const normalizedTypeId = String(typeId ?? '').trim();
    const items = rows
      .filter((indicator) => !normalizedTypeId || indicator.typeId === normalizedTypeId)
      .filter((indicator) => {
        if (!normalizedKeyword) {
          return true;
        }
        return [
          indicator.name,
          indicator.bizName,
          indicator.description,
          indicator.businessCaliber,
          indicator.typeName,
        ].some((value) => String(value ?? '').toLowerCase().includes(normalizedKeyword));
      })
      .slice(0, Math.max(1, Math.min(Number(limit) || 500, 2000)));
    return {
      items,
      source: stats.count > 0 ? 'SNAPSHOT' : 'UNAVAILABLE',
      freshAt: stats.freshAt,
    };
  }

  listDatasetOptions() {
    const stats = this.indicatorCacheStats();
    const options = new Map();
    const rows = this.db.prepare('SELECT models_json AS modelsJson FROM indicator_cache').all();
    for (const row of rows) {
      for (const model of parseJson(row.modelsJson, [])) {
        const id = String(model.modelId ?? model.id ?? model.datasetId ?? model.modelName ?? '');
        if (!id) {
          continue;
        }
        if (!options.has(id)) {
          options.set(id, {
            id,
            name: String(model.modelName ?? model.name ?? id),
            bizName: String(model.modelBizName ?? model.bizName ?? ''),
            database: String(model.modelDatabase ?? model.database ?? ''),
            table: String(model.modelTable ?? model.table ?? ''),
            description: String(model.description ?? ''),
          });
        }
      }
    }
    return {
      items: [...options.values()]
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
      source: stats.count > 0 ? 'SNAPSHOT' : 'UNAVAILABLE',
      freshAt: stats.freshAt,
    };
  }

  listDataSources() {
    return this.dataSourceRepository.listDataSources();
  }

  getDataSource(id) {
    return this.dataSourceRepository.getDataSource(id);
  }

  getDataSourceByCode(code) {
    return this.dataSourceRepository.getDataSourceByCode(code);
  }

  async getDataSourceByCodeAsync(code) {
    return this.dataSourceRepository.getDataSourceByCodeAsync(code);
  }

  saveDataSource(payload, id = null) {
    return this.dataSourceRepository.saveDataSource(payload, id);
  }

  deleteDataSource(id) {
    const source = this.getDataSource(id);
    if (!source) return false;
    const datasets = this.db.prepare(`
      SELECT id, name FROM business_datasets WHERE datasource_id = ? ORDER BY id
    `).all(Number(id));
    if (datasets.length > 0) {
      throw Object.assign(
        new Error(`数据源仍被 ${datasets.length} 个数据集引用：${datasets.map((item) => item.name).join('、')}`),
        { statusCode: 409, code: 'DATASOURCE_IN_USE', references: datasets },
      );
    }
    return this.db.prepare('DELETE FROM data_sources WHERE id = ?').run(Number(id)).changes > 0;
  }

  updateDataSourceTest(id, result, testedSource = null) {
    return saveDataSourceTest(this, id, result, testedSource);
  }

  listBusinessDatasets({ userId = null, includeDisabled = false } = {}) {
    const rows = this.db.prepare(`
      SELECT d.id, d.code, d.name, d.description, d.datasource_id AS datasourceId,
             s.code AS datasourceCode, s.name AS datasourceName, s.db_type AS dbType,
             d.schema_name AS schemaName, d.primary_table AS primaryTable,
             d.config_json AS configJson, d.status, d.last_synced_at AS lastSyncedAt,
             d.created_at AS createdAt, d.updated_at AS updatedAt,
             (SELECT COUNT(*) FROM dataset_fields f WHERE f.dataset_id = d.id) AS fieldCount,
             (SELECT COUNT(*) FROM dataset_fields f
               WHERE f.dataset_id = d.id AND f.enabled = 1) AS enabledFieldCount,
             CASE WHEN ? IS NULL THEN 1 ELSE (
               SELECT COUNT(*) FROM user_dataset_grants g
               WHERE g.dataset_id = d.id AND g.user_id = ? AND g.can_query = 1
             ) END AS canQuery
      FROM business_datasets d
      JOIN data_sources s ON s.id = d.datasource_id
      WHERE (? = 1 OR (d.status = 1 AND s.status = 1))
      ORDER BY d.id
    `).all(
      userId ? Number(userId) : null,
      userId ? Number(userId) : null,
      includeDisabled ? 1 : 0,
    );
    return rows.map((row) => ({
      ...row,
      config: parseJson(row.configJson, {}),
      canQuery: asBool(row.canQuery),
    }));
  }

  async listBusinessDatasetsAsync({ userId = null, includeDisabled = false } = {}) {
    const rows = await this.query(`
      SELECT d.id, d.code, d.name, d.description, d.datasource_id AS datasourceId,
             s.code AS datasourceCode, s.name AS datasourceName, s.db_type AS dbType,
             d.schema_name AS schemaName, d.primary_table AS primaryTable,
             d.config_json AS configJson, d.status, d.last_synced_at AS lastSyncedAt,
             d.created_at AS createdAt, d.updated_at AS updatedAt,
             (SELECT COUNT(*) FROM dataset_fields f WHERE f.dataset_id = d.id) AS fieldCount,
             (SELECT COUNT(*) FROM dataset_fields f WHERE f.dataset_id = d.id AND f.enabled = 1) AS enabledFieldCount,
             CASE WHEN ? IS NULL THEN 1 ELSE (SELECT COUNT(*) FROM user_dataset_grants g
               WHERE g.dataset_id = d.id AND g.user_id = ? AND g.can_query = 1) END AS canQuery
      FROM business_datasets d JOIN data_sources s ON s.id = d.datasource_id
      WHERE (? = 1 OR (d.status = 1 AND s.status = 1)) ORDER BY d.id`, [
      userId ? Number(userId) : null, userId ? Number(userId) : null, includeDisabled ? 1 : 0,
    ]);
    return rows.map((row) => ({ ...row, config: parseJson(row.configJson, {}), canQuery: asBool(row.canQuery) }));
  }

  async getBusinessDatasetAsync(id) {
    return (await this.listBusinessDatasetsAsync({ includeDisabled: true }))
      .find((dataset) => Number(dataset.id) === Number(id)) ?? null;
  }

  async saveBusinessDatasetAsync(payload, id = null) {
    const timestamp = nowIso();
    const values = [String(payload.code ?? '').trim(), String(payload.name ?? '').trim(),
      String(payload.description ?? '').trim(), Number(payload.datasourceId),
      String(payload.schemaName ?? '').trim(), String(payload.primaryTable ?? '').trim(),
      asJson(payload.config ?? {}), Number(payload.status ?? 1), timestamp];
    if (!values[0] || !values[1] || !values[3] || !values[4] || !values[5]) {
      throw new Error('dataset code, name, datasource, schema and table are required');
    }
    if (id) {
      if (!await this.getBusinessDatasetAsync(id)) throw new Error('dataset not found');
      await this.execute(`UPDATE business_datasets SET code=?, name=?, description=?, datasource_id=?,
        schema_name=?, primary_table=?, config_json=?, status=?, updated_at=? WHERE id=?`, [...values, Number(id)]);
      return this.getBusinessDatasetAsync(id);
    }
    const result = await this.execute(`INSERT INTO business_datasets
      (code, name, description, datasource_id, schema_name, primary_table, config_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [...values.slice(0, 8), timestamp, timestamp]);
    return this.getBusinessDatasetAsync(result.insertId);
  }

  async replaceDatasetFieldsAsync(datasetId, fields) {
    const timestamp = nowIso();
    await this.transaction(async (tx) => {
      await tx.execute('DELETE FROM dataset_fields WHERE dataset_id = ?', [Number(datasetId)]);
      for (const field of fields) {
        await tx.execute(`INSERT INTO dataset_fields
          (dataset_id, field_name, display_name, data_type, semantic_type, role, aggregator,
           description, allowed_operators_json, ordinal_position, enabled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [Number(datasetId), String(field.fieldName),
          String(field.displayName ?? field.fieldName), String(field.dataType ?? ''),
          String(field.semanticType ?? 'STRING'), String(field.role ?? 'DIMENSION'),
          String(field.aggregator ?? 'NONE'), String(field.description ?? ''),
          asJson(field.allowedOperators ?? []), Number(field.ordinalPosition ?? 0), field.enabled === false ? 0 : 1]);
      }
    });
    await this.execute('UPDATE business_datasets SET last_synced_at=?, updated_at=? WHERE id=?', [timestamp, timestamp, Number(datasetId)]);
    return this.listDatasetFieldsAsync(datasetId);
  }

  async listDatasetFieldsAsync(datasetId, { enabledOnly = false } = {}) {
    const rows = await this.query(`SELECT id, dataset_id AS datasetId, field_name AS fieldName,
      display_name AS displayName, data_type AS dataType, semantic_type AS semanticType,
      role, aggregator, description, allowed_operators_json AS allowedOperatorsJson,
      ordinal_position AS ordinalPosition, enabled FROM dataset_fields
      WHERE dataset_id = ? AND (? = 0 OR enabled = 1) ORDER BY ordinal_position, id`,
    [Number(datasetId), enabledOnly ? 1 : 0]);
    return rows.map((row) => ({ ...row, allowedOperators: parseJson(row.allowedOperatorsJson, []), enabled: asBool(row.enabled) }));
  }

  async setDatasetFieldEnabledAsync(datasetId, fieldName, enabled) {
    const result = await this.execute('UPDATE dataset_fields SET enabled = ? WHERE dataset_id = ? AND field_name = ?',
      [enabled === false ? 0 : 1, Number(datasetId), String(fieldName)]);
    if (!Number(result.affectedRows)) return null;
    const fields = await this.listDatasetFieldsAsync(datasetId);
    return fields.find((field) => field.fieldName === String(fieldName)) ?? null;
  }

  async deleteBusinessDatasetAsync(id) {
    const dataset = await this.getBusinessDatasetAsync(id);
    if (!dataset) return false;
    const themes = (await this.themeRepository.listThemesAsync()).filter((theme) =>
      (theme.businessDatasetIds ?? []).map(String).includes(String(id))
      || String(theme.primaryBusinessDatasetId ?? '') === String(id));
    if (themes.length) throw Object.assign(
      new Error(`数据集仍被 ${themes.length} 个智能体引用：${themes.map((item) => item.name).join('、')}`),
      { statusCode: 409, code: 'DATASET_IN_USE', references: themes.map((item) => ({ id: item.id, name: item.name })) },
    );
    return Number((await this.execute('DELETE FROM business_datasets WHERE id = ?', [Number(id)])).affectedRows) > 0;
  }

  getBusinessDataset(id) {
    return this.listBusinessDatasets({ includeDisabled: true })
      .find((dataset) => Number(dataset.id) === Number(id)) ?? null;
  }

  getBusinessDatasetByCode(code) {
    return this.listBusinessDatasets({ includeDisabled: true })
      .find((dataset) => dataset.code === String(code)) ?? null;
  }

  saveBusinessDataset(payload, id = null) {
    const timestamp = nowIso();
    const values = [
      String(payload.code ?? '').trim(),
      String(payload.name ?? '').trim(),
      String(payload.description ?? '').trim(),
      Number(payload.datasourceId),
      String(payload.schemaName ?? '').trim(),
      String(payload.primaryTable ?? '').trim(),
      asJson(payload.config ?? {}),
      Number(payload.status ?? 1),
      timestamp,
    ];
    if (!values[0] || !values[1] || !values[3] || !values[4] || !values[5]) {
      throw new Error('dataset code, name, datasource, schema and table are required');
    }
    if (id) {
      if (!this.getBusinessDataset(id)) {
        throw new Error('dataset not found');
      }
      this.db.prepare(`
        UPDATE business_datasets
        SET code = ?, name = ?, description = ?, datasource_id = ?,
            schema_name = ?, primary_table = ?, config_json = ?,
            status = ?, updated_at = ?
        WHERE id = ?
      `).run(...values, Number(id));
      return this.getBusinessDataset(id);
    }
    const result = this.db.prepare(`
      INSERT INTO business_datasets
        (code, name, description, datasource_id, schema_name, primary_table,
         config_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      values[0], values[1], values[2], values[3], values[4], values[5],
      values[6], values[7], timestamp, timestamp,
    );
    return this.getBusinessDataset(Number(result.lastInsertRowid));
  }

  deleteBusinessDataset(id) {
    const dataset = this.getBusinessDataset(id);
    if (!dataset) return false;
    const themes = this.listThemes().filter((theme) =>
      (theme.businessDatasetIds ?? []).map(String).includes(String(id))
      || String(theme.primaryBusinessDatasetId ?? '') === String(id));
    if (themes.length > 0) {
      throw Object.assign(
        new Error(`数据集仍被 ${themes.length} 个智能体引用：${themes.map((item) => item.name).join('、')}`),
        { statusCode: 409, code: 'DATASET_IN_USE', references: themes.map((item) => ({ id: item.id, name: item.name })) },
      );
    }
    return this.db.prepare('DELETE FROM business_datasets WHERE id = ?').run(Number(id)).changes > 0;
  }

  replaceDatasetFields(datasetId, fields) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM dataset_fields WHERE dataset_id = ?').run(Number(datasetId));
      const insert = this.db.prepare(`
        INSERT INTO dataset_fields
          (dataset_id, field_name, display_name, data_type, semantic_type,
           role, aggregator, description, allowed_operators_json,
           ordinal_position, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const field of fields) {
        insert.run(
          Number(datasetId),
          String(field.fieldName),
          String(field.displayName ?? field.fieldName),
          String(field.dataType ?? ''),
          String(field.semanticType ?? 'STRING'),
          String(field.role ?? 'DIMENSION'),
          String(field.aggregator ?? 'NONE'),
          String(field.description ?? ''),
          asJson(field.allowedOperators ?? []),
          Number(field.ordinalPosition ?? 0),
          field.enabled === false ? 0 : 1,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.db.prepare(`
      UPDATE business_datasets SET last_synced_at = ?, updated_at = ? WHERE id = ?
    `).run(nowIso(), nowIso(), Number(datasetId));
    return this.listDatasetFields(datasetId);
  }

  listDatasetFields(datasetId, { enabledOnly = false } = {}) {
    return this.db.prepare(`
      SELECT id, dataset_id AS datasetId, field_name AS fieldName,
             display_name AS displayName, data_type AS dataType,
             semantic_type AS semanticType, role, aggregator,
             description, allowed_operators_json AS allowedOperatorsJson,
             ordinal_position AS ordinalPosition, enabled
      FROM dataset_fields
      WHERE dataset_id = ? AND (? = 0 OR enabled = 1)
      ORDER BY ordinal_position, id
    `).all(Number(datasetId), enabledOnly ? 1 : 0).map((row) => ({
      ...row,
      allowedOperators: parseJson(row.allowedOperatorsJson, []),
      enabled: asBool(row.enabled),
    }));
  }

  // Toggles one field without touching the schema-sync timestamp: a disabled
  // field stays in the table but is filtered out of every query path (all of
  // them read with enabledOnly: true).
  setDatasetFieldEnabled(datasetId, fieldName, enabled) {
    const result = this.db.prepare(`
      UPDATE dataset_fields SET enabled = ?
      WHERE dataset_id = ? AND field_name = ?
    `).run(enabled === false ? 0 : 1, Number(datasetId), String(fieldName));
    if (result.changes === 0) {
      return null;
    }
    return this.listDatasetFields(datasetId)
      .find((field) => field.fieldName === String(fieldName)) ?? null;
  }

  replaceSemanticValueDomains({
    themeId,
    sourceType,
    sourceId,
    fieldName,
    displayName = '',
    values = [],
    description = '',
  }) {
    const normalizedThemeId = requireRecordId(themeId, 'themeId');
    const timestamp = nowIso();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        DELETE FROM theme_semantic_value_domains
        WHERE theme_id = ? AND source_type = ? AND source_id = ? AND field_name = ?
      `).run(
        normalizedThemeId,
        String(sourceType),
        String(sourceId),
        String(fieldName),
      );
      const insert = this.db.prepare(`
        INSERT INTO theme_semantic_value_domains
          (theme_id, source_type, source_id, field_name, display_name, value,
           normalized_value, aliases_json, description, source, confidence,
           enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `);
      for (const candidate of values) {
        insert.run(
          normalizedThemeId,
          String(sourceType),
          String(sourceId),
          String(fieldName),
          String(displayName ?? ''),
          String(candidate.value ?? candidate),
          String(candidate.value ?? candidate).toLowerCase().replace(/\s+/g, ''),
          asJson(candidate.aliases ?? []),
          String(description ?? ''),
          String(candidate.source ?? 'DESCRIPTION'),
          Number(candidate.confidence ?? 1),
          timestamp,
          timestamp,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.listSemanticValueDomains({
      themeId: normalizedThemeId,
      sourceType,
      sourceId,
      fieldName,
    });
  }

  deleteSemanticValueDomains({
    themeId,
    sourceType,
    sourceId,
    fieldName,
  }) {
    const normalizedThemeId = requireRecordId(themeId, 'themeId');
    return this.db.prepare(`
      DELETE FROM theme_semantic_value_domains
      WHERE theme_id = ? AND source_type = ? AND source_id = ? AND field_name = ?
    `).run(
      normalizedThemeId,
      String(sourceType),
      String(sourceId),
      String(fieldName),
    ).changes;
  }

  pruneSemanticValueDomainsBySource({
    themeId,
    sourceType,
    allowedSourceIds = [],
  }) {
    const normalizedThemeId = requireRecordId(themeId, 'themeId');
    const normalizedSourceType = String(sourceType ?? '').trim().toUpperCase();
    if (!normalizedSourceType) {
      throw new Error('sourceType is required');
    }
    const sourceIds = normalizeSourceIdList(allowedSourceIds);
    if (sourceIds.length === 0) {
      return this.db.prepare(`
        DELETE FROM theme_semantic_value_domains
        WHERE theme_id = ? AND source_type = ?
      `).run(normalizedThemeId, normalizedSourceType).changes;
    }
    const placeholders = sourceIds.map(() => '?').join(', ');
    return this.db.prepare(`
      DELETE FROM theme_semantic_value_domains
      WHERE theme_id = ? AND source_type = ?
        AND source_id NOT IN (${placeholders})
    `).run(
      normalizedThemeId,
      normalizedSourceType,
      ...sourceIds,
    ).changes;
  }

  listSemanticValueDomains({
    themeId,
    sourceType,
    sourceId,
    fieldName = null,
  } = {}) {
    const normalizedThemeId = requireRecordId(themeId, 'themeId');
    return this.db.prepare(`
      SELECT id, source_type AS sourceType, source_id AS sourceId,
             field_name AS fieldName, display_name AS displayName,
             value, normalized_value AS normalizedValue,
             aliases_json AS aliasesJson, description, source,
             confidence, enabled
      FROM theme_semantic_value_domains
      WHERE theme_id = ? AND source_type = ? AND source_id = ?
        AND (? IS NULL OR field_name = ?)
        AND enabled = 1
      ORDER BY field_name, id
    `).all(
      normalizedThemeId,
      String(sourceType),
      String(sourceId),
      fieldName || null,
      fieldName || null,
    ).map((row) => ({
      ...row,
      aliases: parseJson(row.aliasesJson, []),
      enabled: asBool(row.enabled),
    }));
  }

  saveSemanticValueSnapshot({
    themeId,
    sourceType,
    sourceId,
    fieldName,
    displayName = '',
    status = 'UNKNOWN',
    origins = [],
    items = [],
    sampleSize = 0,
    scopeSignature = '',
    schemaHash = '',
    errorMessage = '',
    expiresAt = null,
  }) {
    const normalizedThemeId = requireRecordId(themeId, 'themeId');
    const timestamp = nowIso();
    const previous = this.getActiveSemanticValueSnapshot({
      themeId: normalizedThemeId,
      sourceType,
      sourceId,
      fieldName,
    });
    const version = Number(previous?.version ?? 0) + 1;
    const checksum = items.length > 0
      ? crypto
        .createHash('sha256')
        .update(JSON.stringify(items.map((item) => item.value).sort()))
        .digest('hex')
      : '';
    this.db.exec('BEGIN');
    try {
      const result = this.db.prepare(`
        INSERT INTO semantic_value_snapshots
          (theme_id, source_type, source_id, field_name, display_name, version,
           status, origin_mask_json, value_count, sample_size, checksum,
           scope_signature, schema_hash, error_message, refreshed_at,
           expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalizedThemeId,
        String(sourceType),
        String(sourceId),
        String(fieldName),
        String(displayName ?? ''),
        version,
        String(status),
        asJson(origins),
        items.length,
        Number(sampleSize) || 0,
        checksum,
        String(scopeSignature ?? ''),
        String(schemaHash ?? ''),
        String(errorMessage ?? ''),
        timestamp,
        expiresAt || null,
        timestamp,
        timestamp,
      );
      const snapshotId = Number(result.lastInsertRowid);
      const insertItem = this.db.prepare(`
        INSERT INTO semantic_value_snapshot_items
          (snapshot_id, value, normalized_value, aliases_json, origin,
           origin_ref, confidence, enabled, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `);
      for (const item of items) {
        insertItem.run(
          snapshotId,
          String(item.value ?? ''),
          String(item.value ?? '').toLowerCase().replace(/\s+/g, ''),
          asJson(item.aliases ?? []),
          String(item.origin ?? ''),
          String(item.originRef ?? ''),
          Number(item.confidence ?? 1),
          String(item.firstSeenAt ?? timestamp),
          timestamp,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getActiveSemanticValueSnapshot({
      themeId: normalizedThemeId,
      sourceType,
      sourceId,
      fieldName,
    });
  }

  getActiveSemanticValueSnapshot({
    themeId,
    sourceType,
    sourceId,
    fieldName,
  }) {
    const normalizedThemeId = requireRecordId(themeId, 'themeId');
    const row = this.db.prepare(`
      SELECT id, theme_id AS themeId, source_type AS sourceType,
             source_id AS sourceId, field_name AS fieldName,
             display_name AS displayName, version, status,
             origin_mask_json AS originMaskJson, value_count AS valueCount,
             sample_size AS sampleSize, checksum, scope_signature AS scopeSignature,
             schema_hash AS schemaHash, error_message AS errorMessage,
             refreshed_at AS refreshedAt, expires_at AS expiresAt,
             created_at AS createdAt, updated_at AS updatedAt
      FROM semantic_value_snapshots
      WHERE theme_id = ? AND source_type = ? AND source_id = ?
        AND field_name = ?
      ORDER BY version DESC, id DESC
      LIMIT 1
    `).get(
      normalizedThemeId,
      String(sourceType),
      String(sourceId),
      String(fieldName),
    );
    if (!row) {
      return null;
    }
    const items = this.listSemanticValueSnapshotItems(Number(row.id));
    return {
      ...row,
      origins: parseJson(row.originMaskJson, []),
      items,
    };
  }

  listSemanticValueSnapshots({
    themeId,
    sourceType = null,
    sourceId = null,
    fieldName = null,
    limit = 200,
  } = {}) {
    const normalizedThemeId = requireRecordId(themeId, 'themeId');
    const rows = this.db.prepare(`
      SELECT id, source_type AS sourceType, source_id AS sourceId,
             field_name AS fieldName, display_name AS displayName,
             version, status, origin_mask_json AS originMaskJson,
             value_count AS valueCount, sample_size AS sampleSize,
             checksum, scope_signature AS scopeSignature,
             schema_hash AS schemaHash, error_message AS errorMessage,
             refreshed_at AS refreshedAt, expires_at AS expiresAt,
             created_at AS createdAt, updated_at AS updatedAt
      FROM semantic_value_snapshots
      WHERE theme_id = ?
        AND (? IS NULL OR source_type = ?)
        AND (? IS NULL OR source_id = ?)
        AND (? IS NULL OR field_name = ?)
      ORDER BY id DESC
      LIMIT ?
    `).all(
      normalizedThemeId,
      sourceType || null,
      sourceType || null,
      sourceId == null ? null : String(sourceId),
      sourceId == null ? null : String(sourceId),
      fieldName || null,
      fieldName || null,
      Math.max(1, Math.min(Number(limit) || 200, 1000)),
    ).map((row) => ({
      ...row,
      origins: parseJson(row.originMaskJson, []),
    }));
    return rows;
  }

  listSemanticValueSnapshotItems(snapshotId) {
    const normalizedSnapshotId = requireRecordId(snapshotId, 'snapshotId');
    return this.db.prepare(`
      SELECT id, snapshot_id AS snapshotId, value, normalized_value AS normalizedValue,
             aliases_json AS aliasesJson, origin, origin_ref AS originRef,
             confidence, enabled, first_seen_at AS firstSeenAt,
             last_seen_at AS lastSeenAt
      FROM semantic_value_snapshot_items
      WHERE snapshot_id = ? AND enabled = 1
      ORDER BY id
    `).all(normalizedSnapshotId).map((row) => ({
      ...row,
      aliases: parseJson(row.aliasesJson, []),
      enabled: asBool(row.enabled),
    }));
  }

  saveSemanticValueOverride({
    themeId,
    sourceType,
    sourceId,
    fieldName,
    concept,
    aliases = [],
    operator = 'IN',
    configuredValues = [],
    ruleSource = '',
    action = 'ENUM_MAPPING',
    allowUnverified = false,
    enabled = true,
    updatedBy = null,
  }) {
    const normalizedThemeId = requireRecordId(themeId, 'themeId');
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO semantic_value_overrides
        (theme_id, source_type, source_id, field_name, concept, aliases_json,
         operator, configured_values_json, rule_source, action,
         allow_unverified, enabled, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (theme_id, source_type, source_id, field_name, concept, action)
      DO UPDATE SET
        aliases_json = excluded.aliases_json,
        operator = excluded.operator,
        configured_values_json = excluded.configured_values_json,
        rule_source = excluded.rule_source,
        allow_unverified = excluded.allow_unverified,
        enabled = excluded.enabled,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `).run(
      normalizedThemeId,
      String(sourceType),
      String(sourceId),
      String(fieldName),
      String(concept ?? ''),
      asJson(aliases ?? []),
      String(operator ?? 'IN'),
      asJson(configuredValues ?? []),
      String(ruleSource ?? ''),
      String(action ?? 'ENUM_MAPPING'),
      allowUnverified ? 1 : 0,
      enabled ? 1 : 0,
      updatedBy ? Number(updatedBy) : null,
      timestamp,
      timestamp,
    );
    return this.listSemanticValueOverrides({
      themeId: normalizedThemeId,
      sourceType,
      sourceId,
      fieldName,
    });
  }

  listSemanticValueOverrides({
    themeId,
    sourceType = null,
    sourceId = null,
    fieldName = null,
  }) {
    const normalizedThemeId = requireRecordId(themeId, 'themeId');
    return this.db.prepare(`
      SELECT id, theme_id AS themeId, source_type AS sourceType,
             source_id AS sourceId, field_name AS fieldName, concept,
             aliases_json AS aliasesJson, operator,
             configured_values_json AS configuredValuesJson,
             rule_source AS ruleSource, action, allow_unverified AS allowUnverified,
             enabled, updated_by AS updatedBy, created_at AS createdAt,
             updated_at AS updatedAt
      FROM semantic_value_overrides
      WHERE theme_id = ?
        AND (? IS NULL OR source_type = ?)
        AND (? IS NULL OR source_id = ?)
        AND (? IS NULL OR field_name = ?)
      ORDER BY id
    `).all(
      normalizedThemeId,
      sourceType || null,
      sourceType || null,
      sourceId == null ? null : String(sourceId),
      sourceId == null ? null : String(sourceId),
      fieldName || null,
      fieldName || null,
    ).map((row) => ({
      ...row,
      aliases: parseJson(row.aliasesJson, []),
      configuredValues: parseJson(row.configuredValuesJson, []),
      allowUnverified: asBool(row.allowUnverified),
      enabled: asBool(row.enabled),
    }));
  }

  createSemanticValueRefreshJob({
    themeId,
    sourceType,
    sourceId,
    fieldName,
    trigger = 'MANUAL',
    requestedBy = null,
  }) {
    const normalizedThemeId = requireRecordId(themeId, 'themeId');
    const result = this.db.prepare(`
      INSERT INTO semantic_value_refresh_jobs
        (theme_id, source_type, source_id, field_name, trigger, status,
         requested_by, scanned_count, added_count, removed_count,
         changed_count, error_json, started_at, finished_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'PENDING', ?, 0, 0, 0, 0, '{}', null, null, ?)
    `).run(
      normalizedThemeId,
      String(sourceType),
      String(sourceId),
      String(fieldName),
      String(trigger ?? 'MANUAL'),
      requestedBy ? Number(requestedBy) : null,
      nowIso(),
    );
    return Number(result.lastInsertRowid);
  }

  updateSemanticValueRefreshJob(jobId, update = {}) {
    const normalizedJobId = requireRecordId(jobId, 'jobId');
    const job = this.db.prepare(`
      SELECT id FROM semantic_value_refresh_jobs WHERE id = ?
    `).get(normalizedJobId);
    if (!job) {
      return null;
    }
    this.db.prepare(`
      UPDATE semantic_value_refresh_jobs
      SET status = COALESCE(?, status),
          scanned_count = COALESCE(?, scanned_count),
          added_count = COALESCE(?, added_count),
          removed_count = COALESCE(?, removed_count),
          changed_count = COALESCE(?, changed_count),
          error_json = COALESCE(?, error_json),
          started_at = COALESCE(?, started_at),
          finished_at = COALESCE(?, finished_at)
      WHERE id = ?
    `).run(
      update.status ?? null,
      Number.isInteger(update.scannedCount) ? Number(update.scannedCount) : null,
      Number.isInteger(update.addedCount) ? Number(update.addedCount) : null,
      Number.isInteger(update.removedCount) ? Number(update.removedCount) : null,
      Number.isInteger(update.changedCount) ? Number(update.changedCount) : null,
      update.error ? asJson(update.error) : null,
      update.startedAt ?? null,
      update.finishedAt ?? null,
      normalizedJobId,
    );
    return this.getSemanticValueRefreshJob(normalizedJobId);
  }

  getSemanticValueRefreshJob(jobId) {
    const row = this.db.prepare(`
      SELECT id, theme_id AS themeId, source_type AS sourceType,
             source_id AS sourceId, field_name AS fieldName, trigger,
             status, requested_by AS requestedBy, scanned_count AS scannedCount,
             added_count AS addedCount, removed_count AS removedCount,
             changed_count AS changedCount, error_json AS errorJson,
             started_at AS startedAt, finished_at AS finishedAt,
             created_at AS createdAt
      FROM semantic_value_refresh_jobs
      WHERE id = ?
    `).get(Number(jobId));
    return row ? { ...row, error: parseJson(row.errorJson, {}) } : null;
  }

  createSemanticValueAuditLog({
    themeId,
    sourceType,
    sourceId,
    fieldName,
    action,
    beforeChecksum = '',
    afterChecksum = '',
    actorId = null,
  }) {
    const normalizedThemeId = requireRecordId(themeId, 'themeId');
    return this.db.prepare(`
      INSERT INTO semantic_value_audit_logs
        (theme_id, source_type, source_id, field_name, action,
         before_checksum, after_checksum, actor_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizedThemeId,
      String(sourceType),
      String(sourceId),
      String(fieldName),
      String(action ?? ''),
      String(beforeChecksum ?? ''),
      String(afterChecksum ?? ''),
      actorId ? Number(actorId) : null,
      nowIso(),
    );
  }

  logDatasetQuery(...args) {
    return this.logRepository.logDatasetQuery(...args);
  }

  logDatasetQueryAsync(...args) {
    return this.logRepository.logDatasetQueryAsync(...args);
  }

  listDatasetQueryLogs(...args) {
    return this.logRepository.listDatasetQueryLogs(...args);
  }

  listDatasetQueryLogsAsync(...args) {
    return this.logRepository.listDatasetQueryLogsAsync(...args);
  }

  getIndicator(id) {
    return this.listIndicators({ limit: 2000 }).items.find(
      (indicator) => String(indicator.id) === String(id),
    ) ?? null;
  }

  getPermissionProfile(userId) {
    const themeGrants = this.db.prepare(`
      SELECT theme_id AS themeId, can_query AS canQuery, can_manage AS canManage
      FROM user_theme_grants WHERE user_id = ?
    `).all(Number(userId)).map((row) => ({
      ...row,
      canQuery: asBool(row.canQuery),
      canManage: asBool(row.canManage),
    }));
    const indicatorGrants = this.db.prepare(`
      SELECT indicator_id AS indicatorId, can_query AS canQuery
      FROM user_indicator_grants WHERE user_id = ?
    `).all(Number(userId)).map((row) => ({
      ...row,
      canQuery: asBool(row.canQuery),
    }));
    const datasetGrants = this.db.prepare(`
      SELECT dg.dataset_id AS datasetId, d.code, d.name, dg.can_query AS canQuery
      FROM user_dataset_grants dg
      JOIN business_datasets d ON d.id = dg.dataset_id
      WHERE dg.user_id = ?
    `).all(Number(userId)).map((row) => ({
      ...row,
      canQuery: asBool(row.canQuery),
    }));
    const rowPolicies = this.db.prepare(`
      SELECT id, theme_id AS themeId, dimension, operator,
             values_json AS valuesJson, value_source AS valueSource,
             attribute_key AS attributeKey, enabled
      FROM row_policies WHERE user_id = ? ORDER BY id
    `).all(Number(userId)).map((row) => ({
      ...row,
      values: parseJson(row.valuesJson, []),
      enabled: asBool(row.enabled),
    }));
    const columnPolicies = this.db.prepare(`
      SELECT id, theme_id AS themeId, column_name AS columnName,
             action, mask_value AS maskValue, enabled
      FROM column_policies WHERE user_id = ? ORDER BY id
    `).all(Number(userId)).map((row) => ({
      ...row,
      enabled: asBool(row.enabled),
    }));

    return { themeGrants, indicatorGrants, datasetGrants, rowPolicies, columnPolicies };
  }

  replacePermissionProfile(userId, payload) {
    const timestamp = nowIso();
    const themeGrants = Array.isArray(payload.themeGrants) ? payload.themeGrants : [];
    const indicatorGrants = Array.isArray(payload.indicatorGrants) ? payload.indicatorGrants : [];
    const datasetGrants = Array.isArray(payload.datasetGrants) ? payload.datasetGrants : [];
    const rowPolicies = Array.isArray(payload.rowPolicies) ? payload.rowPolicies : [];
    const columnPolicies = Array.isArray(payload.columnPolicies) ? payload.columnPolicies : [];

    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM user_theme_grants WHERE user_id = ?').run(Number(userId));
      this.db.prepare('DELETE FROM user_indicator_grants WHERE user_id = ?').run(Number(userId));
      this.db.prepare('DELETE FROM user_dataset_grants WHERE user_id = ?').run(Number(userId));
      this.db.prepare('DELETE FROM row_policies WHERE user_id = ?').run(Number(userId));
      this.db.prepare('DELETE FROM column_policies WHERE user_id = ?').run(Number(userId));

      const insertThemeGrant = this.db.prepare(`
        INSERT INTO user_theme_grants (user_id, theme_id, can_query, can_manage)
        VALUES (?, ?, ?, ?)
      `);
      for (const grant of themeGrants) {
        insertThemeGrant.run(Number(userId), Number(grant.themeId),
          grant.canQuery === false ? 0 : 1, grant.canManage ? 1 : 0);
      }

      const insertIndicatorGrant = this.db.prepare(`
        INSERT INTO user_indicator_grants (user_id, indicator_id, can_query)
        VALUES (?, ?, ?)
      `);
      for (const grant of indicatorGrants) {
        insertIndicatorGrant.run(Number(userId), String(grant.indicatorId),
          grant.canQuery === false ? 0 : 1);
      }

      const insertDatasetGrant = this.db.prepare(`
        INSERT INTO user_dataset_grants (user_id, dataset_id, can_query)
        VALUES (?, ?, ?)
      `);
      for (const grant of datasetGrants) {
        insertDatasetGrant.run(
          Number(userId),
          Number(grant.datasetId),
          grant.canQuery === false ? 0 : 1,
        );
      }

      const insertRowPolicy = this.db.prepare(`
        INSERT INTO row_policies
          (user_id, theme_id, dimension, operator, values_json, value_source,
           attribute_key, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const policy of rowPolicies) {
        insertRowPolicy.run(
          Number(userId),
          policy.themeId ? Number(policy.themeId) : null,
          String(policy.dimension ?? '').trim(),
          String(policy.operator ?? 'IN').trim().toUpperCase(),
          asJson(policy.values ?? []),
          String(policy.valueSource ?? 'FIXED').trim().toUpperCase(),
          policy.attributeKey ? String(policy.attributeKey) : null,
          policy.enabled === false ? 0 : 1,
          timestamp,
          timestamp,
        );
      }

      const insertColumnPolicy = this.db.prepare(`
        INSERT INTO column_policies
          (user_id, theme_id, column_name, action, mask_value, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const policy of columnPolicies) {
        insertColumnPolicy.run(
          Number(userId),
          policy.themeId ? Number(policy.themeId) : null,
          String(policy.columnName ?? '').trim(),
          String(policy.action ?? 'MASK').trim().toUpperCase(),
          String(policy.maskValue ?? '***'),
          policy.enabled === false ? 0 : 1,
          timestamp,
          timestamp,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getPermissionProfile(userId);
  }

  grantDatasetAccess(userId, datasetId, canQuery = true) {
    this.db.prepare(`
      INSERT INTO user_dataset_grants (user_id, dataset_id, can_query)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, dataset_id) DO UPDATE SET can_query = excluded.can_query
    `).run(Number(userId), Number(datasetId), canQuery ? 1 : 0);
  }

  createRowPolicy(policy) {
    const timestamp = nowIso();
    const result = this.db.prepare(`
      INSERT INTO row_policies
        (user_id, theme_id, dimension, operator, values_json, value_source,
         attribute_key, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(policy.userId),
      policy.themeId ? Number(policy.themeId) : null,
      String(policy.dimension),
      String(policy.operator ?? 'IN').toUpperCase(),
      asJson(policy.values ?? []),
      String(policy.valueSource ?? 'FIXED').toUpperCase(),
      policy.attributeKey ?? null,
      policy.enabled === false ? 0 : 1,
      timestamp,
      timestamp,
    );
    return Number(result.lastInsertRowid);
  }

  saveConversation({ userId, themeId, question, answer }) {
    const timestamp = nowIso();
    const result = this.db.prepare(`
      INSERT INTO conversations (user_id, theme_id, question, answer_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(Number(userId), Number(themeId), question, asJson(answer), timestamp);
    return Number(result.lastInsertRowid);
  }

  createChatSession({ userId, themeId, title = '新会话', modelId = null }) {
    const timestamp = nowIso();
    const result = this.db.prepare(`
      INSERT INTO chat_sessions
        (user_id, theme_id, title, model_id, summary, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', 1, ?, ?)
    `).run(
      Number(userId),
      Number(themeId),
      String(title || '新会话').trim(),
      modelId ? Number(modelId) : null,
      timestamp,
      timestamp,
    );
    return this.getChatSession(Number(result.lastInsertRowid), userId);
  }

  getChatSession(id, userId = null) {
    const row = this.db.prepare(`
      SELECT s.id, s.user_id AS userId, s.theme_id AS themeId,
             t.name AS themeName, s.title, s.model_id AS modelId,
             s.summary, s.status,
             s.created_at AS createdAt, s.updated_at AS updatedAt,
             (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS messageCount
      FROM chat_sessions s
      JOIN themes t ON t.id = s.theme_id
      WHERE s.id = ? AND (? IS NULL OR s.user_id = ?)
    `).get(Number(id), userId ? Number(userId) : null, userId ? Number(userId) : null);
    return row ?? null;
  }

  listChatSessions(userId, limit = 100) {
    return this.db.prepare(`
      SELECT s.id, s.user_id AS userId, s.theme_id AS themeId,
             t.name AS themeName, s.title, s.model_id AS modelId,
             s.summary, s.status,
             s.created_at AS createdAt, s.updated_at AS updatedAt,
             (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS messageCount
      FROM chat_sessions s
      JOIN themes t ON t.id = s.theme_id
      WHERE s.user_id = ? AND s.status = 1
      ORDER BY s.updated_at DESC, s.id DESC
      LIMIT ?
    `).all(Number(userId), Math.max(1, Math.min(Number(limit) || 100, 500)));
  }

  updateChatSession(id, { title, summary, status, modelId } = {}) {
    const current = this.getChatSession(id);
    if (!current) {
      return null;
    }
    this.db.prepare(`
      UPDATE chat_sessions
      SET title = ?, summary = ?, status = ?,
          model_id = COALESCE(?, model_id), updated_at = ?
      WHERE id = ?
    `).run(
      title === undefined ? current.title : String(title).trim(),
      summary === undefined ? current.summary : String(summary),
      status === undefined ? current.status : Number(status),
      modelId === undefined ? null : (modelId ? Number(modelId) : null),
      nowIso(),
      Number(id),
    );
    return this.getChatSession(id);
  }

  deleteChatSession(id, userId) {
    return this.db.prepare(`
      DELETE FROM chat_sessions WHERE id = ? AND user_id = ?
    `).run(Number(id), Number(userId)).changes > 0;
  }

  appendChatMessage({ sessionId, userId, role, content, result = {} }) {
    const timestamp = nowIso();
    const statementResult = this.db.prepare(`
      INSERT INTO chat_messages
        (session_id, user_id, role, content, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      Number(sessionId),
      Number(userId),
      String(role),
      String(content ?? ''),
      asJson(result),
      timestamp,
    );
    this.db.prepare(`
      UPDATE chat_sessions SET updated_at = ? WHERE id = ?
    `).run(timestamp, Number(sessionId));
    return {
      id: Number(statementResult.lastInsertRowid),
      sessionId: Number(sessionId),
      userId: Number(userId),
      role: String(role),
      content: String(content ?? ''),
      result,
      createdAt: timestamp,
    };
  }

  listChatMessages(sessionId, userId, limit = 50) {
    const session = this.getChatSession(sessionId, userId);
    if (!session) {
      return null;
    }
    const rows = this.db.prepare(`
      SELECT m.id, m.sessionId, m.userId, m.role, m.content,
             m.resultJson, m.createdAt,
             a.id AS artifactId, a.workspace_id AS workspaceId,
             a.title AS artifactTitle, a.artifact_type AS artifactType
      FROM (
        SELECT id, session_id AS sessionId, user_id AS userId, role, content,
               result_json AS resultJson, created_at AS createdAt
        FROM chat_messages
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?
      ) m
      LEFT JOIN workspace_artifacts a
        ON a.id = (
          SELECT candidate.id
          FROM workspace_artifacts candidate
          WHERE candidate.message_id = m.id AND candidate.status = 1
          ORDER BY candidate.updated_at DESC, candidate.id DESC
          LIMIT 1
        )
      ORDER BY m.id ASC
    `).all(Number(sessionId), Math.max(1, Math.min(Number(limit) || 50, 200)));
    return rows.map((row) => {
      const result = parseJson(row.resultJson, {});
      return {
        ...row,
        result: {
          ...result,
          artifactId: row.artifactId ?? result.artifactId ?? null,
          workspaceId: row.workspaceId ?? result.workspaceId ?? null,
          artifactTitle: row.artifactTitle ?? result.artifactTitle ?? null,
          artifactType: row.artifactType ?? result.artifactType ?? null,
        },
      };
    });
  }

  getChatMessage(id, userId) {
    const row = this.db.prepare(`
      SELECT id, session_id AS sessionId, user_id AS userId, role, content,
             result_json AS resultJson, created_at AS createdAt
      FROM chat_messages
      WHERE id = ? AND user_id = ?
    `).get(Number(id), Number(userId));
    return row ? {
      ...row,
      result: parseJson(row.resultJson, {}),
    } : null;
  }

  ensureWorkspace({ userId, themeId, sessionId, name = '问数工作区' }) {
    return this.workspaceRepository.ensureWorkspace({ userId, themeId, sessionId, name });
  }

  getWorkspace(id, userId = null) {
    return this.workspaceRepository.getWorkspace(id, userId);
  }

  getWorkspaceBySession(sessionId, userId = null) {
    return this.workspaceRepository.getWorkspaceBySession(sessionId, userId);
  }

  updateWorkspace(id, userId, { name } = {}) {
    return this.workspaceRepository.updateWorkspace(id, userId, { name });
  }

  createWorkspaceArtifact({
    workspaceId, userId, sessionId, messageId, conversationId,
    artifactType = 'TABLE', title = '', metadata = {}, payload = {},
  }) {
    return this.workspaceRepository.createWorkspaceArtifact({
      workspaceId, userId, sessionId, messageId, conversationId,
      artifactType, title, metadata, payload,
    });
  }

  appendWorkspaceArtifactVersion({
    artifactId, userId, operation = {}, payload = {}, metadata = undefined,
  }) {
    return this.workspaceRepository.appendWorkspaceArtifactVersion({
      artifactId, userId, operation, payload, metadata,
    });
  }

  getWorkspaceArtifact(id, userId = null) {
    return this.workspaceRepository.getWorkspaceArtifact(id, userId);
  }

  listWorkspaceArtifacts(workspaceId, userId = null) {
    return this.workspaceRepository.listWorkspaceArtifacts(workspaceId, userId);
  }

  bindWorkspaceArtifactsToMessage({ artifactIds = [], userId, messageId }) {
    return this.workspaceRepository.bindWorkspaceArtifactsToMessage({ artifactIds, userId, messageId });
  }

  updateThemePrompt(id, systemPrompt) {
    const current = this.getTheme(id);
    if (!current) {
      return null;
    }
    this.db.prepare(`
      UPDATE themes SET system_prompt = ?, updated_at = ? WHERE id = ?
    `).run(String(systemPrompt ?? ''), nowIso(), Number(id));
    return this.getTheme(id);
  }

  setThemeStatus(id, status) {
    if (!this.getTheme(id)) {
      return null;
    }
    this.db.prepare(`
      UPDATE themes SET status = ?, updated_at = ? WHERE id = ?
    `).run(Number(status) === 0 ? 0 : 1, nowIso(), Number(id));
    return this.getTheme(id);
  }

  addAuditLog(...args) {
    return this.logRepository.addAuditLog(...args);
  }

  addAuditLogAsync(...args) {
    return this.logRepository.addAuditLogAsync(...args);
  }

  // ---- MCP: API Key 生命周期（仅存哈希，不存明文）----
  createMcpApiKey({ name, tenantId, createdBy, scopes = 'mcp' }) {
    const rawKey = `mcp_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyId = `key_${crypto.randomBytes(6).toString('hex')}`;
    this.db.prepare(`
      INSERT INTO mcp_api_keys (key_id, key_hash, name, tenant_id, scopes, created_by, created_at, revoked)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      keyId,
      keyHash,
      String(name ?? 'mcp'),
      String(tenantId ?? 'default'),
      JSON.stringify(scopes),
      Number(createdBy) || null,
      nowIso(),
    );
    return { keyId, rawKey, name: name ?? 'mcp', tenantId: tenantId ?? 'default' };
  }

  getMcpApiKeyByHash(keyHash) {
    const row = this.db.prepare(`
      SELECT key_id AS keyId, name, tenant_id AS tenantId, scopes, created_at AS createdAt, revoked
      FROM mcp_api_keys WHERE key_hash = ? AND revoked = 0
    `).get(String(keyHash ?? ''));
    if (!row) {
      return null;
    }
    return { ...row, scopes: parseJson(row.scopes, 'mcp') };
  }

  listMcpApiKeys() {
    return this.db.prepare(`
      SELECT key_id AS keyId, name, tenant_id AS tenantId, scopes, created_at AS createdAt, revoked
      FROM mcp_api_keys ORDER BY created_at DESC
    `).all().map((row) => ({ ...row, scopes: parseJson(row.scopes, 'mcp') }));
  }

  revokeMcpApiKey(keyId) {
    return this.db.prepare('UPDATE mcp_api_keys SET revoked = 1 WHERE key_id = ?')
      .run(String(keyId)).changes > 0;
  }

  // ---- MCP: 查询契约持久化（resolve_query 冻结，execute_query 取用）----
  saveMcpQueryContract({
    contractId, tenantId, userId, themeId,
    sourceType, indicatorId, datasetId, contractJson, status = 'FROZEN', expiresAt,
  }) {
    this.db.prepare(`
      INSERT INTO mcp_query_contracts
        (contract_id, tenant_id, user_id, theme_id, source_type, indicator_id, dataset_id,
         contract_json, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(contractId),
      String(tenantId ?? 'default'),
      Number(userId) || null,
      themeId ? Number(themeId) : null,
      String(sourceType),
      indicatorId ? String(indicatorId) : null,
      datasetId ? String(datasetId) : null,
      JSON.stringify(contractJson),
      String(status),
      nowIso(),
      expiresAt ?? null,
    );
    return String(contractId);
  }

  getMcpQueryContract(contractId) {
    const row = this.db.prepare(`
      SELECT contract_id AS contractId, tenant_id AS tenantId, user_id AS userId, theme_id AS themeId,
             source_type AS sourceType, indicator_id AS indicatorId, dataset_id AS datasetId,
             contract_json AS contractJson, status, created_at AS createdAt, expires_at AS expiresAt
      FROM mcp_query_contracts WHERE contract_id = ?
    `).get(String(contractId));
    if (!row) {
      return null;
    }
    return { ...row, contractJson: parseJson(row.contractJson, null) };
  }

  listAuditLogs(...args) {
    return this.logRepository.listAuditLogs(...args);
  }

  listAuditLogsAsync(...args) {
    return this.logRepository.listAuditLogsAsync(...args);
  }

  getTraceEvidence(traceId) {
    const id = String(traceId ?? '').trim();
    if (!id) {
      return null;
    }
    const plans = this.db.prepare(`
      SELECT id, user_id AS userId, theme_id AS themeId, session_id AS sessionId,
             source_type AS sourceType, dataset_id AS datasetId,
             compiler_version AS compilerVersion, question, status,
             plan_json AS planJson, validation_json AS validationJson,
             evidence_json AS evidenceJson, created_at AS createdAt
      FROM query_plans WHERE trace_id = ? ORDER BY created_at
    `).all(id).map((row) => ({
      ...row,
      plan: parseJson(row.planJson, {}),
      validation: parseJson(row.validationJson, {}),
      evidence: parseJson(row.evidenceJson, {}),
    }));
    const audit = this.listAuditLogs(500, { traceId: id });
    const llmCalls = this.listLlmLogs(1000, { traceId: id });
    const datasetQueries = this.listDatasetQueryLogs(500, { traceId: id });
    return {
      traceId: id,
      queryPlans: plans,
      audit,
      llmCalls,
      datasetQueries,
      counts: {
        queryPlans: plans.length,
        audit: audit.length,
        llmCalls: llmCalls.length,
        datasetQueries: datasetQueries.length,
      },
    };
  }

  saveQueryPlan({
    id,
    userId,
    themeId,
    sessionId,
    sourceType = 'INDICATOR',
    datasetId = null,
    compilerVersion = null,
    traceId = currentTraceId(),
    question,
    status = 'COMPILED',
    plan,
    validation,
    evidence = {},
  }) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO query_plans
        (id, user_id, theme_id, session_id, source_type, dataset_id,
         compiler_version, trace_id, question, status,
         plan_json, validation_json, evidence_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_type = excluded.source_type,
        dataset_id = excluded.dataset_id,
        compiler_version = excluded.compiler_version,
        trace_id = excluded.trace_id,
        status = excluded.status,
        plan_json = excluded.plan_json,
        validation_json = excluded.validation_json,
        evidence_json = excluded.evidence_json
    `).run(
      String(id),
      Number(userId),
      Number(themeId),
      sessionId ? Number(sessionId) : null,
      String(sourceType),
      datasetId ? String(datasetId) : null,
      // Prefer the frozen contract's version; fall back to the platform compiler
      // version so every persisted plan is replay-attributable (P0-7).
      String(
        compilerVersion
        ?? plan?.compilerVersion
        ?? plan?.queryContract?.compilerVersion
        ?? CONTRACT_COMPILER_VERSION,
      ),
      traceId ? String(traceId) : null,
      String(question ?? ''),
      String(status),
      asJson(plan),
      asJson(validation),
      asJson(evidence),
      timestamp,
    );
    return this.getQueryPlan(id, userId);
  }

  getQueryPlan(id, userId = null) {
    const row = this.db.prepare(`
      SELECT id, user_id AS userId, theme_id AS themeId, session_id AS sessionId,
             source_type AS sourceType, dataset_id AS datasetId,
             compiler_version AS compilerVersion, trace_id AS traceId,
             question, status, plan_json AS planJson, validation_json AS validationJson,
             evidence_json AS evidenceJson, created_at AS createdAt
      FROM query_plans
      WHERE id = ? AND (? IS NULL OR user_id = ?)
    `).get(String(id), userId ? Number(userId) : null, userId ? Number(userId) : null);
    return row ? {
      ...row,
      plan: parseJson(row.planJson, {}),
      validation: parseJson(row.validationJson, {}),
      evidence: parseJson(row.evidenceJson, {}),
    } : null;
  }

  listQueryPlans({ userId = null, limit = 100 } = {}) {
    const rows = this.db.prepare(`
      SELECT id, user_id AS userId, theme_id AS themeId, session_id AS sessionId,
             source_type AS sourceType, dataset_id AS datasetId,
             compiler_version AS compilerVersion, trace_id AS traceId,
             question, status, plan_json AS planJson, validation_json AS validationJson,
             evidence_json AS evidenceJson, created_at AS createdAt
      FROM query_plans
      WHERE (? IS NULL OR user_id = ?)
      ORDER BY created_at DESC
      LIMIT ?
    `).all(
      userId ? Number(userId) : null,
      userId ? Number(userId) : null,
      Math.max(1, Math.min(Number(limit) || 100, 500)),
    );
    return rows.map((row) => ({
      ...row,
      plan: parseJson(row.planJson, {}),
      validation: parseJson(row.validationJson, {}),
      evidence: parseJson(row.evidenceJson, {}),
    }));
  }

  saveFeedback({
    userId,
    themeId,
    sessionId,
    messageId,
    question,
    correct,
    comment,
    corrected,
  }) {
    const timestamp = nowIso();
    const result = this.db.prepare(`
      INSERT INTO qa_feedback
        (user_id, theme_id, session_id, message_id, question, correct,
         comment, corrected_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(userId),
      Number(themeId),
      sessionId ? Number(sessionId) : null,
      messageId ? Number(messageId) : null,
      String(question ?? ''),
      correct ? 1 : 0,
      String(comment ?? ''),
      asJson(corrected ?? {}),
      timestamp,
    );
    return Number(result.lastInsertRowid);
  }

  listFeedback({ themeId = null, correct = null, limit = 100 } = {}) {
    const rows = this.db.prepare(`
      SELECT f.id, f.user_id AS userId, u.display_name AS userName,
             f.theme_id AS themeId, t.name AS themeName,
             f.session_id AS sessionId, f.message_id AS messageId,
             f.question, f.correct, f.comment, f.corrected_json AS correctedJson,
             f.created_at AS createdAt
      FROM qa_feedback f
      LEFT JOIN app_users u ON u.id = f.user_id
      LEFT JOIN themes t ON t.id = f.theme_id
      WHERE (? IS NULL OR f.theme_id = ?)
        AND (? IS NULL OR f.correct = ?)
      ORDER BY f.id DESC
      LIMIT ?
    `).all(
      themeId ? Number(themeId) : null,
      themeId ? Number(themeId) : null,
      correct === null || correct === undefined ? null : (correct ? 1 : 0),
      correct === null || correct === undefined ? null : (correct ? 1 : 0),
      Math.max(1, Math.min(Number(limit) || 100, 500)),
    );
    return rows.map((row) => ({
      ...row,
      correct: asBool(row.correct),
      corrected: parseJson(row.correctedJson, {}),
    }));
  }

  recordKnowledgeGap({ term, kind = 'QUESTION', source = 'ASK', context = {} }) {
    const normalized = String(term ?? '').trim();
    if (normalized.length < 2 || normalized.length > 256) {
      return null;
    }
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO knowledge_gaps
        (term, kind, source, count, dismissed, resolved, resolution_json,
         context_json, first_seen, last_seen)
      VALUES (?, ?, ?, 1, 0, 0, '{}', ?, ?, ?)
      ON CONFLICT(term, kind) DO UPDATE SET
        count = count + 1,
        source = excluded.source,
        context_json = excluded.context_json,
        last_seen = excluded.last_seen
    `).run(
      normalized,
      String(kind).toUpperCase(),
      String(source).toUpperCase(),
      asJson(context),
      timestamp,
      timestamp,
    );
    return this.db.prepare(`
      SELECT id, term, kind, source, count, dismissed, resolved,
             resolution_json AS resolutionJson, context_json AS contextJson,
             first_seen AS firstSeen, last_seen AS lastSeen
      FROM knowledge_gaps WHERE term = ? AND kind = ?
    `).get(normalized, String(kind).toUpperCase());
  }

  listKnowledgeGaps({ includeClosed = false, limit = 200 } = {}) {
    return this.db.prepare(`
      SELECT id, term, kind, source, count, dismissed, resolved,
             resolution_json AS resolutionJson, context_json AS contextJson,
             first_seen AS firstSeen, last_seen AS lastSeen
      FROM knowledge_gaps
      WHERE (? = 1 OR (dismissed = 0 AND resolved = 0))
      ORDER BY count DESC, last_seen DESC
      LIMIT ?
    `).all(
      includeClosed ? 1 : 0,
      Math.max(1, Math.min(Number(limit) || 200, 1000)),
    ).map((row) => ({
      ...row,
      dismissed: asBool(row.dismissed),
      resolved: asBool(row.resolved),
      resolution: parseJson(row.resolutionJson, {}),
      context: parseJson(row.contextJson, {}),
    }));
  }

  updateKnowledgeGap(id, { dismissed, resolved, resolution } = {}) {
    const current = this.db.prepare(`
      SELECT id, dismissed, resolved, resolution_json AS resolutionJson
      FROM knowledge_gaps WHERE id = ?
    `).get(Number(id));
    if (!current) {
      return null;
    }
    this.db.prepare(`
      UPDATE knowledge_gaps
      SET dismissed = ?, resolved = ?, resolution_json = ?
      WHERE id = ?
    `).run(
      dismissed === undefined ? current.dismissed : (dismissed ? 1 : 0),
      resolved === undefined ? current.resolved : (resolved ? 1 : 0),
      resolution === undefined ? current.resolutionJson : asJson(resolution),
      Number(id),
    );
    return this.listKnowledgeGaps({ includeClosed: true, limit: 1000 })
      .find((item) => Number(item.id) === Number(id)) ?? null;
  }

  logLlmCall(...args) {
    return this.logRepository.logLlmCall(...args);
  }

  logLlmCallAsync(...args) {
    return this.logRepository.logLlmCallAsync(...args);
  }

  listLlmLogs(...args) {
    return this.logRepository.listLlmLogs(...args);
  }

  listLlmLogsAsync(...args) {
    return this.logRepository.listLlmLogsAsync(...args);
  }

  llmLogStats(...args) {
    return this.logRepository.llmLogStats(...args);
  }

  llmLogStatsAsync(...args) {
    return this.logRepository.llmLogStatsAsync(...args);
  }

  // P0-4：按用户/主题/时间窗口汇总已消耗的 Token（total_tokens，缺字段时回退 prompt+completion）。
  // created_at 为 ISO 字符串，按字典序比较即可覆盖时间窗口（与 logLlmCall 写入格式一致）。
  sumTokenUsage(...args) {
    return this.logRepository.sumTokenUsage(...args);
  }

  sumTokenUsageAsync(...args) {
    return this.logRepository.sumTokenUsageAsync(...args);
  }

  getPlatformSetting(key, fallback = null) {
    const row = this.db.prepare(`
      SELECT key, value_json AS valueJson, updated_at AS updatedAt
      FROM platform_settings
      WHERE key = ?
    `).get(String(key ?? '').trim());
    if (!row) {
      return fallback;
    }
    return {
      ...row,
      value: parseJson(row.valueJson, fallback),
    };
  }

  savePlatformSetting(key, value) {
    const normalizedKey = String(key ?? '').trim();
    if (!normalizedKey) {
      throw new Error('setting key is required');
    }
    this.db.prepare(`
      INSERT INTO platform_settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(normalizedKey, JSON.stringify(value), nowIso());
    return this.getPlatformSetting(normalizedKey);
  }

  getUserPreferences(userId) {
    const record = this.getPlatformSetting(
      `user_preferences:${Number(userId)}`,
      {},
    );
    const value = record && typeof record === 'object'
      ? record.value
      : record;
    return value && typeof value === 'object' ? value : {};
  }

  saveUserPreferences(userId, patch) {
    const current = this.getUserPreferences(userId);
    const next = {
      ...current,
      ...(patch && typeof patch === 'object' ? patch : {}),
    };
    this.savePlatformSetting(`user_preferences:${Number(userId)}`, next);
    return next;
  }

  listPlatformSettings() {
    return this.db.prepare(`
      SELECT key, value_json AS valueJson, updated_at AS updatedAt
      FROM platform_settings
      ORDER BY key
    `).all().map((row) => ({
      ...row,
      value: parseJson(row.valueJson, null),
    }));
  }

  countRows(table) {
    const allowed = new Set([
      'app_users',
      'themes',
      'indicator_cache',
      'indicator_types',
      'conversations',
      'chat_sessions',
      'chat_messages',
      'workspaces',
      'workspace_artifacts',
      'artifact_versions',
      'audit_logs',
      'query_plans',
      'qa_feedback',
      'knowledge_gaps',
      'llm_call_logs',
      'data_sources',
      'business_datasets',
      'models',
      'dataset_fields',
      'semantic_value_domains',
      'theme_semantic_value_domains',
      'dataset_query_logs',
      'platform_settings',
    ]);
    if (!allowed.has(table)) {
      throw new Error(`unsupported table: ${table}`);
    }
    return this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  }
}

export { parseJson };
