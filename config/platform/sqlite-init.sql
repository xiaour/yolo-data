-- SQLite platform metadata schema. Runtime data migrations remain in src/database.js.
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

      CREATE TABLE IF NOT EXISTS theme_indicators (
        theme_id INTEGER NOT NULL,
        indicator_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (theme_id, indicator_id),
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
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

      CREATE TABLE IF NOT EXISTS user_memory_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        theme_id INTEGER,
        scope_key TEXT NOT NULL,
        scope_label TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 0,
        status INTEGER NOT NULL DEFAULT 1,
        summary_budget INTEGER NOT NULL DEFAULT 1200,
        content_budget INTEGER NOT NULL DEFAULT 8000,
        last_consolidated_at TEXT,
        injected_count INTEGER NOT NULL DEFAULT 0,
        last_injected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, scope_key)
      );

      CREATE TABLE IF NOT EXISTS user_memory_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        theme_id INTEGER,
        scope_key TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'BUSINESS_KNOWLEDGE',
        source TEXT NOT NULL DEFAULT 'DISTILLED',
        state TEXT NOT NULL DEFAULT 'PENDING',
        content TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        session_id INTEGER,
        merged_version INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, scope_key, dedupe_key)
      );

      CREATE TABLE IF NOT EXISTS user_memory_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        note_count INTEGER NOT NULL DEFAULT 0,
        change_reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE (document_id, version)
      );

      CREATE TABLE IF NOT EXISTS local_indicators (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        biz_name TEXT NOT NULL,
        type_id TEXT NOT NULL DEFAULT '',
        type_name TEXT NOT NULL DEFAULT '通用指标',
        indicator_level TEXT NOT NULL DEFAULT 'ATOMIC',
        business_caliber TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        department TEXT NOT NULL DEFAULT '',
        status INTEGER NOT NULL DEFAULT 1,
        metrics_json TEXT NOT NULL DEFAULT '[]',
        dimensions_json TEXT NOT NULL DEFAULT '[]',
        models_json TEXT NOT NULL DEFAULT '[]',
        raw_json TEXT NOT NULL DEFAULT '{}',
        synced_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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

      CREATE TABLE IF NOT EXISTS mcp_api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id TEXT NOT NULL UNIQUE,
        key_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL DEFAULT 'mcp',
        tenant_id TEXT NOT NULL DEFAULT 'default',
        scopes TEXT NOT NULL DEFAULT '"mcp"',
        created_by INTEGER,
        created_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS mcp_query_contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        user_id INTEGER,
        theme_id INTEGER,
        source_type TEXT NOT NULL,
        indicator_id TEXT,
        dataset_id TEXT,
        contract_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'FROZEN',
        created_at TEXT NOT NULL,
        expires_at TEXT
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
        model_id INTEGER,
        codex_thread_id TEXT,
        codex_context_version TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_user_memory_documents_user
        ON user_memory_documents(user_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_user_memory_notes_scope
        ON user_memory_notes(user_id, scope_key, state, id DESC);
      CREATE INDEX IF NOT EXISTS idx_user_memory_versions_doc
        ON user_memory_versions(document_id, version DESC);
      CREATE INDEX IF NOT EXISTS idx_local_indicators_name ON local_indicators(name);
      CREATE INDEX IF NOT EXISTS idx_local_indicators_type ON local_indicators(type_id);
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
CREATE TABLE IF NOT EXISTS session_locks (
  `key` TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
