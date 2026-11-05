-- YOLO platform metadata database for MySQL 8.0+
-- Generated from the active SQLite platform schema.
-- This database stores platform metadata only; business data sources remain configurable.
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- table: app_users
CREATE TABLE IF NOT EXISTS app_users (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        display_name VARCHAR(255) NOT NULL,
        role VARCHAR(255) NOT NULL DEFAULT 'ANALYST',
        status BIGINT NOT NULL DEFAULT 1,
        attributes_json VARCHAR(255) NOT NULL DEFAULT '{}',
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL
      , password_hash VARCHAR(255));

-- table: artifact_versions
CREATE TABLE IF NOT EXISTS artifact_versions (
        id VARCHAR(255) PRIMARY KEY,
        artifact_id VARCHAR(255) NOT NULL,
        version BIGINT NOT NULL,
        operation_json VARCHAR(255) NOT NULL DEFAULT '{}',
        payload_json VARCHAR(255) NOT NULL DEFAULT '{}',
        created_at VARCHAR(255) NOT NULL,
        UNIQUE (artifact_id, version),
        FOREIGN KEY (artifact_id) REFERENCES workspace_artifacts(id) ON DELETE CASCADE
      );

-- table: audit_logs
CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT,
        theme_id BIGINT,
        action VARCHAR(255) NOT NULL,
        detail_json VARCHAR(255) NOT NULL DEFAULT '{}',
        trace_id VARCHAR(255),
        created_at VARCHAR(255) NOT NULL
      );

-- table: business_datasets
CREATE TABLE IF NOT EXISTS business_datasets (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        description VARCHAR(255) NOT NULL DEFAULT '',
        datasource_id BIGINT NOT NULL,
        schema_name VARCHAR(255) NOT NULL,
        primary_table VARCHAR(255) NOT NULL,
        config_json VARCHAR(255) NOT NULL DEFAULT '{}',
        status BIGINT NOT NULL DEFAULT 1,
        last_synced_at VARCHAR(255),
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        FOREIGN KEY (datasource_id) REFERENCES data_sources(id) ON DELETE CASCADE
      );

-- table: chat_messages
CREATE TABLE IF NOT EXISTS chat_messages (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        session_id BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        role VARCHAR(255) NOT NULL,
        content VARCHAR(255) NOT NULL DEFAULT '',
        result_json VARCHAR(255) NOT NULL DEFAULT '{}',
        created_at VARCHAR(255) NOT NULL,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
      );

-- table: chat_sessions
CREATE TABLE IF NOT EXISTS chat_sessions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        theme_id BIGINT NOT NULL,
        title VARCHAR(255) NOT NULL DEFAULT '新会话',
        summary VARCHAR(255) NOT NULL DEFAULT '',
        status BIGINT NOT NULL DEFAULT 1,
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        model_id BIGINT,
        codex_thread_id VARCHAR(255),
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
      );

-- table: column_policies
CREATE TABLE IF NOT EXISTS column_policies (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        theme_id BIGINT,
        column_name VARCHAR(255) NOT NULL,
        action VARCHAR(255) NOT NULL DEFAULT 'MASK',
        mask_value VARCHAR(255) NOT NULL DEFAULT '***',
        enabled BIGINT NOT NULL DEFAULT 1,
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
      );

-- table: conversations
CREATE TABLE IF NOT EXISTS conversations (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        theme_id BIGINT NOT NULL,
        question VARCHAR(255) NOT NULL,
        answer_json VARCHAR(255) NOT NULL DEFAULT '{}',
        created_at VARCHAR(255) NOT NULL
      );

-- table: data_sources
CREATE TABLE IF NOT EXISTS data_sources (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        db_type VARCHAR(255) NOT NULL DEFAULT 'DORIS',
        host VARCHAR(255) NOT NULL,
        port BIGINT NOT NULL,
        database_name VARCHAR(255) NOT NULL,
        username VARCHAR(255) NOT NULL,
        encrypted_password VARCHAR(255) NOT NULL,
        options_json VARCHAR(255) NOT NULL DEFAULT '{}',
        status BIGINT NOT NULL DEFAULT 1,
        last_test_at VARCHAR(255),
        last_test_ok BIGINT,
        last_test_message VARCHAR(255) NOT NULL DEFAULT '',
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL
      );

-- table: dataset_fields
CREATE TABLE IF NOT EXISTS dataset_fields (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        dataset_id BIGINT NOT NULL,
        field_name VARCHAR(255) NOT NULL,
        display_name VARCHAR(255) NOT NULL DEFAULT '',
        data_type VARCHAR(255) NOT NULL DEFAULT '',
        semantic_type VARCHAR(255) NOT NULL DEFAULT 'STRING',
        role VARCHAR(255) NOT NULL DEFAULT 'DIMENSION',
        aggregator VARCHAR(255) NOT NULL DEFAULT 'NONE',
        description VARCHAR(255) NOT NULL DEFAULT '',
        allowed_operators_json VARCHAR(255) NOT NULL DEFAULT '[]',
        ordinal_position BIGINT NOT NULL DEFAULT 0,
        enabled BIGINT NOT NULL DEFAULT 1,
        UNIQUE (dataset_id, field_name),
        FOREIGN KEY (dataset_id) REFERENCES business_datasets(id) ON DELETE CASCADE
      );

-- table: dataset_query_logs
CREATE TABLE IF NOT EXISTS dataset_query_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT,
        session_id BIGINT,
        trace_id VARCHAR(255),
        dataset_id BIGINT NOT NULL,
        sql_text VARCHAR(255) NOT NULL,
        row_count BIGINT NOT NULL DEFAULT 0,
        latency_ms BIGINT NOT NULL DEFAULT 0,
        success BIGINT NOT NULL DEFAULT 0,
        error_message VARCHAR(255) NOT NULL DEFAULT '',
        created_at VARCHAR(255) NOT NULL
      );

-- table: indicator_cache
CREATE TABLE IF NOT EXISTS indicator_cache (
        source_id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        biz_name VARCHAR(255) NOT NULL DEFAULT '',
        type_id VARCHAR(255) NOT NULL DEFAULT '',
        type_name VARCHAR(255) NOT NULL DEFAULT '',
        indicator_level VARCHAR(255) NOT NULL DEFAULT '',
        business_caliber VARCHAR(255) NOT NULL DEFAULT '',
        description VARCHAR(255) NOT NULL DEFAULT '',
        owner VARCHAR(255) NOT NULL DEFAULT '',
        department VARCHAR(255) NOT NULL DEFAULT '',
        status BIGINT NOT NULL DEFAULT 1,
        metrics_json VARCHAR(255) NOT NULL DEFAULT '[]',
        dimensions_json VARCHAR(255) NOT NULL DEFAULT '[]',
        models_json VARCHAR(255) NOT NULL DEFAULT '[]',
        raw_json VARCHAR(255) NOT NULL DEFAULT '{}',
        synced_at VARCHAR(255) NOT NULL
      );

-- table: indicator_types
CREATE TABLE IF NOT EXISTS indicator_types (
        source_id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        code VARCHAR(255) NOT NULL DEFAULT '',
        parent_id VARCHAR(255) NOT NULL DEFAULT '',
        raw_json VARCHAR(255) NOT NULL DEFAULT '{}',
        synced_at VARCHAR(255) NOT NULL
      );

-- table: knowledge_gaps
CREATE TABLE IF NOT EXISTS knowledge_gaps (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        term VARCHAR(255) NOT NULL,
        kind VARCHAR(255) NOT NULL DEFAULT 'QUESTION',
        source VARCHAR(255) NOT NULL DEFAULT 'ASK',
        count BIGINT NOT NULL DEFAULT 1,
        dismissed BIGINT NOT NULL DEFAULT 0,
        resolved BIGINT NOT NULL DEFAULT 0,
        resolution_json VARCHAR(255) NOT NULL DEFAULT '{}',
        context_json VARCHAR(255) NOT NULL DEFAULT '{}',
        first_seen VARCHAR(255) NOT NULL,
        last_seen VARCHAR(255) NOT NULL,
        UNIQUE (term, kind)
      );

-- table: llm_call_logs
CREATE TABLE IF NOT EXISTS llm_call_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT,
        session_id BIGINT,
        theme_id BIGINT,
        trace_id VARCHAR(255),
        call_type VARCHAR(255) NOT NULL,
        provider VARCHAR(255) NOT NULL DEFAULT 'deepseek',
        model VARCHAR(255) NOT NULL DEFAULT '',
        prompt_digest VARCHAR(255) NOT NULL DEFAULT '',
        response_digest VARCHAR(255) NOT NULL DEFAULT '',
        token_usage_json VARCHAR(255) NOT NULL DEFAULT '{}',
        latency_ms BIGINT NOT NULL DEFAULT 0,
        success BIGINT NOT NULL DEFAULT 0,
        error_message VARCHAR(255) NOT NULL DEFAULT '',
        created_at VARCHAR(255) NOT NULL
      );

-- table: local_indicators
CREATE TABLE IF NOT EXISTS local_indicators (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        biz_name VARCHAR(255) NOT NULL,
        type_id VARCHAR(255) NOT NULL DEFAULT '',
        type_name VARCHAR(255) NOT NULL DEFAULT '通用指标',
        indicator_level VARCHAR(255) NOT NULL DEFAULT 'ATOMIC',
        business_caliber VARCHAR(255) NOT NULL DEFAULT '',
        description VARCHAR(255) NOT NULL DEFAULT '',
        owner VARCHAR(255) NOT NULL DEFAULT '',
        department VARCHAR(255) NOT NULL DEFAULT '',
        status BIGINT NOT NULL DEFAULT 1,
        metrics_json VARCHAR(255) NOT NULL DEFAULT '[]',
        dimensions_json VARCHAR(255) NOT NULL DEFAULT '[]',
        models_json VARCHAR(255) NOT NULL DEFAULT '[]',
        raw_json VARCHAR(255) NOT NULL DEFAULT '{}',
        synced_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL
      );

-- table: mcp_api_keys
CREATE TABLE IF NOT EXISTS mcp_api_keys (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        key_id VARCHAR(255) NOT NULL UNIQUE,
        key_hash VARCHAR(255) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL DEFAULT 'mcp',
        tenant_id VARCHAR(255) NOT NULL DEFAULT 'default',
        scopes VARCHAR(255) NOT NULL DEFAULT '"mcp"',
        created_by BIGINT,
        created_at VARCHAR(255) NOT NULL,
        revoked BIGINT NOT NULL DEFAULT 0
      );

-- table: mcp_query_contracts
CREATE TABLE IF NOT EXISTS mcp_query_contracts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        contract_id VARCHAR(255) NOT NULL UNIQUE,
        tenant_id VARCHAR(255) NOT NULL DEFAULT 'default',
        user_id BIGINT,
        theme_id BIGINT,
        source_type VARCHAR(255) NOT NULL,
        indicator_id VARCHAR(255),
        dataset_id VARCHAR(255),
        contract_json VARCHAR(255) NOT NULL,
        status VARCHAR(255) NOT NULL DEFAULT 'FROZEN',
        created_at VARCHAR(255) NOT NULL,
        expires_at VARCHAR(255)
      );

-- table: models
CREATE TABLE IF NOT EXISTS models (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        provider VARCHAR(255) NOT NULL DEFAULT 'deepseek',
        model_name VARCHAR(255) NOT NULL,
        base_url VARCHAR(255) NOT NULL DEFAULT '',
        api_key_env VARCHAR(255) NOT NULL DEFAULT '',
        api_key_encrypted VARCHAR(255),
        temperature DOUBLE NOT NULL DEFAULT 0,
        max_tokens BIGINT NOT NULL DEFAULT 0,
        timeout_ms BIGINT NOT NULL DEFAULT 60000,
        max_tool_rounds BIGINT NOT NULL DEFAULT 12,
        is_default BIGINT NOT NULL DEFAULT 0,
        status BIGINT NOT NULL DEFAULT 1,
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL
      );

-- table: platform_settings
CREATE TABLE IF NOT EXISTS platform_settings (
        `key` VARCHAR(255) PRIMARY KEY,
        value_json LONGTEXT NOT NULL,
        updated_at VARCHAR(255) NOT NULL
      );

-- table: qa_feedback
CREATE TABLE IF NOT EXISTS qa_feedback (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        theme_id BIGINT NOT NULL,
        session_id BIGINT,
        message_id BIGINT,
        question VARCHAR(255) NOT NULL DEFAULT '',
        correct BIGINT NOT NULL DEFAULT 0,
        comment VARCHAR(255) NOT NULL DEFAULT '',
        corrected_json VARCHAR(255) NOT NULL DEFAULT '{}',
        created_at VARCHAR(255) NOT NULL,
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
      );

-- table: query_plans
CREATE TABLE IF NOT EXISTS query_plans (
        id VARCHAR(255) PRIMARY KEY,
        user_id BIGINT NOT NULL,
        theme_id BIGINT NOT NULL,
        session_id BIGINT,
        source_type VARCHAR(255) NOT NULL DEFAULT 'INDICATOR',
        dataset_id VARCHAR(255),
        compiler_version VARCHAR(255),
        trace_id VARCHAR(255),
        question VARCHAR(255) NOT NULL,
        status VARCHAR(255) NOT NULL DEFAULT 'COMPILED',
        plan_json VARCHAR(255) NOT NULL DEFAULT '{}',
        validation_json VARCHAR(255) NOT NULL DEFAULT '{}',
        evidence_json VARCHAR(255) NOT NULL DEFAULT '{}',
        created_at VARCHAR(255) NOT NULL,
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
      );

-- table: row_policies
CREATE TABLE IF NOT EXISTS row_policies (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        theme_id BIGINT,
        dimension VARCHAR(255) NOT NULL,
        operator VARCHAR(255) NOT NULL,
        values_json VARCHAR(255) NOT NULL DEFAULT '[]',
        value_source VARCHAR(255) NOT NULL DEFAULT 'FIXED',
        attribute_key VARCHAR(255),
        enabled BIGINT NOT NULL DEFAULT 1,
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
      );

-- table: schema_migrations
CREATE TABLE IF NOT EXISTS schema_migrations (
        `key` VARCHAR(255) PRIMARY KEY,
        applied_at VARCHAR(255) NOT NULL
      );

-- table: semantic_value_audit_logs
CREATE TABLE IF NOT EXISTS semantic_value_audit_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        theme_id BIGINT NOT NULL,
        source_type VARCHAR(255) NOT NULL,
        source_id VARCHAR(255) NOT NULL,
        field_name VARCHAR(255) NOT NULL,
        action VARCHAR(255) NOT NULL,
        before_checksum VARCHAR(255) NOT NULL DEFAULT '',
        after_checksum VARCHAR(255) NOT NULL DEFAULT '',
        actor_id BIGINT,
        created_at VARCHAR(255) NOT NULL,
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
      );

-- table: semantic_value_domains
CREATE TABLE IF NOT EXISTS semantic_value_domains (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        source_type VARCHAR(64) NOT NULL,
        source_id VARCHAR(128) NOT NULL,
        field_name VARCHAR(255) NOT NULL,
        display_name VARCHAR(255) NOT NULL DEFAULT '',
        value VARCHAR(255) NOT NULL,
        normalized_value VARCHAR(255) NOT NULL,
        aliases_json VARCHAR(255) NOT NULL DEFAULT '[]',
        description VARCHAR(255) NOT NULL DEFAULT '',
        source VARCHAR(255) NOT NULL DEFAULT 'DESCRIPTION',
        confidence DOUBLE NOT NULL DEFAULT 1,
        enabled BIGINT NOT NULL DEFAULT 1,
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        UNIQUE (source_type, source_id, field_name, normalized_value)
      );

-- table: semantic_value_overrides
CREATE TABLE IF NOT EXISTS semantic_value_overrides (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        theme_id BIGINT NOT NULL,
        source_type VARCHAR(64) NOT NULL,
        source_id VARCHAR(128) NOT NULL,
        field_name VARCHAR(255) NOT NULL,
        concept VARCHAR(255) NOT NULL,
        aliases_json VARCHAR(255) NOT NULL DEFAULT '[]',
        operator VARCHAR(255) NOT NULL DEFAULT 'IN',
        configured_values_json VARCHAR(255) NOT NULL DEFAULT '[]',
        rule_source VARCHAR(255) NOT NULL DEFAULT '',
        action VARCHAR(32) NOT NULL DEFAULT 'ENUM_MAPPING',
        allow_unverified BIGINT NOT NULL DEFAULT 0,
        enabled BIGINT NOT NULL DEFAULT 1,
        updated_by BIGINT,
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        UNIQUE (theme_id, source_type, source_id, field_name, concept, action),
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
      );

-- table: semantic_value_refresh_jobs
CREATE TABLE IF NOT EXISTS semantic_value_refresh_jobs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        theme_id BIGINT NOT NULL,
        source_type VARCHAR(255) NOT NULL,
        source_id VARCHAR(255) NOT NULL,
        field_name VARCHAR(255) NOT NULL,
        `trigger` VARCHAR(255) NOT NULL DEFAULT 'MANUAL',
        status VARCHAR(255) NOT NULL DEFAULT 'PENDING',
        requested_by BIGINT,
        scanned_count BIGINT NOT NULL DEFAULT 0,
        added_count BIGINT NOT NULL DEFAULT 0,
        removed_count BIGINT NOT NULL DEFAULT 0,
        changed_count BIGINT NOT NULL DEFAULT 0,
        error_json VARCHAR(255) NOT NULL DEFAULT '{}',
        started_at VARCHAR(255),
        finished_at VARCHAR(255),
        created_at VARCHAR(255) NOT NULL,
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
      );

-- table: semantic_value_snapshot_items
CREATE TABLE IF NOT EXISTS semantic_value_snapshot_items (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        snapshot_id BIGINT NOT NULL,
        value VARCHAR(255) NOT NULL,
        normalized_value VARCHAR(255) NOT NULL,
        aliases_json VARCHAR(255) NOT NULL DEFAULT '[]',
        origin VARCHAR(255) NOT NULL,
        origin_ref VARCHAR(255) NOT NULL DEFAULT '',
        confidence DOUBLE NOT NULL DEFAULT 1,
        enabled BIGINT NOT NULL DEFAULT 1,
        first_seen_at VARCHAR(255) NOT NULL,
        last_seen_at VARCHAR(255) NOT NULL,
        UNIQUE (snapshot_id, normalized_value),
        FOREIGN KEY (snapshot_id) REFERENCES semantic_value_snapshots(id) ON DELETE CASCADE
      );

-- table: semantic_value_snapshots
CREATE TABLE IF NOT EXISTS semantic_value_snapshots (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        theme_id BIGINT NOT NULL,
        source_type VARCHAR(64) NOT NULL,
        source_id VARCHAR(128) NOT NULL,
        field_name VARCHAR(255) NOT NULL,
        display_name VARCHAR(255) NOT NULL DEFAULT '',
        version BIGINT NOT NULL DEFAULT 1,
        status VARCHAR(255) NOT NULL DEFAULT 'UNKNOWN',
        origin_mask_json VARCHAR(255) NOT NULL DEFAULT '[]',
        value_count BIGINT NOT NULL DEFAULT 0,
        sample_size BIGINT NOT NULL DEFAULT 0,
        checksum VARCHAR(255) NOT NULL DEFAULT '',
        scope_signature VARCHAR(255) NOT NULL DEFAULT '',
        schema_hash VARCHAR(255) NOT NULL DEFAULT '',
        error_message VARCHAR(255) NOT NULL DEFAULT '',
        refreshed_at VARCHAR(255),
        expires_at VARCHAR(255),
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        UNIQUE (theme_id, source_type, source_id, field_name, version),
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
      );

-- table: session_locks
CREATE TABLE IF NOT EXISTS session_locks (
  `key` VARCHAR(255) PRIMARY KEY,
  owner VARCHAR(255) NOT NULL,
  expires_at VARCHAR(255) NOT NULL
);

-- table: skills
CREATE TABLE IF NOT EXISTS skills (
        code VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description VARCHAR(255) NOT NULL DEFAULT '',
        category VARCHAR(255) NOT NULL DEFAULT 'CORE',
        kind VARCHAR(255) NOT NULL DEFAULT 'TOOL',
        tool_name VARCHAR(255),
        instruction VARCHAR(255) NOT NULL DEFAULT '',
        default_enabled BIGINT NOT NULL DEFAULT 1,
        status BIGINT NOT NULL DEFAULT 1,
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL
      , source VARCHAR(255) NOT NULL DEFAULT 'BUILTIN', source_path VARCHAR(255), metadata_json VARCHAR(255) NOT NULL DEFAULT '{}', phase_tags_json VARCHAR(255) NOT NULL DEFAULT '[]', content VARCHAR(255) NOT NULL DEFAULT '', content_hash VARCHAR(255));

-- table: theme_indicators
CREATE TABLE IF NOT EXISTS theme_indicators (
        theme_id BIGINT NOT NULL,
        indicator_id VARCHAR(255) NOT NULL,
        created_at VARCHAR(255) NOT NULL,
        PRIMARY KEY (theme_id, indicator_id),
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
      );

-- table: theme_semantic_value_domains
CREATE TABLE IF NOT EXISTS theme_semantic_value_domains (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        theme_id BIGINT NOT NULL,
        source_type VARCHAR(64) NOT NULL,
        source_id VARCHAR(128) NOT NULL,
        field_name VARCHAR(255) NOT NULL,
        display_name VARCHAR(255) NOT NULL DEFAULT '',
        value VARCHAR(255) NOT NULL,
        normalized_value VARCHAR(255) NOT NULL,
        aliases_json VARCHAR(255) NOT NULL DEFAULT '[]',
        description VARCHAR(255) NOT NULL DEFAULT '',
        source VARCHAR(255) NOT NULL DEFAULT 'DESCRIPTION',
        confidence DOUBLE NOT NULL DEFAULT 1,
        enabled BIGINT NOT NULL DEFAULT 1,
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        UNIQUE (theme_id, source_type, source_id, field_name, normalized_value),
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
      );

-- table: theme_skills
CREATE TABLE IF NOT EXISTS theme_skills (
        theme_id BIGINT NOT NULL,
        skill_code VARCHAR(255) NOT NULL,
        enabled BIGINT NOT NULL DEFAULT 1,
        config_json VARCHAR(255) NOT NULL DEFAULT '{}',
        PRIMARY KEY (theme_id, skill_code),
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE,
        FOREIGN KEY (skill_code) REFERENCES skills(code) ON DELETE CASCADE
      );

-- table: themes
CREATE TABLE IF NOT EXISTS themes (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        description VARCHAR(255) NOT NULL DEFAULT '',
        system_prompt VARCHAR(255) NOT NULL DEFAULT '',
        indicator_ids_json VARCHAR(255) NOT NULL DEFAULT '[]',
        allowed_dimensions_json VARCHAR(255) NOT NULL DEFAULT '[]',
        llm_config_json VARCHAR(255) NOT NULL DEFAULT '{}',
        dataset_ids_json VARCHAR(255) NOT NULL DEFAULT '[]',
        business_dataset_ids_json VARCHAR(255) NOT NULL DEFAULT '[]',
        primary_business_dataset_id BIGINT,
        semantic_value_config_json VARCHAR(255) NOT NULL DEFAULT '{}',
        semantic_policy_json VARCHAR(255) NOT NULL DEFAULT '{}',
        examples_json VARCHAR(255) NOT NULL DEFAULT '[]',
        default_chart VARCHAR(255) NOT NULL DEFAULT 'auto',
        status BIGINT NOT NULL DEFAULT 1,
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL
      , model_ids_json VARCHAR(255) NOT NULL DEFAULT '[]', default_model_id BIGINT);

-- table: user_dataset_grants
CREATE TABLE IF NOT EXISTS user_dataset_grants (
        user_id BIGINT NOT NULL,
        dataset_id BIGINT NOT NULL,
        can_query BIGINT NOT NULL DEFAULT 1,
        PRIMARY KEY (user_id, dataset_id),
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
        FOREIGN KEY (dataset_id) REFERENCES business_datasets(id) ON DELETE CASCADE
      );

-- table: user_indicator_grants
CREATE TABLE IF NOT EXISTS user_indicator_grants (
        user_id BIGINT NOT NULL,
        indicator_id VARCHAR(255) NOT NULL,
        can_query BIGINT NOT NULL DEFAULT 1,
        PRIMARY KEY (user_id, indicator_id),
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
      );

-- table: user_memory_documents
CREATE TABLE IF NOT EXISTS user_memory_documents (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        theme_id BIGINT,
        scope_key VARCHAR(255) NOT NULL,
        scope_label VARCHAR(255) NOT NULL DEFAULT '',
        summary VARCHAR(255) NOT NULL DEFAULT '',
        content VARCHAR(255) NOT NULL DEFAULT '',
        version BIGINT NOT NULL DEFAULT 0,
        status BIGINT NOT NULL DEFAULT 1,
        summary_budget BIGINT NOT NULL DEFAULT 1200,
        content_budget BIGINT NOT NULL DEFAULT 8000,
        last_consolidated_at VARCHAR(255),
        injected_count BIGINT NOT NULL DEFAULT 0,
        last_injected_at VARCHAR(255),
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        UNIQUE (user_id, scope_key)
      );

-- table: user_memory_notes
CREATE TABLE IF NOT EXISTS user_memory_notes (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        theme_id BIGINT,
        scope_key VARCHAR(255) NOT NULL,
        kind VARCHAR(255) NOT NULL DEFAULT 'BUSINESS_KNOWLEDGE',
        source VARCHAR(255) NOT NULL DEFAULT 'DISTILLED',
        state VARCHAR(255) NOT NULL DEFAULT 'PENDING',
        content VARCHAR(255) NOT NULL,
        dedupe_key VARCHAR(255) NOT NULL,
        session_id BIGINT,
        merged_version BIGINT,
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        UNIQUE (user_id, scope_key, dedupe_key)
      );

-- table: user_memory_versions
CREATE TABLE IF NOT EXISTS user_memory_versions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        document_id BIGINT NOT NULL,
        version BIGINT NOT NULL,
        summary VARCHAR(255) NOT NULL DEFAULT '',
        content VARCHAR(255) NOT NULL DEFAULT '',
        note_count BIGINT NOT NULL DEFAULT 0,
        change_reason VARCHAR(255) NOT NULL DEFAULT '',
        created_at VARCHAR(255) NOT NULL,
        UNIQUE (document_id, version)
      );

-- table: user_sessions
CREATE TABLE IF NOT EXISTS user_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  user_id BIGINT NOT NULL,
  created_at VARCHAR(255) NOT NULL,
  last_seen_at VARCHAR(255) NOT NULL,
  expires_at VARCHAR(255) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
);

-- table: user_theme_grants
CREATE TABLE IF NOT EXISTS user_theme_grants (
        user_id BIGINT NOT NULL,
        theme_id BIGINT NOT NULL,
        can_query BIGINT NOT NULL DEFAULT 1,
        can_manage BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, theme_id),
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
      );

-- table: workspace_artifacts
CREATE TABLE IF NOT EXISTS workspace_artifacts (
        id VARCHAR(255) PRIMARY KEY,
        workspace_id BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        session_id BIGINT,
        message_id BIGINT,
        conversation_id BIGINT,
        artifact_type VARCHAR(255) NOT NULL DEFAULT 'TABLE',
        title VARCHAR(255) NOT NULL DEFAULT '',
        current_version BIGINT NOT NULL DEFAULT 1,
        metadata_json VARCHAR(255) NOT NULL DEFAULT '{}',
        status BIGINT NOT NULL DEFAULT 1,
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
      );

-- table: workspaces
CREATE TABLE IF NOT EXISTS workspaces (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        theme_id BIGINT NOT NULL,
        session_id BIGINT,
        name VARCHAR(255) NOT NULL DEFAULT '问数工作区',
        status BIGINT NOT NULL DEFAULT 1,
        created_at VARCHAR(255) NOT NULL,
        updated_at VARCHAR(255) NOT NULL,
        UNIQUE (session_id),
        FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE,
        FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );

-- index: idx_artifact_versions_artifact
CREATE INDEX idx_artifact_versions_artifact
        ON artifact_versions(artifact_id, version DESC);

-- index: idx_audit_created
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);

-- index: idx_audit_logs_trace
CREATE INDEX idx_audit_logs_trace ON audit_logs(trace_id);

-- index: idx_chat_messages_session
CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, id);

-- index: idx_chat_sessions_user
CREATE INDEX idx_chat_sessions_user ON chat_sessions(user_id, updated_at DESC);

-- index: idx_dataset_fields_dataset
CREATE INDEX idx_dataset_fields_dataset ON dataset_fields(dataset_id, enabled);

-- index: idx_dataset_query_logs_dataset
CREATE INDEX idx_dataset_query_logs_dataset ON dataset_query_logs(dataset_id, created_at DESC);

-- index: idx_dataset_query_logs_trace
CREATE INDEX idx_dataset_query_logs_trace ON dataset_query_logs(trace_id);

-- index: idx_feedback_theme
CREATE INDEX idx_feedback_theme ON qa_feedback(theme_id, created_at DESC);

-- index: idx_gaps_status
CREATE INDEX idx_gaps_status ON knowledge_gaps(resolved, dismissed, count DESC);

-- index: idx_indicators_name
CREATE INDEX idx_indicators_name ON indicator_cache(name);

-- index: idx_indicators_type
CREATE INDEX idx_indicators_type ON indicator_cache(type_id);

-- index: idx_llm_logs_created
CREATE INDEX idx_llm_logs_created ON llm_call_logs(created_at DESC);

-- index: idx_llm_logs_trace
CREATE INDEX idx_llm_logs_trace ON llm_call_logs(trace_id);

-- index: idx_local_indicators_name
CREATE INDEX idx_local_indicators_name ON local_indicators(name);

-- index: idx_local_indicators_type
CREATE INDEX idx_local_indicators_type ON local_indicators(type_id);

-- index: idx_query_plans_trace
CREATE INDEX idx_query_plans_trace ON query_plans(trace_id);

-- index: idx_query_plans_user
CREATE INDEX idx_query_plans_user ON query_plans(user_id, created_at DESC);

-- index: idx_semantic_value_domain_lookup
CREATE INDEX idx_semantic_value_domain_lookup
        ON semantic_value_domains(source_type, source_id, field_name, enabled);

-- index: idx_theme_semantic_value_domain_lookup
CREATE INDEX idx_theme_semantic_value_domain_lookup
        ON theme_semantic_value_domains(
          theme_id, source_type, source_id, field_name, enabled
        );

-- index: idx_theme_skills_theme
CREATE INDEX idx_theme_skills_theme ON theme_skills(theme_id, enabled);

-- index: idx_user_memory_documents_user
CREATE INDEX idx_user_memory_documents_user
        ON user_memory_documents(user_id, status, updated_at DESC);

-- index: idx_user_memory_notes_scope
CREATE INDEX idx_user_memory_notes_scope
        ON user_memory_notes(user_id, scope_key, state, id DESC);

-- index: idx_user_memory_versions_doc
CREATE INDEX idx_user_memory_versions_doc
        ON user_memory_versions(document_id, version DESC);

-- index: idx_user_sessions_expires
CREATE INDEX idx_user_sessions_expires ON user_sessions(expires_at);

-- index: idx_user_sessions_user
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);

-- index: idx_workspace_artifacts_workspace
CREATE INDEX idx_workspace_artifacts_workspace
        ON workspace_artifacts(workspace_id, updated_at DESC);

-- index: idx_workspaces_user
CREATE INDEX idx_workspaces_user ON workspaces(user_id, updated_at DESC);
SET FOREIGN_KEY_CHECKS = 1;
