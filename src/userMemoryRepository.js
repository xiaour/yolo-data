// Scoped memory reads and note persistence for synchronous and async stores.
import {
  NOTE_SOURCES, NOTE_STATES, KIND_SET, MIN_NOTE_LENGTH, MAX_NOTE_LENGTH, MAX_PENDING_NOTES,
  memoryScopeKey, normalizeNoteContent, normalizeKind, noteKey, nowIso,
  mapDocument, mapNote, DOCUMENT_COLUMNS, NOTE_COLUMNS,
} from './userMemoryModel.js';

export class UserMemoryRepository {
  constructor(database) {
    this.database = database;
  }

  listDocuments({
    userId = null, themeId = null, status = null, limit = 50,
  } = {}) {
    const conditions = [];
    const params = [];
    if (userId !== null && userId !== undefined) {
      conditions.push('d.user_id = ?');
      params.push(Number(userId));
    }
    if (themeId) {
      conditions.push('(d.theme_id = ? OR d.theme_id IS NULL)');
      params.push(Number(themeId));
    }
    if (status === 0 || status === 1) {
      conditions.push('d.status = ?');
      params.push(Number(status));
    }
    return this.database.db.prepare(`
      SELECT ${DOCUMENT_COLUMNS}
      FROM user_memory_documents d
      LEFT JOIN themes t ON t.id = d.theme_id
      ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY d.theme_id IS NULL, d.updated_at DESC, d.id DESC
      LIMIT ?
    `).all(...params, Math.max(1, Math.min(Number(limit) || 50, 200))).map(mapDocument);
  }

  async listDocumentsAsync({
    userId = null, themeId = null, status = null, limit = 50,
  } = {}) {
    const conditions = [];
    const params = [];
    if (userId !== null && userId !== undefined) {
      conditions.push('d.user_id = ?');
      params.push(Number(userId));
    }
    if (themeId) {
      conditions.push('(d.theme_id = ? OR d.theme_id IS NULL)');
      params.push(Number(themeId));
    }
    if (status === 0 || status === 1) {
      conditions.push('d.status = ?');
      params.push(Number(status));
    }
    const rows = await this.database.query(`
      SELECT ${DOCUMENT_COLUMNS}
      FROM user_memory_documents d
      LEFT JOIN themes t ON t.id = d.theme_id
      ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY d.theme_id IS NULL, d.updated_at DESC, d.id DESC
      LIMIT ?
    `, [...params, Math.max(1, Math.min(Number(limit) || 50, 200))]);
    return rows.map(mapDocument);
  }


  getDocument(id) {
    return mapDocument(this.database.db.prepare(`
      SELECT ${DOCUMENT_COLUMNS}
      FROM user_memory_documents d
      LEFT JOIN themes t ON t.id = d.theme_id
      WHERE d.id = ?
    `).get(Number(id)));
  }

  async getDocumentAsync(id) {
    const [row] = await this.database.query(`
      SELECT ${DOCUMENT_COLUMNS}
      FROM user_memory_documents d
      LEFT JOIN themes t ON t.id = d.theme_id
      WHERE d.id = ?
    `, [Number(id)]);
    return mapDocument(row);
  }

  getDocumentByScope(userId, themeId) {
    return mapDocument(this.database.db.prepare(`
      SELECT ${DOCUMENT_COLUMNS}
      FROM user_memory_documents d
      LEFT JOIN themes t ON t.id = d.theme_id
      WHERE d.user_id = ? AND d.scope_key = ?
    `).get(Number(userId), memoryScopeKey(themeId)));
  }

  async getDocumentByScopeAsync(userId, themeId) {
    const [row] = await this.database.query(`
      SELECT ${DOCUMENT_COLUMNS}
      FROM user_memory_documents d
      LEFT JOIN themes t ON t.id = d.theme_id
      WHERE d.user_id = ? AND d.scope_key = ?
    `, [Number(userId), memoryScopeKey(themeId)]);
    return mapDocument(row);
  }

  listNotes({
    userId, themeId = null, scopeKey = '', state = '', kind = '', keyword = '', limit = 200,
  } = {}) {
    const conditions = ['n.user_id = ?'];
    const params = [Number(userId)];
    if (scopeKey) {
      conditions.push('n.scope_key = ?');
      params.push(String(scopeKey));
    } else if (themeId) {
      conditions.push('(n.theme_id = ? OR n.theme_id IS NULL)');
      params.push(Number(themeId));
    }
    if (NOTE_STATES[String(state ?? '').toUpperCase()]) {
      conditions.push('n.state = ?');
      params.push(String(state).toUpperCase());
    }
    if (KIND_SET.has(String(kind ?? '').toUpperCase())) {
      conditions.push('n.kind = ?');
      params.push(String(kind).toUpperCase());
    }
    if (String(keyword ?? '').trim()) {
      conditions.push('n.content LIKE ?');
      params.push(`%${String(keyword).trim()}%`);
    }
    return this.database.db.prepare(`
      SELECT ${NOTE_COLUMNS}
      FROM user_memory_notes n
      LEFT JOIN themes t ON t.id = n.theme_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY n.state = 'PENDING' DESC, n.id DESC
      LIMIT ?
    `).all(...params, Math.max(1, Math.min(Number(limit) || 200, 500))).map(mapNote);
  }

  async listNotesAsync({
    userId, themeId = null, scopeKey = '', state = '', kind = '', keyword = '', limit = 200,
  } = {}) {
    const conditions = ['n.user_id = ?'];
    const params = [Number(userId)];
    if (scopeKey) {
      conditions.push('n.scope_key = ?');
      params.push(String(scopeKey));
    } else if (themeId) {
      conditions.push('(n.theme_id = ? OR n.theme_id IS NULL)');
      params.push(Number(themeId));
    }
    if (NOTE_STATES[String(state ?? '').toUpperCase()]) {
      conditions.push('n.state = ?');
      params.push(String(state).toUpperCase());
    }
    if (KIND_SET.has(String(kind ?? '').toUpperCase())) {
      conditions.push('n.kind = ?');
      params.push(String(kind).toUpperCase());
    }
    if (String(keyword ?? '').trim()) {
      conditions.push('n.content LIKE ?');
      params.push(`%${String(keyword).trim()}%`);
    }
    const rows = await this.database.query(`
      SELECT ${NOTE_COLUMNS}
      FROM user_memory_notes n
      LEFT JOIN themes t ON t.id = n.theme_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY n.state = 'PENDING' DESC, n.id DESC
      LIMIT ?
    `, [...params, Math.max(1, Math.min(Number(limit) || 200, 500))]);
    return rows.map(mapNote);
  }

  getNote(id) {
    return mapNote(this.database.db.prepare(`
      SELECT ${NOTE_COLUMNS}
      FROM user_memory_notes n
      LEFT JOIN themes t ON t.id = n.theme_id
      WHERE n.id = ?
    `).get(Number(id)));
  }

  async getNoteAsync(id) {
    const [row] = await this.database.query(`SELECT ${NOTE_COLUMNS}
      FROM user_memory_notes n LEFT JOIN themes t ON t.id = n.theme_id WHERE n.id = ?`, [Number(id)]);
    return mapNote(row);
  }

  pendingNotes(userId, themeId = null, limit = MAX_PENDING_NOTES) {
    return this.listNotes({
      userId,
      themeId,
      state: 'PENDING',
      limit,
    });
  }

  async pendingNotesAsync(userId, themeId = null, limit = MAX_PENDING_NOTES) {
    return this.listNotesAsync({ userId, themeId, state: 'PENDING', limit });
  }

  // 笔记只追加：同一作用域内内容重复时只刷新时间与来源，不新增条目，也不覆盖已有类型，
  // 避免后续自动提炼把用户手工选定的分类改掉。

  createNote({
    userId, themeId = null, kind, content, source = 'DISTILLED', state = 'PENDING',
    sessionId = null, createdAt = null,
  }) {
    const text = normalizeNoteContent(content);
    if (text.length < MIN_NOTE_LENGTH || text.length > MAX_NOTE_LENGTH) {
      return null;
    }
    const scopeKey = memoryScopeKey(themeId);
    const key = noteKey(text);
    const timestamp = nowIso();
    const existing = this.database.db.prepare(`
      SELECT id, state FROM user_memory_notes
      WHERE user_id = ? AND scope_key = ? AND dedupe_key = ?
    `).get(Number(userId), scopeKey, key);
    if (existing) {
      this.database.db.prepare(`
        UPDATE user_memory_notes
        SET content = ?, updated_at = ?,
            state = CASE WHEN state = 'ARCHIVED' THEN 'PENDING' ELSE state END
        WHERE id = ?
      `).run(text, timestamp, existing.id);
      return { ...this.getNote(existing.id), deduped: true };
    }
    const result = this.database.db.prepare(`
      INSERT INTO user_memory_notes
        (user_id, theme_id, scope_key, kind, source, state, content, dedupe_key,
         session_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(userId),
      themeId ? Number(themeId) : null,
      scopeKey,
      normalizeKind(kind),
      NOTE_SOURCES[String(source ?? '').toUpperCase()] ? String(source).toUpperCase() : 'DISTILLED',
      NOTE_STATES[String(state ?? '').toUpperCase()] ? String(state).toUpperCase() : 'PENDING',
      text,
      key,
      sessionId ? Number(sessionId) : null,
      createdAt ?? timestamp,
      timestamp,
    );
    return { ...this.getNote(Number(result.lastInsertRowid)), deduped: false };
  }

  async createNoteAsync({
    userId, themeId = null, kind, content, source = 'DISTILLED', state = 'PENDING',
    sessionId = null, createdAt = null,
  }) {
    const text = normalizeNoteContent(content);
    if (text.length < MIN_NOTE_LENGTH || text.length > MAX_NOTE_LENGTH) return null;
    const scopeKey = memoryScopeKey(themeId);
    const key = noteKey(text);
    const timestamp = nowIso();
    let id;
    let deduped = false;
    await this.database.transaction(async (tx) => {
      const [existing] = await tx.query(`SELECT id FROM user_memory_notes
        WHERE user_id = ? AND scope_key = ? AND dedupe_key = ?`, [Number(userId), scopeKey, key]);
      if (existing) {
        id = Number(existing.id);
        deduped = true;
        await tx.execute(`UPDATE user_memory_notes SET content = ?, updated_at = ?,
          state = CASE WHEN state = 'ARCHIVED' THEN 'PENDING' ELSE state END WHERE id = ?`, [text, timestamp, id]);
        return;
      }
      const result = await tx.execute(`INSERT INTO user_memory_notes
        (user_id, theme_id, scope_key, kind, source, state, content, dedupe_key,
         session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        Number(userId), themeId ? Number(themeId) : null, scopeKey, normalizeKind(kind),
        NOTE_SOURCES[String(source ?? '').toUpperCase()] ? String(source).toUpperCase() : 'DISTILLED',
        NOTE_STATES[String(state ?? '').toUpperCase()] ? String(state).toUpperCase() : 'PENDING',
        text, key, sessionId ? Number(sessionId) : null, createdAt ?? timestamp, timestamp,
      ]);
      id = Number(result.insertId);
    });
    return { ...(await this.getNoteAsync(id)), deduped };
  }

  updateNote(id, { content, kind, state } = {}) {
    const current = this.getNote(id);
    if (!current) {
      return null;
    }
    const text = content === undefined ? current.content : normalizeNoteContent(content);
    if (text.length < MIN_NOTE_LENGTH || text.length > MAX_NOTE_LENGTH) {
      return null;
    }
    this.database.db.prepare(`
      UPDATE user_memory_notes
      SET content = ?, kind = ?, state = ?, dedupe_key = ?, updated_at = ?
      WHERE id = ?
    `).run(
      text,
      kind === undefined ? current.kind : normalizeKind(kind),
      state === undefined
        ? current.state
        : (NOTE_STATES[String(state).toUpperCase()] ? String(state).toUpperCase() : current.state),
      noteKey(text),
      nowIso(),
      Number(id),
    );
    return this.getNote(id);
  }

  async updateNoteAsync(id, { content, kind, state } = {}) {
    const current = await this.getNoteAsync(id);
    if (!current) return null;
    const text = content === undefined ? current.content : normalizeNoteContent(content);
    if (text.length < MIN_NOTE_LENGTH || text.length > MAX_NOTE_LENGTH) return null;
    await this.database.execute(`UPDATE user_memory_notes SET content = ?, kind = ?, state = ?,
      dedupe_key = ?, updated_at = ? WHERE id = ?`, [text,
      kind === undefined ? current.kind : normalizeKind(kind),
      state === undefined ? current.state : (NOTE_STATES[String(state).toUpperCase()] ? String(state).toUpperCase() : current.state),
      noteKey(text), nowIso(), Number(id)]);
    return this.getNoteAsync(id);
  }

  removeNote(id) {
    return this.database.db.prepare('DELETE FROM user_memory_notes WHERE id = ?')
      .run(Number(id)).changes > 0;
  }

  async removeNoteAsync(id) {
    const result = await this.database.execute('DELETE FROM user_memory_notes WHERE id = ?', [Number(id)]);
    return Number(result.affectedRows) > 0;
  }

  markNotesMerged(ids, version) {
    const list = (ids ?? []).map(Number).filter(Number.isFinite);
    if (list.length === 0) {
      return 0;
    }
    const placeholders = list.map(() => '?').join(',');
    return this.database.db.prepare(`
      UPDATE user_memory_notes
      SET state = 'MERGED', merged_version = ?, updated_at = ?
      WHERE id IN (${placeholders})
    `).run(Number(version) || null, nowIso(), ...list).changes;
  }

  async markNotesMergedAsync(ids, version) {
    const list = (ids ?? []).map(Number).filter(Number.isFinite);
    if (!list.length) return 0;
    const placeholders = list.map(() => '?').join(',');
    const result = await this.database.execute(`UPDATE user_memory_notes
      SET state = 'MERGED', merged_version = ?, updated_at = ?
      WHERE id IN (${placeholders})`, [Number(version) || null, nowIso(), ...list]);
    return Number(result.affectedRows) || 0;
  }
}
