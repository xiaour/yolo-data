import { randomUUID, createHash } from 'node:crypto';

export function createUploadSource({ buffer, name, extension, mimeType }) {
  return { type: 'UPLOAD', name, extension, size: buffer.length, mimeType,
    sha256: createHash('sha256').update(buffer).digest('hex'), uploadedAt: new Date().toISOString() };
}

export function uploadError(message, statusCode = 400, code = 'UPLOAD_REJECTED') {
  return Object.assign(new Error(message), { statusCode, code });
}

export function assertUploadQuota(artifacts, incomingBytes, limits) {
  const uploads = artifacts.filter(artifact => artifact.metadata?.source?.type === 'UPLOAD');
  if (uploads.length >= limits.maxFilesPerSession) {
    throw uploadError(`单个会话最多上传 ${limits.maxFilesPerSession} 个文件，请先清理或新建会话`, 429, 'UPLOAD_QUOTA_EXCEEDED');
  }
  const usedBytes = uploads.reduce((total, artifact) => total + Number(artifact.metadata?.size ?? 0), 0);
  if (usedBytes + incomingBytes > limits.maxTotalBytesPerSession) {
    throw uploadError(`会话内上传文件总大小超过 ${Math.floor(limits.maxTotalBytesPerSession / 1024 / 1024)}MB，请新建会话`, 429, 'UPLOAD_QUOTA_EXCEEDED');
  }
}

// The generator describes one short SQL unit so both drivers execute exactly the
// same checks and writes. Only the MySQL executor awaits; SQLite never yields.
function* admissionStatements({ userId, sessionId, name, file, limits }, mysql) {
  const query = (sql, bindings) => ({ sql, bindings, write: false });
  const execute = (sql, bindings) => ({ sql, bindings, write: true });
  // Lock an existing parent before any consistent read: this covers the first
  // workspace too, and ensures MySQL's snapshot includes the previous admission.
  const [session] = yield query(`SELECT id, theme_id AS themeId FROM chat_sessions WHERE id=? AND user_id=?${mysql ? ' FOR UPDATE' : ''}`, [Number(sessionId), Number(userId)]);
  if (!session) throw uploadError('上传前需要先建立会话', 404, 'UPLOAD_SESSION_REQUIRED');
  let [workspace] = yield query('SELECT id FROM workspaces WHERE session_id=? AND user_id=? ORDER BY id LIMIT 1', [Number(sessionId), Number(userId)]);
  const timestamp = new Date().toISOString();
  if (!workspace) {
    const result = yield execute('INSERT INTO workspaces (user_id, theme_id, session_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)', [Number(userId), Number(session.themeId), Number(sessionId), name, timestamp, timestamp]);
    workspace = { id: result.insertId };
  }
  const rows = yield query('SELECT metadata_json AS metadataJson FROM workspace_artifacts WHERE session_id=? AND user_id=? AND status=1', [Number(sessionId), Number(userId)]);
  const artifacts = rows.map(row => {
    let metadata = {};
    try { metadata = JSON.parse(row.metadataJson || '{}'); } catch { /* match artifact repository */ }
    return { metadata };
  });
  assertUploadQuota(artifacts, file.size, limits);
  const artifactId = randomUUID();
  const metadata = { format: file.format, mimeType: file.mimeType, size: file.size, purpose: file.purpose, source: file.source, runId: null, inputArtifactIds: [], parentArtifactIds: [] };
  const payload = { encoding: file.encoding, content: file.content, format: file.format, mimeType: file.mimeType };
  yield execute(`INSERT INTO workspace_artifacts
    (id, workspace_id, user_id, session_id, message_id, conversation_id, artifact_type, title, current_version, metadata_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, NULL, 'FILE', ?, 1, ?, 1, ?, ?)`, [artifactId, Number(workspace.id), Number(userId), Number(sessionId), file.title, JSON.stringify(metadata), timestamp, timestamp]);
  yield execute('INSERT INTO artifact_versions (id, artifact_id, version, operation_json, payload_json, created_at) VALUES (?, ?, 1, ?, ?, ?)', [randomUUID(), artifactId, JSON.stringify({ type: 'CREATE' }), JSON.stringify(payload), timestamp]);
  yield execute('UPDATE workspaces SET name=?, updated_at=? WHERE id=? AND user_id=?', [name, timestamp, Number(workspace.id), Number(userId)]);
  return { workspaceRecord: workspace, fileArtifact: { id: artifactId, title: file.title } };
}

export function admitUpload(database, input) {
  const db = database.db;
  const previousTimeout = db.prepare('PRAGMA busy_timeout').get().timeout;
  // Keep this bound for derived writes too: another process may acquire the
  // admission lock immediately after this transaction commits.
  db.exec(`PRAGMA busy_timeout=${Math.max(5000, Number(previousTimeout))}`);
  let started = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    started = true;
    const statements = admissionStatements(input, false);
    let step = statements.next();
    while (!step.done) {
      const { sql, bindings, write } = step.value;
      const statement = db.prepare(sql);
      const value = write ? statement.run(...bindings) : statement.all(...bindings);
      step = statements.next(write ? { insertId: Number(value.lastInsertRowid ?? 0) } : value);
    }
    db.exec('COMMIT');
    return step.value;
  } catch (error) {
    if (started) db.exec('ROLLBACK');
    throw error;
  }
}

export async function admitUploadAsync(database, input) {
  if (database.db) return admitUpload(database, input);
  return database.transaction(async tx => {
    const statements = admissionStatements(input, true);
    let step = statements.next();
    while (!step.done) {
      const { sql, bindings, write } = step.value;
      step = statements.next(await (write ? tx.execute(sql, bindings) : tx.query(sql, bindings)));
    }
    return step.value;
  });
}
