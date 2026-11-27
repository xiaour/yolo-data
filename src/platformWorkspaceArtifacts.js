import crypto from 'node:crypto';

// MySQL 平台存储的问数工作区与产物仓储：工作区的创建/查询/更新，产物的
// 版本化读写与消息绑定。挂载入口见 platformAsyncRepositories.js 的
// attachAsyncRepositories；各方法只依赖 store 的通用 query/execute/transaction 契约。
export function attachWorkspaceArtifactsStore(store) {
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
  return store;
}
