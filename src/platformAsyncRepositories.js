import crypto from 'node:crypto';
import { PlatformDatabase } from './database.js';
import { UserRepository } from './userRepository.js';
import { ModelRepository } from './modelRepository.js';
import { DataSourceRepository } from './dataSourceRepository.js';
import { SkillRepository } from './skillRepository.js';
import { ThemeRepository } from './themeRepository.js';
import { PermissionRepository } from './permissionRepository.js';
import { PlatformLogRepository } from './platformLogRepository.js';

export function attachAsyncRepositories(store) {
  store.isAsyncPlatformStore = true;
  store.userRepository = new UserRepository(null, store);
  store.modelRepository = new ModelRepository(null, store);
  store.dataSourceRepository = new DataSourceRepository(null, store);
  store.skillRepository = new SkillRepository(null, store);
  store.themeRepository = new ThemeRepository(store);
  store.permissionRepository = new PermissionRepository(store);
  store.logRepository = new PlatformLogRepository(null, store);
  store.listUsersAsync = (...args) => store.userRepository.listUsersAsync(...args);
  store.addAuditLogAsync = (...args) => store.logRepository.addAuditLogAsync(...args);
  store.listAuditLogsAsync = (...args) => store.logRepository.listAuditLogsAsync(...args);
  store.logDatasetQueryAsync = (...args) => store.logRepository.logDatasetQueryAsync(...args);
  store.listDatasetQueryLogsAsync = (...args) => store.logRepository.listDatasetQueryLogsAsync(...args);
  store.logLlmCallAsync = (...args) => store.logRepository.logLlmCallAsync(...args);
  store.listLlmLogsAsync = (...args) => store.logRepository.listLlmLogsAsync(...args);
  store.llmLogStatsAsync = (...args) => store.logRepository.llmLogStatsAsync(...args);
  store.sumTokenUsageAsync = (...args) => store.logRepository.sumTokenUsageAsync(...args);
  store.getUserAsync = (...args) => store.userRepository.getUserAsync(...args);
  store.listModelsAsync = (...args) => store.modelRepository.listModelsAsync(...args);
  store.getModelAsync = (...args) => store.modelRepository.getModelAsync(...args);
  store.listDataSourcesAsync = (...args) => store.dataSourceRepository.listDataSourcesAsync(...args);
  store.listBusinessDatasetsAsync = async ({ userId = null, includeDisabled = false } = {}) => {
    const rows = await store.query(`
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
    return rows.map((row) => {
      let config = {};
      try { config = JSON.parse(row.configJson ?? '{}'); } catch { /* use empty config */ }
      return { ...row, config, canQuery: row.canQuery === true || Number(row.canQuery) === 1 };
    });
  };
  store.listThemesAsync = (...args) => store.themeRepository.listThemesAsync(...args);
  store.getThemeAsync = (...args) => store.themeRepository.getThemeAsync(...args);
  store.saveThemeAsync = (...args) => store.themeRepository.saveThemeAsync(...args);
  store.saveFeedbackAsync = async ({ userId, themeId, sessionId, messageId, question, correct, comment, corrected }) => {
    const result = await store.execute(`INSERT INTO qa_feedback
      (user_id, theme_id, session_id, message_id, question, correct, comment, corrected_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [Number(userId), Number(themeId), sessionId ? Number(sessionId) : null,
      messageId ? Number(messageId) : null, String(question ?? ''), correct ? 1 : 0,
      String(comment ?? ''), JSON.stringify(corrected ?? {}), new Date().toISOString()]);
    return Number(result.insertId);
  };
  store.listFeedbackAsync = async ({ themeId = null, correct = null, limit = 100 } = {}) => {
    const rows = await store.query(`SELECT f.id, f.user_id AS userId, u.display_name AS userName,
      f.theme_id AS themeId, t.name AS themeName, f.session_id AS sessionId, f.message_id AS messageId,
      f.question, f.correct, f.comment, f.corrected_json AS correctedJson, f.created_at AS createdAt
      FROM qa_feedback f LEFT JOIN app_users u ON u.id=f.user_id LEFT JOIN themes t ON t.id=f.theme_id
      WHERE (? IS NULL OR f.theme_id=?) AND (? IS NULL OR f.correct=?) ORDER BY f.id DESC LIMIT ?`,
    [themeId ? Number(themeId) : null, themeId ? Number(themeId) : null,
      correct == null ? null : (correct ? 1 : 0), correct == null ? null : (correct ? 1 : 0),
      Math.max(1, Math.min(Number(limit) || 100, 500))]);
    return rows.map((row) => { let corrected = {}; try { corrected = JSON.parse(row.correctedJson || '{}'); } catch {} return { ...row, correct: row.correct === true || Number(row.correct) === 1, corrected }; });
  };
  store.getChatMessageAsync = async (id, userId) => {
    const [row] = await store.query(`SELECT m.id, m.session_id AS sessionId, m.user_id AS userId,
      m.role, m.content, m.result_json AS resultJson, m.created_at AS createdAt
      FROM chat_messages m WHERE m.id=? AND m.user_id=?`, [Number(id), Number(userId)]);
    if (!row) return null;
    let result = {}; try { result = JSON.parse(row.resultJson || '{}'); } catch {}
    return { ...row, result };
  };
  store.recordKnowledgeGapAsync = async ({ term, kind = 'QUESTION', source = 'ASK', context = {} }) => {
    const normalized = String(term ?? '').trim();
    if (normalized.length < 2 || normalized.length > 256) return null;
    const timestamp = new Date().toISOString();
    await store.execute(`INSERT INTO knowledge_gaps
      (term, kind, source, count, dismissed, resolved, resolution_json, context_json, first_seen, last_seen)
      VALUES (?, ?, ?, 1, 0, 0, '{}', ?, ?, ?)
      ON DUPLICATE KEY UPDATE count=count+1, source=VALUES(source), context_json=VALUES(context_json), last_seen=VALUES(last_seen)`,
    [normalized, String(kind).toUpperCase(), String(source).toUpperCase(), JSON.stringify(context ?? {}), timestamp, timestamp]);
    const [row] = await store.query(`SELECT id, term, kind, source, count, dismissed, resolved,
      resolution_json AS resolutionJson, context_json AS contextJson, first_seen AS firstSeen, last_seen AS lastSeen
      FROM knowledge_gaps WHERE term=? AND kind=?`, [normalized, String(kind).toUpperCase()]);
    return row ? { ...row, dismissed: Boolean(row.dismissed), resolved: Boolean(row.resolved),
      resolution: parseJson(row.resolutionJson, {}), context: parseJson(row.contextJson, {}) } : null;
  };
  store.listKnowledgeGapsAsync = async ({ includeClosed = false, limit = 200 } = {}) => {
    const rows = await store.query(`SELECT id, term, kind, source, count, dismissed, resolved,
      resolution_json AS resolutionJson, context_json AS contextJson, first_seen AS firstSeen, last_seen AS lastSeen
      FROM knowledge_gaps WHERE (?=1 OR (dismissed=0 AND resolved=0))
      ORDER BY count DESC, last_seen DESC LIMIT ?`, [includeClosed ? 1 : 0, Math.max(1, Math.min(Number(limit) || 200, 1000))]);
    return rows.map((row) => ({ ...row, dismissed: Boolean(row.dismissed), resolved: Boolean(row.resolved),
      resolution: parseJson(row.resolutionJson, {}), context: parseJson(row.contextJson, {}) }));
  };
  store.updateKnowledgeGapAsync = async (id, { dismissed, resolved, resolution } = {}) => {
    const [current] = await store.query('SELECT id, dismissed, resolved, resolution_json AS resolutionJson FROM knowledge_gaps WHERE id=?', [Number(id)]);
    if (!current) return null;
    await store.execute('UPDATE knowledge_gaps SET dismissed=?, resolved=?, resolution_json=? WHERE id=?', [
      dismissed === undefined ? Number(current.dismissed) : (dismissed ? 1 : 0),
      resolved === undefined ? Number(current.resolved) : (resolved ? 1 : 0),
      resolution === undefined ? current.resolutionJson : JSON.stringify(resolution ?? {}), Number(id)]);
    return (await store.listKnowledgeGapsAsync({ includeClosed: true, limit: 1000 })).find((item) => Number(item.id) === Number(id)) ?? null;
  };
  store.listSkillsAsync = (...args) => store.skillRepository.listSkillsAsync(...args);
  store.getUserPreferencesAsync = async (userId) => {
    const setting = await store.getPlatformSettingAsync(`user_preferences:${Number(userId)}`, {});
    return setting?.value && typeof setting.value === 'object' ? setting.value : {};
  };
  store.saveUserPreferencesAsync = async (userId, patch) => {
    const current = await store.getUserPreferencesAsync(userId);
    const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
    await store.savePlatformSettingAsync(`user_preferences:${Number(userId)}`, next);
    return next;
  };
  store.listDatasetOptionsAsync = async () => {
    const [indicators, types] = await Promise.all([
      store.query('SELECT models_json AS modelsJson FROM indicator_cache'),
      store.query('SELECT COUNT(*) AS count, MAX(synced_at) AS freshAt FROM indicator_cache'),
    ]);
    const options = new Map();
    for (const row of indicators) {
      let models = [];
      try { models = JSON.parse(row.modelsJson ?? '[]'); } catch { /* ignore malformed cache row */ }
      for (const model of models) {
        const id = String(model.modelId ?? model.id ?? model.datasetId ?? model.modelName ?? '');
        if (!id || options.has(id)) continue;
        options.set(id, {
          id, name: String(model.modelName ?? model.name ?? id),
          bizName: String(model.modelBizName ?? model.bizName ?? ''),
          database: String(model.modelDatabase ?? model.database ?? ''),
          table: String(model.modelTable ?? model.table ?? ''),
          description: String(model.description ?? ''),
        });
      }
    }
    return {
      items: [...options.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
      source: Number(types[0]?.count ?? 0) > 0 ? 'SNAPSHOT' : 'UNAVAILABLE',
      freshAt: types[0]?.freshAt ?? null,
    };
  };
  store.getSkillAsync = (...args) => store.skillRepository.getSkillAsync(...args);
  store.syncExternalSkills = (...args) => store.skillRepository.syncExternalSkills(...args);
  store.getPlatformSettingAsync = async (key, fallback = null) => {
    const [row] = await store.query(
      'SELECT `key`, value_json AS valueJson, updated_at AS updatedAt FROM platform_settings WHERE `key` = ?',
      [String(key)],
    );
    if (!row) return fallback == null ? null : { key: String(key), value: fallback, updatedAt: null };
    let value = row.valueJson;
    try { value = JSON.parse(value); } catch { /* plain text settings remain strings */ }
    return { key: row.key, value, updatedAt: row.updatedAt };
  };
  store.savePlatformSettingAsync = async (key, value) => {
    const timestamp = new Date().toISOString();
    await store.execute(`INSERT INTO platform_settings (
      \`key\`, value_json, updated_at) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = VALUES(updated_at)`,
    [String(key), JSON.stringify(value ?? null), timestamp]);
    return { key: String(key), value, updatedAt: timestamp };
  };
  store.saveMcpQueryContract = async (record) => {
    await store.execute(`INSERT INTO mcp_query_contracts
      (contract_id, tenant_id, user_id, theme_id, source_type, indicator_id, dataset_id,
       contract_json, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      String(record.contractId), String(record.tenantId ?? 'default'), Number(record.userId) || null,
      record.themeId ? Number(record.themeId) : null, String(record.sourceType),
      record.indicatorId ? String(record.indicatorId) : null, record.datasetId ? String(record.datasetId) : null,
      typeof record.contractJson === 'string' ? record.contractJson : JSON.stringify(record.contractJson),
      String(record.status ?? 'FROZEN'), new Date().toISOString(), record.expiresAt ?? null,
    ]);
    return String(record.contractId);
  };
  store.getMcpQueryContractAsync = async (contractId) => {
    const [row] = await store.query(`SELECT contract_id AS contractId, tenant_id AS tenantId,
      user_id AS userId, theme_id AS themeId, source_type AS sourceType, indicator_id AS indicatorId,
      dataset_id AS datasetId, contract_json AS contractJson, status, created_at AS createdAt,
      expires_at AS expiresAt FROM mcp_query_contracts WHERE contract_id = ?`, [String(contractId)]);
    if (!row) return null;
    let contractJson = row.contractJson;
    try { contractJson = JSON.parse(contractJson); } catch { /* preserve invalid payload */ }
    return { ...row, contractJson };
  };
  store.getMcpApiKeyByHashAsync = async (keyHash) => {
    const [row] = await store.query(`SELECT key_id AS keyId, name, tenant_id AS tenantId,
      scopes, revoked FROM mcp_api_keys WHERE key_hash = ? AND revoked = 0`, [String(keyHash ?? '')]);
    if (!row) return null;
    let scopes = row.scopes;
    try { scopes = JSON.parse(scopes); } catch { /* keep scalar scope */ }
    return { ...row, scopes };
  };
  store.createMcpApiKeyAsync = async ({ keyId, keyHash, name, tenantId, createdBy, scopes = 'mcp', createdAt }) => {
    await store.execute(`INSERT INTO mcp_api_keys
      (key_id, key_hash, name, tenant_id, scopes, created_by, created_at, revoked)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)`, [
      String(keyId), String(keyHash), String(name ?? 'mcp'), String(tenantId ?? 'default'),
      JSON.stringify(scopes), Number(createdBy) || null, String(createdAt ?? new Date().toISOString()),
    ]);
    return { keyId: String(keyId), name: name ?? 'mcp', tenantId: tenantId ?? 'default' };
  };
  store.listMcpApiKeysAsync = async () => {
    const rows = await store.query(`SELECT key_id AS keyId, name, tenant_id AS tenantId,
      scopes, created_at AS createdAt, revoked FROM mcp_api_keys ORDER BY created_at DESC`);
    return rows.map((row) => ({
      ...row,
      scopes: parseJson(row.scopes, 'mcp'),
      revoked: row.revoked === true || Number(row.revoked) === 1,
    }));
  };
  store.revokeMcpApiKeyAsync = async (keyId) => {
    const result = await store.execute('UPDATE mcp_api_keys SET revoked = 1 WHERE key_id = ?', [String(keyId)]);
    return Number(result.affectedRows) > 0;
  };
  store.createChatSessionAsync = async ({ userId, themeId, title = '新会话', modelId = null }) => {
    const timestamp = new Date().toISOString();
    const result = await store.execute(`INSERT INTO chat_sessions
      (user_id, theme_id, title, model_id, summary, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', 1, ?, ?)`, [Number(userId), Number(themeId), String(title || '新会话').trim(), modelId ? Number(modelId) : null, timestamp, timestamp]);
    return store.getChatSessionAsync(result.insertId, userId);
  };
  store.getChatSessionAsync = async (id, userId = null) => {
    const [row] = await store.query(`SELECT s.id, s.user_id AS userId, s.theme_id AS themeId,
      t.name AS themeName, s.title, s.model_id AS modelId, s.summary, s.status,
      s.created_at AS createdAt, s.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id=s.id) AS messageCount
      FROM chat_sessions s JOIN themes t ON t.id=s.theme_id
      WHERE s.id=? AND (? IS NULL OR s.user_id=?)`, [Number(id), userId ? Number(userId) : null, userId ? Number(userId) : null]);
    return row ?? null;
  };
  store.listChatSessionsAsync = async (userId, limit = 100) => store.query(`SELECT s.id,
    s.user_id AS userId, s.theme_id AS themeId, t.name AS themeName, s.title,
    s.model_id AS modelId, s.summary, s.status, s.created_at AS createdAt, s.updated_at AS updatedAt,
    (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id=s.id) AS messageCount
    FROM chat_sessions s JOIN themes t ON t.id=s.theme_id WHERE s.user_id=? AND s.status=1
    ORDER BY s.updated_at DESC, s.id DESC LIMIT ?`, [Number(userId), Math.max(1, Math.min(Number(limit) || 100, 500))]);
  store.updateChatSessionAsync = async (id, patch = {}) => {
    const current = await store.getChatSessionAsync(id);
    if (!current) return null;
    await store.execute(`UPDATE chat_sessions SET title=?, summary=?, status=?, model_id=COALESCE(?, model_id), updated_at=? WHERE id=?`, [
      patch.title === undefined ? current.title : String(patch.title).trim(),
      patch.summary === undefined ? current.summary : String(patch.summary),
      patch.status === undefined ? current.status : Number(patch.status),
      patch.modelId === undefined ? null : (patch.modelId ? Number(patch.modelId) : null),
      new Date().toISOString(), Number(id),
    ]);
    return store.getChatSessionAsync(id);
  };
  store.deleteChatSessionAsync = async (id, userId) => {
    const result = await store.execute('DELETE FROM chat_sessions WHERE id=? AND user_id=?', [Number(id), Number(userId)]);
    return Number(result.affectedRows) > 0;
  };
  store.appendChatMessageAsync = async ({ sessionId, userId, role, content, result = {} }) => {
    const timestamp = new Date().toISOString();
    const inserted = await store.execute(`INSERT INTO chat_messages
      (session_id, user_id, role, content, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [Number(sessionId), Number(userId), String(role), String(content ?? ''), JSON.stringify(result ?? {}), timestamp]);
    await store.execute('UPDATE chat_sessions SET updated_at=? WHERE id=?', [timestamp, Number(sessionId)]);
    return { id: Number(inserted.insertId), sessionId: Number(sessionId), userId: Number(userId), role: String(role), content: String(content ?? ''), result, createdAt: timestamp };
  };
  store.saveConversationAsync = async ({ userId, themeId, question, answer }) => {
    const inserted = await store.execute(`INSERT INTO conversations
      (user_id, theme_id, question, answer_json, created_at) VALUES (?, ?, ?, ?, ?)`, [
      Number(userId), Number(themeId), String(question ?? ''), JSON.stringify(answer ?? {}), new Date().toISOString(),
    ]);
    return Number(inserted.insertId);
  };
  store.listChatMessagesAsync = async (sessionId, userId, limit = 50) => {
    const session = await store.getChatSessionAsync(sessionId, userId);
    if (!session) return null;
    const rows = await store.query(`SELECT m.id, m.session_id AS sessionId, m.user_id AS userId,
      m.role, m.content, m.result_json AS resultJson, m.created_at AS createdAt,
      a.id AS artifactId, a.workspace_id AS workspaceId,
      a.title AS artifactTitle, a.artifact_type AS artifactType
      FROM chat_messages m LEFT JOIN workspace_artifacts a ON a.id = (
        SELECT candidate.id FROM workspace_artifacts candidate
        WHERE candidate.message_id=m.id AND candidate.status=1
        ORDER BY candidate.updated_at DESC, candidate.id DESC LIMIT 1
      ) WHERE m.session_id=? ORDER BY m.id DESC LIMIT ?`, [Number(sessionId), Math.max(1, Math.min(Number(limit) || 50, 200))]);
    return rows.reverse().map((row) => {
      let result = {};
      try { result = JSON.parse(row.resultJson || '{}'); } catch { /* use empty result */ }
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
  };
  store.getWorkspaceAsync = async (id, userId = null) => {
    const [row] = await store.query(`SELECT w.id, w.user_id AS userId, w.theme_id AS themeId,
      t.name AS themeName, w.session_id AS sessionId, w.name, w.status,
      w.created_at AS createdAt, w.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM workspace_artifacts a WHERE a.workspace_id=w.id AND a.status=1) AS artifactCount
      FROM workspaces w JOIN themes t ON t.id=w.theme_id WHERE w.id=? AND (? IS NULL OR w.user_id=?)`, [Number(id), userId ? Number(userId) : null, userId ? Number(userId) : null]);
    return row ?? null;
  };
  store.getWorkspaceBySessionAsync = async (sessionId, userId = null) => {
    const [row] = await store.query('SELECT id FROM workspaces WHERE session_id=? AND (? IS NULL OR user_id=?)', [Number(sessionId), userId ? Number(userId) : null, userId ? Number(userId) : null]);
    return row ? store.getWorkspaceAsync(row.id, userId) : null;
  };
  store.ensureWorkspaceAsync = async ({ userId, themeId, sessionId, name = '问数工作区' }) => {
    const existing = await store.getWorkspaceBySessionAsync(sessionId, userId);
    if (existing) return existing;
    const timestamp = new Date().toISOString();
    const result = await store.execute(`INSERT INTO workspaces (user_id, theme_id, session_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`, [Number(userId), Number(themeId), Number(sessionId), String(name || '问数工作区').trim(), timestamp, timestamp]);
    return store.getWorkspaceAsync(result.insertId, userId);
  };
  store.updateWorkspaceAsync = async (id, userId, { name } = {}) => {
    const current = await store.getWorkspaceAsync(id, userId); if (!current) return null;
    await store.execute('UPDATE workspaces SET name=?, updated_at=? WHERE id=? AND user_id=?', [name === undefined ? current.name : String(name).trim(), new Date().toISOString(), Number(id), Number(userId)]);
    return store.getWorkspaceAsync(id, userId);
  };
  store.getWorkspaceArtifactAsync = async (id, userId = null) => {
    const [row] = await store.query(`SELECT a.id, a.workspace_id AS workspaceId, a.user_id AS userId,
      a.session_id AS sessionId, a.message_id AS messageId, a.conversation_id AS conversationId,
      a.artifact_type AS artifactType, a.title, a.current_version AS currentVersion,
      a.metadata_json AS metadataJson, a.status, a.created_at AS createdAt, a.updated_at AS updatedAt,
      v.payload_json AS payloadJson FROM workspace_artifacts a JOIN artifact_versions v ON v.artifact_id=a.id AND v.version=a.current_version
      WHERE a.id=? AND (? IS NULL OR a.user_id=?)`, [String(id), userId ? Number(userId) : null, userId ? Number(userId) : null]);
    if (!row) return null; let metadata = {}; let payload = {}; try { metadata = JSON.parse(row.metadataJson || '{}'); } catch {} try { payload = JSON.parse(row.payloadJson || '{}'); } catch {} return { ...row, metadata, payload };
  };
  store.listWorkspaceArtifactsAsync = async (workspaceId, userId = null) => {
    const rows = await store.query(`SELECT a.id, a.workspace_id AS workspaceId, a.user_id AS userId,
      a.session_id AS sessionId, a.message_id AS messageId, a.conversation_id AS conversationId,
      a.artifact_type AS artifactType, a.title, a.current_version AS currentVersion,
      a.metadata_json AS metadataJson, a.status, a.created_at AS createdAt, a.updated_at AS updatedAt
      FROM workspace_artifacts a WHERE a.workspace_id=? AND a.status=1 AND (? IS NULL OR a.user_id=?) ORDER BY a.updated_at DESC, a.id DESC`, [Number(workspaceId), userId ? Number(userId) : null, userId ? Number(userId) : null]);
    return rows.map((row) => { let metadata = {}; try { metadata = JSON.parse(row.metadataJson || '{}'); } catch {} return { ...row, metadata }; });
  };
  store.createWorkspaceArtifactAsync = async (input) => {
    const artifactId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    await store.transaction(async (tx) => {
      await tx.execute(`INSERT INTO workspace_artifacts
        (id, workspace_id, user_id, session_id, message_id, conversation_id, artifact_type, title, current_version, metadata_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)`, [artifactId, Number(input.workspaceId), Number(input.userId), input.sessionId ? Number(input.sessionId) : null, input.messageId ? Number(input.messageId) : null, input.conversationId ? Number(input.conversationId) : null, String(input.artifactType ?? 'TABLE'), String(input.title ?? ''), JSON.stringify(input.metadata ?? {}), timestamp, timestamp]);
      await tx.execute(`INSERT INTO artifact_versions (id, artifact_id, version, operation_json, payload_json, created_at) VALUES (?, ?, 1, ?, ?, ?)`, [crypto.randomUUID(), artifactId, JSON.stringify({ type: 'CREATE' }), JSON.stringify(input.payload ?? {}), timestamp]);
      await tx.execute('UPDATE workspaces SET updated_at=? WHERE id=?', [timestamp, Number(input.workspaceId)]);
    });
    return store.getWorkspaceArtifactAsync(artifactId, input.userId);
  };
  store.appendWorkspaceArtifactVersionAsync = async ({ artifactId, userId, operation = {}, payload = {}, metadata = undefined }) => {
    const artifact = await store.getWorkspaceArtifactAsync(artifactId, userId); if (!artifact) throw new Error('workspace artifact not found');
    const version = Number(artifact.currentVersion) + 1; const timestamp = new Date().toISOString();
    await store.transaction(async (tx) => {
      await tx.execute('INSERT INTO artifact_versions (id, artifact_id, version, operation_json, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', [crypto.randomUUID(), artifact.id, version, JSON.stringify(operation), JSON.stringify(payload), timestamp]);
      await tx.execute('UPDATE workspace_artifacts SET current_version=?, metadata_json=?, updated_at=? WHERE id=? AND user_id=?', [version, JSON.stringify(metadata ?? artifact.metadata ?? {}), timestamp, artifact.id, Number(userId)]);
      await tx.execute('UPDATE workspaces SET updated_at=? WHERE id=(SELECT workspace_id FROM workspace_artifacts WHERE id=?)', [timestamp, artifact.id]);
    });
    return store.getWorkspaceArtifactAsync(artifact.id, userId);
  };
  store.bindWorkspaceArtifactsToMessageAsync = async ({ artifactIds = [], userId, messageId }) => {
    const ids = [...new Set(artifactIds.map(String).filter(Boolean))];
    if (ids.length === 0) return 0;
    const timestamp = new Date().toISOString(); let count = 0;
    await store.transaction(async (tx) => {
      for (const id of ids) {
        const result = await tx.execute('UPDATE workspace_artifacts SET message_id=?, updated_at=? WHERE id=? AND user_id=?', [Number(messageId), timestamp, id, Number(userId)]);
        count += Number(result.affectedRows ?? 0);
      }
    });
    return count;
  };
  store.saveQueryPlanAsync = async (input) => {
    const timestamp = new Date().toISOString();
    await store.execute(`INSERT INTO query_plans
      (id, user_id, theme_id, session_id, source_type, dataset_id, compiler_version, trace_id,
       question, status, plan_json, validation_json, evidence_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE source_type=VALUES(source_type), dataset_id=VALUES(dataset_id),
      compiler_version=VALUES(compiler_version), trace_id=VALUES(trace_id), status=VALUES(status),
      plan_json=VALUES(plan_json), validation_json=VALUES(validation_json), evidence_json=VALUES(evidence_json)`, [
      String(input.id), Number(input.userId), Number(input.themeId), input.sessionId ? Number(input.sessionId) : null,
      String(input.sourceType ?? 'INDICATOR'), input.datasetId ? String(input.datasetId) : null,
      String(input.compilerVersion ?? input.plan?.compilerVersion ?? ''), input.traceId ? String(input.traceId) : null,
      String(input.question ?? ''), String(input.status ?? 'COMPILED'), JSON.stringify(input.plan ?? {}),
      JSON.stringify(input.validation ?? {}), JSON.stringify(input.evidence ?? {}), timestamp,
    ]);
    return store.getQueryPlanAsync(input.id, input.userId);
  };
  store.getQueryPlanAsync = async (id, userId = null) => {
    const [row] = await store.query(`SELECT id, user_id AS userId, theme_id AS themeId, session_id AS sessionId,
      source_type AS sourceType, dataset_id AS datasetId, compiler_version AS compilerVersion, trace_id AS traceId,
      question, status, plan_json AS planJson, validation_json AS validationJson, evidence_json AS evidenceJson, created_at AS createdAt
      FROM query_plans WHERE id=? AND (? IS NULL OR user_id=?)`, [String(id), userId ? Number(userId) : null, userId ? Number(userId) : null]);
    if (!row) return null; let plan = {}; let validation = {}; let evidence = {}; try { plan = JSON.parse(row.planJson || '{}'); } catch {} try { validation = JSON.parse(row.validationJson || '{}'); } catch {} try { evidence = JSON.parse(row.evidenceJson || '{}'); } catch {} return { ...row, plan, validation, evidence };
  };
  const parseJson = (value, fallback) => { try { return JSON.parse(value ?? ''); } catch { return fallback; } };
  const semanticSnapshotItemsAsync = async (snapshotId) => {
    const rows = await store.query(`SELECT id, snapshot_id AS snapshotId, value, normalized_value AS normalizedValue,
      aliases_json AS aliasesJson, origin, origin_ref AS originRef, confidence, enabled,
      first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
      FROM semantic_value_snapshot_items WHERE snapshot_id=? AND enabled=1 ORDER BY id`, [Number(snapshotId)]);
    return rows.map((row) => ({ ...row, aliases: parseJson(row.aliasesJson, []), enabled: Boolean(row.enabled) }));
  };
  store.getActiveSemanticValueSnapshotAsync = async ({ themeId, sourceType, sourceId, fieldName }) => {
    const [row] = await store.query(`SELECT id, theme_id AS themeId, source_type AS sourceType,
      source_id AS sourceId, field_name AS fieldName, display_name AS displayName, version, status,
      origin_mask_json AS originMaskJson, value_count AS valueCount, sample_size AS sampleSize, checksum,
      scope_signature AS scopeSignature, schema_hash AS schemaHash, error_message AS errorMessage,
      refreshed_at AS refreshedAt, expires_at AS expiresAt, created_at AS createdAt, updated_at AS updatedAt
      FROM semantic_value_snapshots WHERE theme_id=? AND source_type=? AND source_id=? AND field_name=?
      ORDER BY version DESC, id DESC LIMIT 1`, [Number(themeId), String(sourceType), String(sourceId), String(fieldName)]);
    if (!row) return null;
    return { ...row, origins: parseJson(row.originMaskJson, []), items: await semanticSnapshotItemsAsync(row.id) };
  };
  store.listSemanticValueOverridesAsync = async ({ themeId, sourceType = null, sourceId = null, fieldName = null }) => {
    const rows = await store.query(`SELECT id, theme_id AS themeId, source_type AS sourceType,
      source_id AS sourceId, field_name AS fieldName, concept, aliases_json AS aliasesJson, operator,
      configured_values_json AS configuredValuesJson, rule_source AS ruleSource, action,
      allow_unverified AS allowUnverified, enabled, updated_by AS updatedBy, created_at AS createdAt, updated_at AS updatedAt
      FROM semantic_value_overrides WHERE theme_id=? AND (? IS NULL OR source_type=?)
      AND (? IS NULL OR source_id=?) AND (? IS NULL OR field_name=?) ORDER BY id`,
    [Number(themeId), sourceType || null, sourceType || null, sourceId == null ? null : String(sourceId), sourceId == null ? null : String(sourceId), fieldName || null, fieldName || null]);
    return rows.map((row) => ({ ...row, aliases: parseJson(row.aliasesJson, []), configuredValues: parseJson(row.configuredValuesJson, []), allowUnverified: Boolean(row.allowUnverified), enabled: Boolean(row.enabled) }));
  };
  store.saveSemanticValueSnapshotAsync = async (input) => store.transaction(async (tx) => {
    const previous = await store.getActiveSemanticValueSnapshotAsync(input);
    const timestamp = new Date().toISOString();
    const items = input.items ?? [];
    const checksum = items.length ? crypto.createHash('sha256').update(JSON.stringify(items.map((item) => item.value).sort())).digest('hex') : '';
    const inserted = await tx.execute(`INSERT INTO semantic_value_snapshots
      (theme_id, source_type, source_id, field_name, display_name, version, status, origin_mask_json,
       value_count, sample_size, checksum, scope_signature, schema_hash, error_message, refreshed_at, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [Number(input.themeId), String(input.sourceType), String(input.sourceId), String(input.fieldName), String(input.displayName ?? ''), Number(previous?.version ?? 0) + 1, String(input.status ?? 'UNKNOWN'), JSON.stringify(input.origins ?? []), items.length, Number(input.sampleSize) || 0, checksum, String(input.scopeSignature ?? ''), String(input.schemaHash ?? ''), String(input.errorMessage ?? ''), timestamp, input.expiresAt ?? null, timestamp, timestamp]);
    for (const item of items) await tx.execute(`INSERT INTO semantic_value_snapshot_items
      (snapshot_id, value, normalized_value, aliases_json, origin, origin_ref, confidence, enabled, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, [inserted.insertId, String(item.value ?? ''), String(item.value ?? '').toLowerCase().replace(/\s+/g, ''), JSON.stringify(item.aliases ?? []), String(item.origin ?? ''), String(item.originRef ?? ''), Number(item.confidence ?? 1), String(item.firstSeenAt ?? timestamp), timestamp]);
    return { id: inserted.insertId };
  }).then(() => store.getActiveSemanticValueSnapshotAsync(input));
  store.createSemanticValueAuditLogAsync = async (input) => {
    const result = await store.execute(`INSERT INTO semantic_value_audit_logs
      (theme_id, source_type, source_id, field_name, action, before_checksum, after_checksum, actor_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [Number(input.themeId), String(input.sourceType), String(input.sourceId), String(input.fieldName), String(input.action ?? ''), String(input.beforeChecksum ?? ''), String(input.afterChecksum ?? ''), input.actorId ? Number(input.actorId) : null, new Date().toISOString()]);
    return result.insertId;
  };
  store.replaceSemanticValueDomainsAsync = async (input) => {
    const timestamp = new Date().toISOString();
    await store.transaction(async (tx) => {
      await tx.execute(`DELETE FROM theme_semantic_value_domains WHERE theme_id=? AND source_type=? AND source_id=? AND field_name=?`, [Number(input.themeId), String(input.sourceType), String(input.sourceId), String(input.fieldName)]);
      for (const candidate of input.values ?? []) await tx.execute(`INSERT INTO theme_semantic_value_domains
        (theme_id, source_type, source_id, field_name, display_name, value, normalized_value, aliases_json, description, source, confidence, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, [Number(input.themeId), String(input.sourceType), String(input.sourceId), String(input.fieldName), String(input.displayName ?? ''), String(candidate.value ?? candidate), String(candidate.value ?? candidate).toLowerCase().replace(/\s+/g, ''), JSON.stringify(candidate.aliases ?? []), String(input.description ?? ''), String(candidate.source ?? 'DESCRIPTION'), Number(candidate.confidence ?? 1), timestamp, timestamp]);
    });
    return store.listSemanticValueDomainsAsync(input);
  };
  store.listSemanticValueDomainsAsync = async ({ themeId, sourceType, sourceId, fieldName = null }) => {
    const rows = await store.query(`SELECT id, source_type AS sourceType, source_id AS sourceId, field_name AS fieldName,
      display_name AS displayName, value, normalized_value AS normalizedValue, aliases_json AS aliasesJson,
      description, source, confidence, enabled FROM theme_semantic_value_domains
      WHERE theme_id=? AND source_type=? AND source_id=? AND (? IS NULL OR field_name=?) AND enabled=1 ORDER BY field_name, id`, [Number(themeId), String(sourceType), String(sourceId), fieldName || null, fieldName || null]);
    return rows.map((row) => ({ ...row, aliases: parseJson(row.aliasesJson, []), enabled: Boolean(row.enabled) }));
  };
  store.saveSemanticValueOverrideAsync = async (input) => {
    const timestamp = new Date().toISOString();
    await store.execute(`INSERT INTO semantic_value_overrides
      (theme_id, source_type, source_id, field_name, concept, aliases_json, operator, configured_values_json, rule_source, action, allow_unverified, enabled, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE aliases_json=VALUES(aliases_json), operator=VALUES(operator), configured_values_json=VALUES(configured_values_json), rule_source=VALUES(rule_source), allow_unverified=VALUES(allow_unverified), enabled=VALUES(enabled), updated_by=VALUES(updated_by), updated_at=VALUES(updated_at)`, [Number(input.themeId), String(input.sourceType), String(input.sourceId), String(input.fieldName), String(input.concept ?? ''), JSON.stringify(input.aliases ?? []), String(input.operator ?? 'IN'), JSON.stringify(input.configuredValues ?? []), String(input.ruleSource ?? ''), String(input.action ?? 'ENUM_MAPPING'), input.allowUnverified ? 1 : 0, input.enabled === false ? 0 : 1, input.updatedBy ? Number(input.updatedBy) : null, timestamp, timestamp]);
    return store.listSemanticValueOverridesAsync(input);
  };
  store.updateSemanticValueRefreshJobAsync = async (jobId, update = {}) => {
    const fields = ['status','scanned_count','added_count','removed_count','changed_count','error_json','started_at','finished_at'];
    const values = [update.status ?? null, Number.isInteger(update.scannedCount) ? update.scannedCount : null, Number.isInteger(update.addedCount) ? update.addedCount : null, Number.isInteger(update.removedCount) ? update.removedCount : null, Number.isInteger(update.changedCount) ? update.changedCount : null, update.error ? JSON.stringify(update.error) : null, update.startedAt ?? null, update.finishedAt ?? null];
    await store.execute(`UPDATE semantic_value_refresh_jobs SET status=COALESCE(?,status), scanned_count=COALESCE(?,scanned_count), added_count=COALESCE(?,added_count), removed_count=COALESCE(?,removed_count), changed_count=COALESCE(?,changed_count), error_json=COALESCE(?,error_json), started_at=COALESCE(?,started_at), finished_at=COALESCE(?,finished_at) WHERE id=?`, [...values, Number(jobId)]);
    const [row] = await store.query(`SELECT id, theme_id AS themeId, source_type AS sourceType, source_id AS sourceId, field_name AS fieldName, trigger, status, requested_by AS requestedBy, scanned_count AS scannedCount, added_count AS addedCount, removed_count AS removedCount, changed_count AS changedCount, error_json AS errorJson, started_at AS startedAt, finished_at AS finishedAt, created_at AS createdAt FROM semantic_value_refresh_jobs WHERE id=?`, [Number(jobId)]);
    return row ? { ...row, error: parseJson(row.errorJson, {}) } : null;
  };
  store.createSemanticValueRefreshJobAsync = async ({ themeId, sourceType, sourceId, fieldName, trigger = 'MANUAL', requestedBy = null }) => {
    const result = await store.execute(`INSERT INTO semantic_value_refresh_jobs
      (theme_id, source_type, source_id, field_name, trigger, status, requested_by, scanned_count, added_count, removed_count, changed_count, error_json, started_at, finished_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'PENDING', ?, 0, 0, 0, 0, '{}', NULL, NULL, ?)`, [Number(themeId), String(sourceType), String(sourceId), String(fieldName), String(trigger), requestedBy ? Number(requestedBy) : null, new Date().toISOString()]);
    return Number(result.insertId);
  };

  // These query/execute-based async operations live on PlatformDatabase for
  // the native SQLite facade. Reuse them on the MySQL store as well; they only
  // depend on the common async store contract and repositories attached above.
  // Keeping the method list explicit avoids accidentally exposing SQLite-only
  // sync APIs (or methods that require `this.db`) on a remote store.
  for (const methodName of [
    'getDataSourceByCodeAsync',
    'getBusinessDatasetAsync',
    'saveBusinessDatasetAsync',
    'replaceDatasetFieldsAsync',
    'listDatasetFieldsAsync',
    'setDatasetFieldEnabledAsync',
    'deleteBusinessDatasetAsync',
  ]) {
    if (typeof store[methodName] !== 'function'
      && typeof PlatformDatabase.prototype[methodName] === 'function') {
      store[methodName] = (...args) => PlatformDatabase.prototype[methodName].apply(store, args);
    }
  }
  return store;
}
