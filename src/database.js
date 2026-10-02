import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { currentTraceId } from './trace.js';
import { CONTRACT_COMPILER_VERSION } from './contractVersion.js';
import { normalizeSemanticPolicy } from './semanticPolicy.js';
import {
  mergeValueCandidates,
  normalizeValueOrigin,
  VALUE_DOMAIN_STATUSES,
} from './semanticDomain.js';

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
  constructor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
    this.seed();
    this.migrateThemeSemanticValueDomains();
    this.migrateThemeSemanticValueSources();
    this.migrateSemanticValueGovernanceV1();
    this.migrateSkillDefinitions();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'ANALYST',
        status INTEGER NOT NULL DEFAULT 1,
        attributes_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        key TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS themes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        indicator_ids_json TEXT NOT NULL DEFAULT '[]',
        allowed_dimensions_json TEXT NOT NULL DEFAULT '[]',
        llm_config_json TEXT NOT NULL DEFAULT '{}',
        dataset_ids_json TEXT NOT NULL DEFAULT '[]',
        business_dataset_ids_json TEXT NOT NULL DEFAULT '[]',
        primary_business_dataset_id INTEGER,
        semantic_value_config_json TEXT NOT NULL DEFAULT '{}',
        semantic_policy_json TEXT NOT NULL DEFAULT '{}',
        examples_json TEXT NOT NULL DEFAULT '[]',
        default_chart TEXT NOT NULL DEFAULT 'auto',
        status INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skills (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'CORE',
        kind TEXT NOT NULL DEFAULT 'TOOL',
        tool_name TEXT,
        instruction TEXT NOT NULL DEFAULT '',
        default_enabled INTEGER NOT NULL DEFAULT 1,
        status INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS theme_skills (
        theme_id INTEGER NOT NULL,
        skill_code TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (theme_id, skill_code),
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE,
        FOREIGN KEY (skill_code) REFERENCES skills(code) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_theme_grants (
        user_id INTEGER NOT NULL,
        theme_id INTEGER NOT NULL,
        can_query INTEGER NOT NULL DEFAULT 1,
        can_manage INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, theme_id),
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_indicator_grants (
        user_id INTEGER NOT NULL,
        indicator_id TEXT NOT NULL,
        can_query INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (user_id, indicator_id),
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_dataset_grants (
        user_id INTEGER NOT NULL,
        dataset_id INTEGER NOT NULL,
        can_query INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (user_id, dataset_id),
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
        FOREIGN KEY (dataset_id) REFERENCES business_datasets(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS data_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        db_type TEXT NOT NULL DEFAULT 'DORIS',
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        database_name TEXT NOT NULL,
        username TEXT NOT NULL,
        encrypted_password TEXT NOT NULL,
        options_json TEXT NOT NULL DEFAULT '{}',
        status INTEGER NOT NULL DEFAULT 1,
        last_test_at TEXT,
        last_test_ok INTEGER,
        last_test_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS business_datasets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        datasource_id INTEGER NOT NULL,
        schema_name TEXT NOT NULL,
        primary_table TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        status INTEGER NOT NULL DEFAULT 1,
        last_synced_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (datasource_id) REFERENCES data_sources(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS dataset_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset_id INTEGER NOT NULL,
        field_name TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        data_type TEXT NOT NULL DEFAULT '',
        semantic_type TEXT NOT NULL DEFAULT 'STRING',
        role TEXT NOT NULL DEFAULT 'DIMENSION',
        aggregator TEXT NOT NULL DEFAULT 'NONE',
        description TEXT NOT NULL DEFAULT '',
        allowed_operators_json TEXT NOT NULL DEFAULT '[]',
        ordinal_position INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        UNIQUE (dataset_id, field_name),
        FOREIGN KEY (dataset_id) REFERENCES business_datasets(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS dataset_query_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        session_id INTEGER,
        trace_id TEXT,
        dataset_id INTEGER NOT NULL,
        sql_text TEXT NOT NULL,
        row_count INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 0,
        error_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS semantic_value_domains (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        value TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        description TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'DESCRIPTION',
        confidence REAL NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (source_type, source_id, field_name, normalized_value)
      );

      CREATE TABLE IF NOT EXISTS theme_semantic_value_domains (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        theme_id INTEGER NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        value TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        description TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'DESCRIPTION',
        confidence REAL NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (theme_id, source_type, source_id, field_name, normalized_value),
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS semantic_value_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        theme_id INTEGER NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'UNKNOWN',
        origin_mask_json TEXT NOT NULL DEFAULT '[]',
        value_count INTEGER NOT NULL DEFAULT 0,
        sample_size INTEGER NOT NULL DEFAULT 0,
        checksum TEXT NOT NULL DEFAULT '',
        scope_signature TEXT NOT NULL DEFAULT '',
        schema_hash TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        refreshed_at TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (theme_id, source_type, source_id, field_name, version),
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS semantic_value_snapshot_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL,
        value TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        origin TEXT NOT NULL,
        origin_ref TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE (snapshot_id, normalized_value),
        FOREIGN KEY (snapshot_id) REFERENCES semantic_value_snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS semantic_value_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        theme_id INTEGER NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        concept TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        operator TEXT NOT NULL DEFAULT 'IN',
        configured_values_json TEXT NOT NULL DEFAULT '[]',
        rule_source TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL DEFAULT 'ENUM_MAPPING',
        allow_unverified INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_by INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (theme_id, source_type, source_id, field_name, concept, action),
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS semantic_value_refresh_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        theme_id INTEGER NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        trigger TEXT NOT NULL DEFAULT 'MANUAL',
        status TEXT NOT NULL DEFAULT 'PENDING',
        requested_by INTEGER,
        scanned_count INTEGER NOT NULL DEFAULT 0,
        added_count INTEGER NOT NULL DEFAULT 0,
        removed_count INTEGER NOT NULL DEFAULT 0,
        changed_count INTEGER NOT NULL DEFAULT 0,
        error_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS semantic_value_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        theme_id INTEGER NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        action TEXT NOT NULL,
        before_checksum TEXT NOT NULL DEFAULT '',
        after_checksum TEXT NOT NULL DEFAULT '',
        actor_id INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS row_policies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        theme_id INTEGER,
        dimension TEXT NOT NULL,
        operator TEXT NOT NULL,
        values_json TEXT NOT NULL DEFAULT '[]',
        value_source TEXT NOT NULL DEFAULT 'FIXED',
        attribute_key TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS column_policies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        theme_id INTEGER,
        column_name TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT 'MASK',
        mask_value TEXT NOT NULL DEFAULT '***',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS indicator_cache (
        source_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        biz_name TEXT NOT NULL DEFAULT '',
        type_id TEXT NOT NULL DEFAULT '',
        type_name TEXT NOT NULL DEFAULT '',
        indicator_level TEXT NOT NULL DEFAULT '',
        business_caliber TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        department TEXT NOT NULL DEFAULT '',
        status INTEGER NOT NULL DEFAULT 1,
        metrics_json TEXT NOT NULL DEFAULT '[]',
        dimensions_json TEXT NOT NULL DEFAULT '[]',
        models_json TEXT NOT NULL DEFAULT '[]',
        raw_json TEXT NOT NULL DEFAULT '{}',
        synced_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS indicator_types (
        source_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT NOT NULL DEFAULT '',
        parent_id TEXT NOT NULL DEFAULT '',
        raw_json TEXT NOT NULL DEFAULT '{}',
        synced_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL DEFAULT 'null',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL DEFAULT 'deepseek',
        model_name TEXT NOT NULL,
        base_url TEXT NOT NULL DEFAULT '',
        api_key_env TEXT NOT NULL DEFAULT '',
        api_key_encrypted TEXT,
        temperature REAL NOT NULL DEFAULT 0,
        max_tokens INTEGER NOT NULL DEFAULT 0,
        timeout_ms INTEGER NOT NULL DEFAULT 60000,
        max_tool_rounds INTEGER NOT NULL DEFAULT 12,
        is_default INTEGER NOT NULL DEFAULT 0,
        status INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        theme_id INTEGER NOT NULL,
        question TEXT NOT NULL,
        answer_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        theme_id INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '新会话',
        summary TEXT NOT NULL DEFAULT '',
        status INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        theme_id INTEGER NOT NULL,
        session_id INTEGER,
        name TEXT NOT NULL DEFAULT '问数工作区',
        status INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id),
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS workspace_artifacts (
        id TEXT PRIMARY KEY,
        workspace_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        session_id INTEGER,
        message_id INTEGER,
        conversation_id INTEGER,
        artifact_type TEXT NOT NULL DEFAULT 'TABLE',
        title TEXT NOT NULL DEFAULT '',
        current_version INTEGER NOT NULL DEFAULT 1,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        status INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS artifact_versions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        operation_json TEXT NOT NULL DEFAULT '{}',
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (artifact_id, version),
        FOREIGN KEY (artifact_id) REFERENCES workspace_artifacts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        theme_id INTEGER,
        action TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        trace_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS query_plans (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        theme_id INTEGER NOT NULL,
        session_id INTEGER,
        source_type TEXT NOT NULL DEFAULT 'INDICATOR',
        dataset_id TEXT,
        compiler_version TEXT,
        trace_id TEXT,
        question TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'COMPILED',
        plan_json TEXT NOT NULL DEFAULT '{}',
        validation_json TEXT NOT NULL DEFAULT '{}',
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS qa_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        theme_id INTEGER NOT NULL,
        session_id INTEGER,
        message_id INTEGER,
        question TEXT NOT NULL DEFAULT '',
        correct INTEGER NOT NULL DEFAULT 0,
        comment TEXT NOT NULL DEFAULT '',
        corrected_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS knowledge_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'QUESTION',
        source TEXT NOT NULL DEFAULT 'ASK',
        count INTEGER NOT NULL DEFAULT 1,
        dismissed INTEGER NOT NULL DEFAULT 0,
        resolved INTEGER NOT NULL DEFAULT 0,
        resolution_json TEXT NOT NULL DEFAULT '{}',
        context_json TEXT NOT NULL DEFAULT '{}',
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        UNIQUE (term, kind)
      );

      CREATE TABLE IF NOT EXISTS llm_call_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        session_id INTEGER,
        theme_id INTEGER,
        trace_id TEXT,
        call_type TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'deepseek',
        model TEXT NOT NULL DEFAULT '',
        prompt_digest TEXT NOT NULL DEFAULT '',
        response_digest TEXT NOT NULL DEFAULT '',
        token_usage_json TEXT NOT NULL DEFAULT '{}',
        latency_ms INTEGER NOT NULL DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 0,
        error_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_indicators_name ON indicator_cache(name);
      CREATE INDEX IF NOT EXISTS idx_indicators_type ON indicator_cache(type_id);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);
      CREATE INDEX IF NOT EXISTS idx_semantic_value_domain_lookup
        ON semantic_value_domains(source_type, source_id, field_name, enabled);
      CREATE INDEX IF NOT EXISTS idx_theme_semantic_value_domain_lookup
        ON theme_semantic_value_domains(
          theme_id, source_type, source_id, field_name, enabled
        );
      CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workspace_artifacts_workspace
        ON workspace_artifacts(workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact
        ON artifact_versions(artifact_id, version DESC);
      CREATE INDEX IF NOT EXISTS idx_theme_skills_theme ON theme_skills(theme_id, enabled);
      CREATE INDEX IF NOT EXISTS idx_query_plans_user ON query_plans(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_feedback_theme ON qa_feedback(theme_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_gaps_status ON knowledge_gaps(resolved, dismissed, count DESC);
      CREATE INDEX IF NOT EXISTS idx_llm_logs_created ON llm_call_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dataset_fields_dataset ON dataset_fields(dataset_id, enabled);
      CREATE INDEX IF NOT EXISTS idx_dataset_query_logs_dataset ON dataset_query_logs(dataset_id, created_at DESC);
    `);

    this.ensureColumn('themes', 'llm_config_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('themes', 'dataset_ids_json', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn(
      'themes',
      'business_dataset_ids_json',
      "TEXT NOT NULL DEFAULT '[]'",
    );
    this.ensureColumn('themes', 'primary_business_dataset_id', 'INTEGER');
    this.ensureColumn(
      'themes',
      'semantic_value_config_json',
      "TEXT NOT NULL DEFAULT '{}'",
    );
    this.ensureColumn(
      'themes',
      'semantic_policy_json',
      "TEXT NOT NULL DEFAULT '{}'",
    );
    this.ensureColumn('themes', 'examples_json', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn('themes', 'model_ids_json', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn('themes', 'default_model_id', 'INTEGER');
    this.ensureColumn('chat_sessions', 'model_id', 'INTEGER');
    this.ensureColumn('query_plans', 'source_type', "TEXT NOT NULL DEFAULT 'INDICATOR'");
    this.ensureColumn('query_plans', 'dataset_id', 'TEXT');
    this.ensureColumn('query_plans', 'compiler_version', 'TEXT');
    this.ensureColumn('query_plans', 'trace_id', 'TEXT');
    this.ensureColumn('audit_logs', 'trace_id', 'TEXT');
    this.ensureColumn('llm_call_logs', 'trace_id', 'TEXT');
    this.ensureColumn('dataset_query_logs', 'trace_id', 'TEXT');
    this.ensureColumn('skills', 'source', "TEXT NOT NULL DEFAULT 'BUILTIN'");
    this.ensureColumn('skills', 'source_path', 'TEXT');
    this.ensureColumn('skills', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('skills', 'phase_tags_json', "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn('skills', 'content', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('skills', 'content_hash', 'TEXT');
    // Trace indexes must be created after ensureColumn so pre-existing databases
    // (whose tables predate the trace_id column) migrate cleanly.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_query_plans_trace ON query_plans(trace_id);
      CREATE INDEX IF NOT EXISTS idx_llm_logs_trace ON llm_call_logs(trace_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_trace ON audit_logs(trace_id);
      CREATE INDEX IF NOT EXISTS idx_dataset_query_logs_trace ON dataset_query_logs(trace_id);
    `);
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((item) => item.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  seed() {
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
        String(user.role ?? 'ANALYST').trim().toUpperCase(),
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
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  listUsers() {
    return this.db.prepare(`
      SELECT id, username, display_name AS displayName, role, status,
             attributes_json AS attributesJson, created_at AS createdAt,
             updated_at AS updatedAt
      FROM app_users ORDER BY id
    `).all().map((row) => ({ ...row, attributes: parseJson(row.attributesJson, {}) }));
  }

  getUser(id) {
    const row = this.db.prepare(`
      SELECT id, username, display_name AS displayName, role, status,
             attributes_json AS attributesJson, created_at AS createdAt,
             updated_at AS updatedAt
      FROM app_users WHERE id = ?
    `).get(Number(id));
    return row ? { ...row, attributes: parseJson(row.attributesJson, {}) } : null;
  }

  getUserByUsername(username) {
    const row = this.db.prepare(`
      SELECT id, username, display_name AS displayName, role, status,
             attributes_json AS attributesJson, created_at AS createdAt,
             updated_at AS updatedAt
      FROM app_users WHERE username = ?
    `).get(username);
    return row ? { ...row, attributes: parseJson(row.attributesJson, {}) } : null;
  }

  saveUser(payload, id = null) {
    const timestamp = nowIso();
    const username = String(payload.username ?? '').trim();
    const displayName = String(payload.displayName ?? '').trim();
    const role = String(payload.role ?? 'ANALYST').trim();
    const attributesJson = asJson(payload.attributes ?? {});
    if (!username || !displayName) {
      throw new Error('username and displayName are required');
    }

    if (id) {
      this.db.prepare(`
        UPDATE app_users
        SET username = ?, display_name = ?, role = ?, status = ?,
            attributes_json = ?, updated_at = ?
        WHERE id = ?
      `).run(username, displayName, role, Number(payload.status ?? 1),
        attributesJson, timestamp, Number(id));
      return this.getUser(id);
    }

    const result = this.db.prepare(`
      INSERT INTO app_users
        (username, display_name, role, status, attributes_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(username, displayName, role, Number(payload.status ?? 1),
      attributesJson, timestamp, timestamp);
    return this.getUser(Number(result.lastInsertRowid));
  }

  listModels() {
    return this.db.prepare(`
      SELECT id, name, provider, model_name AS modelName, base_url AS baseUrl,
             api_key_env AS apiKeyEnv, api_key_encrypted AS apiKeyEncrypted,
             temperature, max_tokens AS maxTokens, timeout_ms AS timeoutMs,
             max_tool_rounds AS maxToolRounds, is_default AS isDefault,
             status, created_at AS createdAt, updated_at AS updatedAt
      FROM models
      ORDER BY is_default DESC, id
    `).all().map((row) => ({
      ...row,
      isDefault: asBool(row.isDefault),
      hasApiKey: Boolean(row.apiKeyEncrypted),
      status: Number(row.status ?? 1),
    }));
  }

  getModel(id) {
    return this.listModels().find((model) => Number(model.id) === Number(id)) ?? null;
  }

  saveModel(payload, id = null) {
    const timestamp = nowIso();
    const name = String(payload.name ?? '').trim();
    const modelName = String(payload.modelName ?? payload.model ?? '').trim();
    if (!name || !modelName) {
      throw new Error('model name and model identifier are required');
    }
    const provider = String(payload.provider ?? 'deepseek').trim().toLowerCase();
    const isDefault = payload.isDefault === true;
    this.db.exec('BEGIN');
    try {
      if (isDefault) {
        this.db.prepare('UPDATE models SET is_default = 0').run();
      }
      const normalized = {
        name,
        provider,
        modelName,
        baseUrl: String(payload.baseUrl ?? '').trim(),
        apiKeyEnv: String(payload.apiKeyEnv ?? '').trim(),
        apiKeyEncrypted: String(payload.apiKeyEncrypted ?? '').trim() || null,
        temperature: Number(payload.temperature ?? 0),
        maxTokens: Math.max(0, Number(payload.maxTokens ?? 0) || 0),
        timeoutMs: Math.max(1000, Number(payload.timeoutMs ?? 60000) || 60000),
        maxToolRounds: Math.max(1, Number(payload.maxToolRounds ?? 12) || 12),
        isDefault,
        status: Number(payload.status ?? 1),
      };
      if (id) {
        this.db.prepare(`
          UPDATE models
          SET name = ?, provider = ?, model_name = ?, base_url = ?,
              api_key_env = ?, api_key_encrypted = ?,
              temperature = ?, max_tokens = ?, timeout_ms = ?,
              max_tool_rounds = ?, is_default = ?, status = ?,
              updated_at = ?
          WHERE id = ?
        `).run(
          normalized.name,
          normalized.provider,
          normalized.modelName,
          normalized.baseUrl,
          normalized.apiKeyEnv,
          normalized.apiKeyEncrypted,
          normalized.temperature,
          normalized.maxTokens,
          normalized.timeoutMs,
          normalized.maxToolRounds,
          normalized.isDefault ? 1 : 0,
          normalized.status,
          timestamp,
          Number(id),
        );
      } else {
        const result = this.db.prepare(`
          INSERT INTO models
            (name, provider, model_name, base_url, api_key_env,
             api_key_encrypted, temperature, max_tokens, timeout_ms,
             max_tool_rounds, is_default, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          normalized.name,
          normalized.provider,
          normalized.modelName,
          normalized.baseUrl,
          normalized.apiKeyEnv,
          normalized.apiKeyEncrypted,
          normalized.temperature,
          normalized.maxTokens,
          normalized.timeoutMs,
          normalized.maxToolRounds,
          normalized.isDefault ? 1 : 0,
          normalized.status,
          timestamp,
          timestamp,
        );
        id = Number(result.lastInsertRowid);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getModel(id);
  }

  setModelDefault(id) {
    const model = this.getModel(id);
    if (!model) {
      return null;
    }
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE models SET is_default = 0').run();
      this.db.prepare(`
        UPDATE models SET is_default = 1, updated_at = ? WHERE id = ?
      `).run(nowIso(), Number(id));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getModel(id);
  }

  deleteModel(id) {
    return this.db.prepare('DELETE FROM models WHERE id = ?').run(Number(id)).changes > 0;
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
      indicatorIds: parseJson(row.indicatorIdsJson, []),
      allowedDimensions: parseJson(row.allowedDimensionsJson, []),
      llmConfig: parseJson(row.llmConfigJson, {}),
      datasetIds: parseJson(row.datasetIdsJson, []),
      businessDatasetIds: parseJson(row.businessDatasetIdsJson, []),
      primaryBusinessDatasetId: row.primaryBusinessDatasetId ?? null,
      modelIds: parseJson(row.modelIdsJson, []).map(Number).filter(Number.isFinite),
      defaultModelId: row.defaultModelId ? Number(row.defaultModelId) : null,
      semanticValueConfig: parseJson(row.semanticValueConfigJson, {}),
      semanticPolicy: parseJson(row.semanticPolicyJson, {}),
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
      indicatorIds: parseJson(row.indicatorIdsJson, []),
      allowedDimensions: parseJson(row.allowedDimensionsJson, []),
      llmConfig: parseJson(row.llmConfigJson, {}),
      datasetIds: parseJson(row.datasetIdsJson, []),
      businessDatasetIds: parseJson(row.businessDatasetIdsJson, []),
      primaryBusinessDatasetId: row.primaryBusinessDatasetId ?? null,
      modelIds: parseJson(row.modelIdsJson, []).map(Number).filter(Number.isFinite),
      defaultModelId: row.defaultModelId ? Number(row.defaultModelId) : null,
      semanticValueConfig: parseJson(row.semanticValueConfigJson, {}),
      semanticPolicy: parseJson(row.semanticPolicyJson, {}),
      examples: parseJson(row.examplesJson, []),
      skillCodes: this.listThemeSkillCodes(row.id),
    } : null;
  }

  saveTheme(payload, id = null) {
    const timestamp = nowIso();
    const name = String(payload.name ?? '').trim();
    const description = String(payload.description ?? '').trim();
    const systemPrompt = String(payload.systemPrompt ?? '').trim();
    const indicatorIdList = normalizeSourceIdList(payload.indicatorIds);
    const indicatorIds = asJson(indicatorIdList);
    const allowedDimensions = asJson(payload.allowedDimensions ?? []);
    const llmConfig = asJson(payload.llmConfig ?? {});
    const datasetIds = asJson(payload.datasetIds ?? []);
    const primaryBusinessDatasetId = payload.primaryBusinessDatasetId
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

  syncExternalSkills(skills = []) {
    const timestamp = nowIso();
    const normalized = (skills ?? []).map((skill) => ({
      code: String(skill.code ?? '').trim(),
      name: String(skill.name ?? '').trim(),
      description: String(skill.description ?? '').trim(),
      instruction: String(skill.instruction ?? '').trim(),
      sourcePath: skill.sourcePath ? String(skill.sourcePath) : null,
      metadataJson: asJson(skill.metadata ?? {}),
      phaseTagsJson: asJson(skill.phaseTags ?? []),
      content: String(skill.content ?? ''),
      contentHash: String(skill.contentHash ?? ''),
    })).filter((skill) => skill.code && skill.name);

    this.db.exec('BEGIN');
    try {
      const upsert = this.db.prepare(`
        INSERT INTO skills
          (code, name, description, category, kind, tool_name, instruction,
           default_enabled, status, source, source_path, metadata_json,
           phase_tags_json, content, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, 'EXTERNAL', 'INSTRUCTION', NULL, ?, 0, 1,
                'SKILL_MD', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          instruction = excluded.instruction,
          source = excluded.source,
          source_path = excluded.source_path,
          metadata_json = excluded.metadata_json,
          phase_tags_json = excluded.phase_tags_json,
          content = excluded.content,
          content_hash = excluded.content_hash,
          status = 1,
          updated_at = excluded.updated_at
        WHERE skills.source = 'SKILL_MD'
      `);
      for (const skill of normalized) {
        upsert.run(
          skill.code,
          skill.name,
          skill.description,
          skill.instruction,
          skill.sourcePath,
          skill.metadataJson,
          skill.phaseTagsJson,
          skill.content,
          skill.contentHash,
          timestamp,
          timestamp,
        );
      }
      const codes = normalized.map((skill) => skill.code);
      if (codes.length === 0) {
        this.db.prepare("DELETE FROM skills WHERE source = 'SKILL_MD'").run();
      } else {
        const placeholders = codes.map(() => '?').join(', ');
        this.db.prepare(`
          DELETE FROM skills
          WHERE source = 'SKILL_MD' AND code NOT IN (${placeholders})
        `).run(...codes);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return normalized.length;
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
    return this.db.prepare(`
      SELECT id, code, name, db_type AS dbType, host, port,
             database_name AS databaseName, username,
             options_json AS optionsJson, status,
             last_test_at AS lastTestAt, last_test_ok AS lastTestOk,
             last_test_message AS lastTestMessage,
             created_at AS createdAt, updated_at AS updatedAt
      FROM data_sources
      ORDER BY id
    `).all().map((row) => ({
      ...row,
      options: parseJson(row.optionsJson, {}),
      lastTestOk: row.lastTestOk === null || row.lastTestOk === undefined
        ? null
        : asBool(row.lastTestOk),
    }));
  }

  getDataSource(id) {
    const row = this.db.prepare(`
      SELECT id, code, name, db_type AS dbType, host, port,
             database_name AS databaseName, username, encrypted_password AS encryptedPassword,
             options_json AS optionsJson, status,
             last_test_at AS lastTestAt, last_test_ok AS lastTestOk,
             last_test_message AS lastTestMessage,
             created_at AS createdAt, updated_at AS updatedAt
      FROM data_sources WHERE id = ?
    `).get(Number(id));
    return row ? {
      ...row,
      options: parseJson(row.optionsJson, {}),
      lastTestOk: row.lastTestOk === null || row.lastTestOk === undefined
        ? null
        : asBool(row.lastTestOk),
    } : null;
  }

  getDataSourceByCode(code) {
    const row = this.db.prepare(`
      SELECT id FROM data_sources WHERE code = ?
    `).get(String(code));
    return row ? this.getDataSource(row.id) : null;
  }

  saveDataSource(payload, id = null) {
    const timestamp = nowIso();
    const code = String(payload.code ?? '').trim();
    const name = String(payload.name ?? '').trim();
    if (!code || !name) {
      throw new Error('data source code and name are required');
    }
    const values = [
      code,
      name,
      String(payload.dbType ?? 'DORIS').toUpperCase(),
      String(payload.host ?? '').trim(),
      Number(payload.port ?? 9030),
      String(payload.databaseName ?? '').trim(),
      String(payload.username ?? '').trim(),
      String(payload.encryptedPassword ?? ''),
      asJson(payload.options ?? {}),
      Number(payload.status ?? 1),
      timestamp,
    ];
    if (id) {
      const current = this.getDataSource(id);
      if (!current) {
        throw new Error('data source not found');
      }
      this.db.prepare(`
        UPDATE data_sources
        SET code = ?, name = ?, db_type = ?, host = ?, port = ?,
            database_name = ?, username = ?, encrypted_password = ?,
            options_json = ?, status = ?, updated_at = ?
        WHERE id = ?
      `).run(
        values[0], values[1], values[2], values[3], values[4], values[5],
        values[6], values[7] || current.encryptedPassword, values[8], values[9],
        timestamp, Number(id),
      );
      return this.getDataSource(id);
    }
    const result = this.db.prepare(`
      INSERT INTO data_sources
        (code, name, db_type, host, port, database_name, username,
         encrypted_password, options_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      values[0], values[1], values[2], values[3], values[4], values[5],
      values[6], values[7], values[8], values[9], timestamp, timestamp,
    );
    return this.getDataSource(Number(result.lastInsertRowid));
  }

  updateDataSourceTest(id, { ok, message }) {
    this.db.prepare(`
      UPDATE data_sources
      SET last_test_at = ?, last_test_ok = ?, last_test_message = ?, updated_at = ?
      WHERE id = ?
    `).run(nowIso(), ok ? 1 : 0, String(message ?? ''), nowIso(), Number(id));
    return this.getDataSource(id);
  }

  listBusinessDatasets({ userId = null, includeDisabled = false } = {}) {
    const rows = this.db.prepare(`
      SELECT d.id, d.code, d.name, d.description, d.datasource_id AS datasourceId,
             s.code AS datasourceCode, s.name AS datasourceName, s.db_type AS dbType,
             d.schema_name AS schemaName, d.primary_table AS primaryTable,
             d.config_json AS configJson, d.status, d.last_synced_at AS lastSyncedAt,
             d.created_at AS createdAt, d.updated_at AS updatedAt,
             (SELECT COUNT(*) FROM dataset_fields f WHERE f.dataset_id = d.id) AS fieldCount,
             CASE WHEN ? IS NULL THEN 1 ELSE (
               SELECT COUNT(*) FROM user_dataset_grants g
               WHERE g.dataset_id = d.id AND g.user_id = ? AND g.can_query = 1
             ) END AS canQuery
      FROM business_datasets d
      JOIN data_sources s ON s.id = d.datasource_id
      WHERE (? = 1 OR d.status = 1)
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

  logDatasetQuery({
    userId = null,
    sessionId = null,
    traceId = currentTraceId(),
    datasetId,
    sqlText,
    rowCount = 0,
    latencyMs = 0,
    success,
    errorMessage = '',
  }) {
    const result = this.db.prepare(`
      INSERT INTO dataset_query_logs
        (user_id, session_id, trace_id, dataset_id, sql_text, row_count,
         latency_ms, success, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId ? Number(userId) : null,
      sessionId ? Number(sessionId) : null,
      traceId ? String(traceId) : null,
      Number(datasetId),
      String(sqlText ?? ''),
      Number(rowCount) || 0,
      Number(latencyMs) || 0,
      success ? 1 : 0,
      String(errorMessage ?? ''),
      nowIso(),
    );
    return Number(result.lastInsertRowid);
  }

  listDatasetQueryLogs(limit = 100, { traceId = null } = {}) {
    return this.db.prepare(`
      SELECT l.id, l.user_id AS userId, u.display_name AS userName,
             l.session_id AS sessionId, l.dataset_id AS datasetId,
             d.name AS datasetName, l.sql_text AS sqlText,
             l.row_count AS rowCount, l.latency_ms AS latencyMs,
             l.success, l.error_message AS errorMessage, l.trace_id AS traceId,
             l.created_at AS createdAt
      FROM dataset_query_logs l
      LEFT JOIN app_users u ON u.id = l.user_id
      LEFT JOIN business_datasets d ON d.id = l.dataset_id
      WHERE (? IS NULL OR l.trace_id = ?)
      ORDER BY l.id DESC
      LIMIT ?
    `).all(
      traceId ? String(traceId) : null,
      traceId ? String(traceId) : null,
      Math.max(1, Math.min(Number(limit) || 100, 500)),
    ).map((row) => ({
      ...row,
      success: asBool(row.success),
    }));
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

  ensureWorkspace({
    userId,
    themeId,
    sessionId,
    name = '问数工作区',
  }) {
    const existing = this.getWorkspaceBySession(sessionId, userId);
    if (existing) {
      return existing;
    }
    const timestamp = nowIso();
    const result = this.db.prepare(`
      INSERT INTO workspaces
        (user_id, theme_id, session_id, name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(
      Number(userId),
      Number(themeId),
      Number(sessionId),
      String(name || '问数工作区').trim(),
      timestamp,
      timestamp,
    );
    return this.getWorkspace(Number(result.lastInsertRowid), userId);
  }

  getWorkspace(id, userId = null) {
    const row = this.db.prepare(`
      SELECT w.id, w.user_id AS userId, w.theme_id AS themeId,
             t.name AS themeName, w.session_id AS sessionId, w.name,
             w.status, w.created_at AS createdAt, w.updated_at AS updatedAt,
             (SELECT COUNT(*) FROM workspace_artifacts a
              WHERE a.workspace_id = w.id AND a.status = 1) AS artifactCount
      FROM workspaces w
      JOIN themes t ON t.id = w.theme_id
      WHERE w.id = ? AND (? IS NULL OR w.user_id = ?)
    `).get(Number(id), userId ? Number(userId) : null, userId ? Number(userId) : null);
    return row ?? null;
  }

  getWorkspaceBySession(sessionId, userId = null) {
    const row = this.db.prepare(`
      SELECT id FROM workspaces
      WHERE session_id = ? AND (? IS NULL OR user_id = ?)
    `).get(
      Number(sessionId),
      userId ? Number(userId) : null,
      userId ? Number(userId) : null,
    );
    return row ? this.getWorkspace(row.id, userId) : null;
  }

  updateWorkspace(id, userId, { name } = {}) {
    const current = this.getWorkspace(id, userId);
    if (!current) {
      return null;
    }
    this.db.prepare(`
      UPDATE workspaces
      SET name = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(
      name === undefined ? current.name : String(name).trim(),
      nowIso(),
      Number(id),
      Number(userId),
    );
    return this.getWorkspace(id, userId);
  }

  createWorkspaceArtifact({
    workspaceId,
    userId,
    sessionId,
    messageId,
    conversationId,
    artifactType = 'TABLE',
    title = '',
    metadata = {},
    payload = {},
  }) {
    const artifactId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const timestamp = nowIso();
    const create = this.db.prepare(`
      INSERT INTO workspace_artifacts
        (id, workspace_id, user_id, session_id, message_id, conversation_id,
         artifact_type, title, current_version, metadata_json, status,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)
    `);
    const createVersion = this.db.prepare(`
      INSERT INTO artifact_versions
        (id, artifact_id, version, operation_json, payload_json, created_at)
      VALUES (?, ?, 1, ?, ?, ?)
    `);
    this.db.exec('BEGIN');
    try {
      create.run(
        artifactId,
        Number(workspaceId),
        Number(userId),
        sessionId ? Number(sessionId) : null,
        messageId ? Number(messageId) : null,
        conversationId ? Number(conversationId) : null,
        String(artifactType),
        String(title ?? ''),
        asJson(metadata),
        timestamp,
        timestamp,
      );
      createVersion.run(
        versionId,
        artifactId,
        asJson({ type: 'CREATE' }),
        asJson(payload),
        timestamp,
      );
      this.db.prepare(`
        UPDATE workspaces SET updated_at = ? WHERE id = ?
      `).run(timestamp, Number(workspaceId));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getWorkspaceArtifact(artifactId, userId);
  }

  appendWorkspaceArtifactVersion({
    artifactId,
    userId,
    operation = {},
    payload = {},
    metadata = undefined,
  }) {
    const artifact = this.getWorkspaceArtifact(artifactId, userId);
    if (!artifact) {
      throw new Error('workspace artifact not found');
    }
    const version = Number(artifact.currentVersion) + 1;
    const versionId = crypto.randomUUID();
    const timestamp = nowIso();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        INSERT INTO artifact_versions
          (id, artifact_id, version, operation_json, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        versionId,
        artifact.id,
        version,
        asJson(operation),
        asJson(payload),
        timestamp,
      );
      this.db.prepare(`
        UPDATE workspace_artifacts
        SET current_version = ?, metadata_json = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(
        version,
        asJson(metadata ?? artifact.metadata ?? {}),
        timestamp,
        artifact.id,
        Number(userId),
      );
      this.db.prepare(`
        UPDATE workspaces SET updated_at = ?
        WHERE id = (SELECT workspace_id FROM workspace_artifacts WHERE id = ?)
      `).run(timestamp, artifact.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getWorkspaceArtifact(artifact.id, userId);
  }

  getWorkspaceArtifact(id, userId = null) {
    const row = this.db.prepare(`
      SELECT a.id, a.workspace_id AS workspaceId, a.user_id AS userId,
             a.session_id AS sessionId, a.message_id AS messageId,
             a.conversation_id AS conversationId, a.artifact_type AS artifactType,
             a.title, a.current_version AS currentVersion,
             a.metadata_json AS metadataJson, a.status,
             a.created_at AS createdAt, a.updated_at AS updatedAt,
             v.payload_json AS payloadJson
      FROM workspace_artifacts a
      JOIN artifact_versions v
        ON v.artifact_id = a.id AND v.version = a.current_version
      WHERE a.id = ? AND (? IS NULL OR a.user_id = ?)
    `).get(String(id), userId ? Number(userId) : null, userId ? Number(userId) : null);
    return row ? {
      ...row,
      metadata: parseJson(row.metadataJson, {}),
      payload: parseJson(row.payloadJson, {}),
    } : null;
  }

  listWorkspaceArtifacts(workspaceId, userId = null) {
    const rows = this.db.prepare(`
      SELECT a.id, a.workspace_id AS workspaceId, a.user_id AS userId,
             a.session_id AS sessionId, a.message_id AS messageId,
             a.conversation_id AS conversationId, a.artifact_type AS artifactType,
             a.title, a.current_version AS currentVersion,
             a.metadata_json AS metadataJson, a.status,
             a.created_at AS createdAt, a.updated_at AS updatedAt
      FROM workspace_artifacts a
      WHERE a.workspace_id = ? AND a.status = 1
        AND (? IS NULL OR a.user_id = ?)
      ORDER BY a.updated_at DESC, a.id DESC
    `).all(
      Number(workspaceId),
      userId ? Number(userId) : null,
      userId ? Number(userId) : null,
    );
    return rows.map((row) => ({
      ...row,
      metadata: parseJson(row.metadataJson, {}),
    }));
  }

  bindWorkspaceArtifactsToMessage({
    artifactIds = [],
    userId,
    messageId,
  }) {
    const ids = [...new Set((artifactIds ?? []).map(String).filter(Boolean))];
    if (ids.length === 0) {
      return 0;
    }
    const update = this.db.prepare(`
      UPDATE workspace_artifacts
      SET message_id = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `);
    const timestamp = nowIso();
    this.db.exec('BEGIN');
    try {
      let count = 0;
      for (const artifactId of ids) {
        count += update.run(
          Number(messageId),
          timestamp,
          artifactId,
          Number(userId),
        ).changes;
      }
      this.db.exec('COMMIT');
      return count;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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

  addAuditLog({
    userId = null,
    themeId = null,
    action,
    detail = {},
    traceId = currentTraceId(),
  }) {
    const result = this.db.prepare(`
      INSERT INTO audit_logs (user_id, theme_id, action, detail_json, trace_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      userId ? Number(userId) : null,
      themeId ? Number(themeId) : null,
      action,
      asJson(detail),
      traceId ? String(traceId) : null,
      nowIso(),
    );
    return Number(result.lastInsertRowid);
  }

  listAuditLogs(limit = 100, { traceId = null } = {}) {
    return this.db.prepare(`
      SELECT a.id, a.user_id AS userId, u.display_name AS userName,
             a.theme_id AS themeId, t.name AS themeName,
             a.action, a.detail_json AS detailJson, a.trace_id AS traceId,
             a.created_at AS createdAt
      FROM audit_logs a
      LEFT JOIN app_users u ON u.id = a.user_id
      LEFT JOIN themes t ON t.id = a.theme_id
      WHERE (? IS NULL OR a.trace_id = ?)
      ORDER BY a.id DESC LIMIT ?
    `).all(
      traceId ? String(traceId) : null,
      traceId ? String(traceId) : null,
      Math.max(1, Math.min(Number(limit) || 100, 500)),
    ).map((row) => ({
      ...row,
      detail: parseJson(row.detailJson, {}),
    }));
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

  logLlmCall({
    userId = null,
    sessionId = null,
    themeId = null,
    traceId = currentTraceId(),
    callType,
    provider = 'deepseek',
    model,
    promptDigest,
    responseDigest,
    tokenUsage = {},
    latencyMs = 0,
    success,
    errorMessage = '',
  }) {
    const result = this.db.prepare(`
      INSERT INTO llm_call_logs
        (user_id, session_id, theme_id, trace_id, call_type, provider, model,
         prompt_digest, response_digest, token_usage_json, latency_ms,
         success, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId ? Number(userId) : null,
      sessionId ? Number(sessionId) : null,
      themeId ? Number(themeId) : null,
      traceId ? String(traceId) : null,
      String(callType),
      String(provider),
      String(model ?? ''),
      String(promptDigest ?? '').slice(0, 500),
      String(responseDigest ?? '').slice(0, 500),
      asJson(tokenUsage),
      Math.max(0, Number(latencyMs) || 0),
      success ? 1 : 0,
      String(errorMessage ?? ''),
      nowIso(),
    );
    return Number(result.lastInsertRowid);
  }

  listLlmLogs(limit = 200, { traceId = null } = {}) {
    return this.db.prepare(`
      SELECT l.id, l.user_id AS userId, u.display_name AS userName,
             l.session_id AS sessionId, l.theme_id AS themeId, t.name AS themeName,
             l.trace_id AS traceId,
             l.call_type AS callType, l.provider, l.model,
             l.prompt_digest AS promptDigest, l.response_digest AS responseDigest,
             l.token_usage_json AS tokenUsageJson, l.latency_ms AS latencyMs,
             l.success, l.error_message AS errorMessage, l.created_at AS createdAt
      FROM llm_call_logs l
      LEFT JOIN app_users u ON u.id = l.user_id
      LEFT JOIN themes t ON t.id = l.theme_id
      WHERE (? IS NULL OR l.trace_id = ?)
      ORDER BY l.id DESC
      LIMIT ?
    `).all(
      traceId ? String(traceId) : null,
      traceId ? String(traceId) : null,
      Math.max(1, Math.min(Number(limit) || 200, 1000)),
    ).map((row) => ({
      ...row,
      success: asBool(row.success),
      tokenUsage: parseJson(row.tokenUsageJson, {}),
    }));
  }

  llmLogStats() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successCount,
             AVG(latency_ms) AS avgLatencyMs
      FROM llm_call_logs
    `).get();
    return {
      total: Number(row.total ?? 0),
      successCount: Number(row.successCount ?? 0),
      successRate: row.total ? Math.round(Number(row.successCount) * 100 / Number(row.total)) : 0,
      avgLatencyMs: Math.round(Number(row.avgLatencyMs ?? 0)),
    };
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
