import crypto from 'node:crypto';

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

// Workspace persistence shares the platform SQLite connection and migration lifecycle.
export class WorkspaceRepository {
  constructor(db) {
    this.db = db;
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

}
