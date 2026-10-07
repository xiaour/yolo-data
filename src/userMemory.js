// 用户长期记忆：语义单元是“文档”，不是原子事实。
//
// 分层（对齐 Codex / WorkBuddy 的记忆设计）：
// - user_memory_documents：按「用户 × 作用域」一份 Markdown 手册，摘要段常驻模型上下文，正文按需检索。
// - user_memory_notes：追加式笔记，只增不改语义；显式“记住…”与自动提炼都先落到这里。
// - user_memory_versions：每次合并生成的版本快照，可回滚、可审计。
// 结构化字段只承担生命周期（状态、预算、版本、引用计数），不表达业务口径。
//
// 边界：记忆只承载“用户自己的表达与偏好”，不定义平台业务规则；与主题提示词、
// 平台规则或本轮用户明确指令冲突时一律以后者为准。
import crypto from 'node:crypto';

export const MEMORY_KINDS = [
  { code: 'BUSINESS_KNOWLEDGE', label: '业务知识' },
  { code: 'CALIBER', label: '口径偏好' },
  { code: 'TERM', label: '术语映射' },
  { code: 'TIME_RANGE', label: '时间习惯' },
  { code: 'PREFERENCE', label: '分析偏好' },
];

export const NOTE_SOURCES = {
  EXPLICIT: '用户要求记住',
  DISTILLED: '自动提炼',
  MANUAL: '手工录入',
};

export const NOTE_STATES = {
  PENDING: '待合并',
  MERGED: '已合并',
  ARCHIVED: '已归档',
};

const KIND_CODES = MEMORY_KINDS.map((item) => item.code);
const KIND_LABELS = new Map(MEMORY_KINDS.map((item) => [item.code, item.label]));
const KIND_SET = new Set(KIND_CODES);
const DEFAULT_KIND = 'BUSINESS_KNOWLEDGE';
const MIN_NOTE_LENGTH = 4;
const MAX_NOTE_LENGTH = 400;
const SUMMARY_BUDGET = 1200;
const CONTENT_BUDGET = 8000;
const MAX_PENDING_NOTES = 400;
const LEGACY_MIGRATION_KEY = 'userMemory.legacyMigrated';

export function memoryKindLabel(code) {
  return KIND_LABELS.get(String(code ?? '')) ?? KIND_LABELS.get(DEFAULT_KIND);
}

export function memoryScopeKey(themeId) {
  return themeId ? `theme:${Number(themeId)}` : 'global';
}

export function normalizeNoteContent(value) {
  return String(value ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[\s:：,，、;；。.!！?？]+|[\s。]+$/g, '')
    .trim();
}

function normalizeKind(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return KIND_SET.has(code) ? code : DEFAULT_KIND;
}

function clampText(value, budget) {
  const text = String(value ?? '').trim();
  return text.length <= budget ? text : `${text.slice(0, budget - 1).trimEnd()}…`;
}

function noteKey(content) {
  return crypto
    .createHash('sha256')
    .update(normalizeNoteContent(content).toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

function nowIso() {
  return new Date().toISOString();
}

export function ensureUserMemorySchema(database) {
  database.db.exec(`
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
      summary_budget INTEGER NOT NULL DEFAULT ${SUMMARY_BUDGET},
      content_budget INTEGER NOT NULL DEFAULT ${CONTENT_BUDGET},
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

    CREATE INDEX IF NOT EXISTS idx_user_memory_documents_user
      ON user_memory_documents(user_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_memory_notes_scope
      ON user_memory_notes(user_id, scope_key, state, id DESC);
    CREATE INDEX IF NOT EXISTS idx_user_memory_versions_doc
      ON user_memory_versions(document_id, version DESC);
  `);
}

function mapDocument(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    userId: row.userId,
    themeId: row.themeId,
    themeName: row.themeName ?? null,
    scopeKey: row.scopeKey,
    scopeLabel: row.scopeKey === 'global' ? '通用（全部智能体）' : (row.themeName ?? row.scopeLabel),
    summary: row.summary ?? '',
    content: row.content ?? '',
    version: row.version ?? 0,
    status: row.status,
    summaryBudget: row.summaryBudget ?? SUMMARY_BUDGET,
    contentBudget: row.contentBudget ?? CONTENT_BUDGET,
    lastConsolidatedAt: row.lastConsolidatedAt ?? null,
    injectedCount: row.injectedCount ?? 0,
    lastInjectedAt: row.lastInjectedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapNote(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    userId: row.userId,
    themeId: row.themeId,
    scopeKey: row.scopeKey,
    themeName: row.themeName ?? null,
    scopeLabel: row.scopeKey === 'global' ? '通用（全部智能体）' : (row.themeName ?? ''),
    kind: row.kind,
    kindLabel: memoryKindLabel(row.kind),
    source: row.source,
    sourceLabel: NOTE_SOURCES[row.source] ?? row.source,
    state: row.state,
    stateLabel: NOTE_STATES[row.state] ?? row.state,
    content: row.content,
    sessionId: row.sessionId,
    mergedVersion: row.mergedVersion ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const DOCUMENT_COLUMNS = `
  d.id, d.user_id AS userId, d.theme_id AS themeId, t.name AS themeName,
  d.scope_key AS scopeKey, d.scope_label AS scopeLabel, d.summary, d.content,
  d.version, d.status, d.summary_budget AS summaryBudget,
  d.content_budget AS contentBudget, d.last_consolidated_at AS lastConsolidatedAt,
  d.injected_count AS injectedCount, d.last_injected_at AS lastInjectedAt,
  d.created_at AS createdAt, d.updated_at AS updatedAt
`;

const NOTE_COLUMNS = `
  n.id, n.user_id AS userId, n.theme_id AS themeId, t.name AS themeName,
  n.scope_key AS scopeKey, n.kind, n.source, n.state, n.content,
  n.session_id AS sessionId, n.merged_version AS mergedVersion,
  n.created_at AS createdAt, n.updated_at AS updatedAt
`;

export class UserMemoryStore {
  constructor(database, {
    summaryBudget = SUMMARY_BUDGET,
    contentBudget = CONTENT_BUDGET,
    maxPendingNotes = MAX_PENDING_NOTES,
  } = {}) {
    this.database = database;
    this.summaryBudget = summaryBudget;
    this.contentBudget = contentBudget;
    this.maxPendingNotes = maxPendingNotes;
    ensureUserMemorySchema(database);
    this.migrateLegacyMemories();
  }

  // 旧的行式记忆（user_memories）按原样保留在库中，只把内容迁移成笔记，避免语义丢失。
  migrateLegacyMemories() {
    const migrated = this.database.getPlatformSetting?.(LEGACY_MIGRATION_KEY, null)?.value;
    if (migrated) {
      return 0;
    }
    // 只在旧表真实存在时迁移并落标记，避免空库提前写死标记、掩盖之后的旧数据。
    const legacyTable = this.database.db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'user_memories'",
    ).get();
    if (!legacyTable) {
      return 0;
    }
    const rows = this.database.db.prepare(`
      SELECT user_id AS userId, theme_id AS themeId, category, content, status,
             created_at AS createdAt
      FROM user_memories
    `).all();
    let count = 0;
    for (const row of rows) {
      const created = this.createNote({
        userId: row.userId,
        themeId: row.themeId,
        kind: row.category,
        content: row.content,
        source: 'MANUAL',
        state: row.status === 1 ? 'PENDING' : 'ARCHIVED',
        createdAt: row.createdAt,
      });
      if (created) {
        count += 1;
      }
    }
    this.database.savePlatformSetting?.(LEGACY_MIGRATION_KEY, true);
    return count;
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

  // 自动维护的工作清单：有待合并笔记，或正文已经长到需要压缩的作用域。
  listMaintenanceTargets({ compactThreshold = 0, limit = 100 } = {}) {
    const targets = new Map();
    const targetKey = (userId, scopeKey) => `${userId}:${scopeKey}`;
    const pendingRows = this.database.db.prepare(`
      SELECT user_id AS userId, theme_id AS themeId, scope_key AS scopeKey, COUNT(*) AS pending
      FROM user_memory_notes
      WHERE state = 'PENDING'
      GROUP BY user_id, scope_key
    `).all();
    for (const row of pendingRows) {
      targets.set(targetKey(row.userId, row.scopeKey), {
        userId: row.userId,
        themeId: row.themeId ?? null,
        scopeKey: row.scopeKey,
        pendingNotes: Number(row.pending) || 0,
        contentLength: 0,
      });
    }
    for (const document of this.listDocuments({ limit: 500 })) {
      const key = targetKey(document.userId, document.scopeKey);
      const entry = targets.get(key) ?? {
        userId: document.userId,
        themeId: document.themeId ?? null,
        scopeKey: document.scopeKey,
        pendingNotes: 0,
        contentLength: 0,
      };
      entry.contentLength = String(document.content ?? '').length;
      if (entry.contentLength > 0 || entry.pendingNotes > 0) {
        targets.set(key, entry);
      }
    }
    return [...targets.values()]
      .filter((item) => item.pendingNotes > 0
        || (compactThreshold > 0 && item.contentLength >= compactThreshold))
      .sort((left, right) => right.pendingNotes - left.pendingNotes
        || right.contentLength - left.contentLength)
      .slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
  }

  getDocument(id) {
    return mapDocument(this.database.db.prepare(`
      SELECT ${DOCUMENT_COLUMNS}
      FROM user_memory_documents d
      LEFT JOIN themes t ON t.id = d.theme_id
      WHERE d.id = ?
    `).get(Number(id)));
  }

  getDocumentByScope(userId, themeId) {
    return mapDocument(this.database.db.prepare(`
      SELECT ${DOCUMENT_COLUMNS}
      FROM user_memory_documents d
      LEFT JOIN themes t ON t.id = d.theme_id
      WHERE d.user_id = ? AND d.scope_key = ?
    `).get(Number(userId), memoryScopeKey(themeId)));
  }

  ensureDocument(userId, themeId = null) {
    const existing = this.getDocumentByScope(userId, themeId);
    if (existing) {
      return existing;
    }
    const scopeKey = memoryScopeKey(themeId);
    const timestamp = nowIso();
    this.database.db.prepare(`
      INSERT INTO user_memory_documents
        (user_id, theme_id, scope_key, scope_label, summary, content, version, status,
         summary_budget, content_budget, created_at, updated_at)
      VALUES (?, ?, ?, '', '', '', 0, 1, ?, ?, ?, ?)
      ON CONFLICT (user_id, scope_key) DO NOTHING
    `).run(
      Number(userId),
      themeId ? Number(themeId) : null,
      scopeKey,
      this.summaryBudget,
      this.contentBudget,
      timestamp,
      timestamp,
    );
    return this.getDocumentByScope(userId, themeId);
  }

  // 人工编辑与合并走同一条版本通道：正文或摘要变化就生成快照 + 版本号自增，
  // 只改状态或作用域标签时不产生版本，避免版本历史被无效条目淹没。
  updateDocument(id, { summary, content, status, scopeLabel } = {}) {
    const current = this.getDocument(id);
    if (!current) {
      return null;
    }
    const nextSummary = summary === undefined
      ? current.summary
      : clampText(summary, current.summaryBudget);
    const nextContent = content === undefined
      ? current.content
      : clampText(content, current.contentBudget);
    if (nextSummary !== current.summary || nextContent !== current.content) {
      this.saveConsolidated(id, {
        summary: nextSummary,
        content: nextContent,
        changeReason: '人工编辑',
      });
    }
    this.database.db.prepare(`
      UPDATE user_memory_documents
      SET status = ?, scope_label = ?, updated_at = ?
      WHERE id = ?
    `).run(
      status === undefined ? current.status : (Number(status) ? 1 : 0),
      scopeLabel === undefined ? current.scopeLabel : String(scopeLabel),
      nowIso(),
      Number(id),
    );
    return this.getDocument(id);
  }

  // 合并落库：写入新版本快照并整体替换正文与摘要，版本号自增。
  saveConsolidated(id, {
    summary, content, changeReason = '', noteCount = 0,
  }) {
    const current = this.getDocument(id);
    if (!current) {
      return null;
    }
    const nextVersion = Number(current.version) + 1;
    const nextSummary = clampText(summary ?? current.summary, current.summaryBudget);
    const nextContent = clampText(content ?? current.content, current.contentBudget);
    const timestamp = nowIso();
    this.database.db.prepare(`
      INSERT INTO user_memory_versions
        (document_id, version, summary, content, note_count, change_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      current.id,
      nextVersion,
      nextSummary,
      nextContent,
      Number(noteCount) || 0,
      String(changeReason ?? ''),
      timestamp,
    );
    this.database.db.prepare(`
      UPDATE user_memory_documents
      SET summary = ?, content = ?, version = ?, last_consolidated_at = ?, updated_at = ?
      WHERE id = ?
    `).run(nextSummary, nextContent, nextVersion, timestamp, timestamp, current.id);
    return this.getDocument(current.id);
  }

  listVersions(documentId, limit = 20) {
    return this.database.db.prepare(`
      SELECT id, document_id AS documentId, version, summary, content,
             note_count AS noteCount, change_reason AS changeReason, created_at AS createdAt
      FROM user_memory_versions
      WHERE document_id = ?
      ORDER BY version DESC
      LIMIT ?
    `).all(Number(documentId), Math.max(1, Math.min(Number(limit) || 20, 100)));
  }

  rollback(documentId, version) {
    const snapshot = this.database.db.prepare(`
      SELECT summary, content FROM user_memory_versions
      WHERE document_id = ? AND version = ?
    `).get(Number(documentId), Number(version));
    if (!snapshot) {
      return null;
    }
    return this.saveConsolidated(documentId, {
      summary: snapshot.summary,
      content: snapshot.content,
      changeReason: `回滚至 v${Number(version)}`,
    });
  }

  removeDocument(id) {
    const current = this.getDocument(id);
    if (!current) {
      return false;
    }
    this.database.db.prepare('DELETE FROM user_memory_notes WHERE user_id = ? AND scope_key = ?')
      .run(current.userId, current.scopeKey);
    this.database.db.prepare('DELETE FROM user_memory_versions WHERE document_id = ?')
      .run(current.id);
    this.database.db.prepare('DELETE FROM user_memory_documents WHERE id = ?').run(current.id);
    return true;
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

  getNote(id) {
    return mapNote(this.database.db.prepare(`
      SELECT ${NOTE_COLUMNS}
      FROM user_memory_notes n
      LEFT JOIN themes t ON t.id = n.theme_id
      WHERE n.id = ?
    `).get(Number(id)));
  }

  pendingNotes(userId, themeId = null, limit = MAX_PENDING_NOTES) {
    return this.listNotes({
      userId,
      themeId,
      state: 'PENDING',
      limit,
    });
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

  removeNote(id) {
    return this.database.db.prepare('DELETE FROM user_memory_notes WHERE id = ?')
      .run(Number(id)).changes > 0;
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

  markDocumentUsed(ids) {
    const list = (ids ?? []).map(Number).filter(Number.isFinite);
    if (list.length === 0) {
      return;
    }
    const placeholders = list.map(() => '?').join(',');
    this.database.db.prepare(`
      UPDATE user_memory_documents
      SET injected_count = injected_count + 1, last_injected_at = ?
      WHERE id IN (${placeholders})
    `).run(nowIso(), ...list);
  }

  // 常驻上下文的记忆块：只注入摘要段，正文走 search_user_memory 工具按需检索。
  buildContextMessage(userId, themeId = null) {
    const documents = this.listDocuments({ userId, themeId, status: 1 })
      .filter((document) => document.summary || document.content);
    if (documents.length === 0) {
      return null;
    }
    const lines = documents.map((document) => {
      const body = document.summary || clampText(document.content, document.summaryBudget);
      return `[${document.scopeLabel}]（v${document.version}）\n${body}`;
    });
    this.markDocumentUsed(documents.map((document) => document.id));
    return {
      role: 'system',
      content: [
        '用户长期记忆：以下是该用户在本平台历史协作中沉淀的业务知识与偏好，只注入摘要。',
        '用途：补全用户未明说的默认口径与术语映射，减少重复澄清。',
        '需要细节时调用 search_user_memory 工具检索完整记忆正文；不要凭摘要推测细节。',
        '当本轮默认口径、时间范围或术语取自记忆时，在口径说明里一句话注明“沿用你的历史偏好”，不要展开记忆原文。',
        '约束：与主题提示词、平台规则或本轮用户明确指令冲突时，一律以后者为准；不得据此编造数据或替代正式数据来源。',
        lines.join('\n\n'),
      ].join('\n'),
    };
  }

  // 关键词检索：命中行 + 上下文行，供 search_user_memory 工具使用。
  search(userId, themeId, query, limit = 8) {
    const keyword = String(query ?? '').trim().toLowerCase();
    const documents = this.listDocuments({ userId, themeId, status: 1 });
    const results = [];
    for (const document of documents) {
      const lines = String(document.content ?? '').split('\n');
      lines.forEach((line, index) => {
        const text = line.trim();
        if (!text) {
          return;
        }
        const score = keyword
          ? (text.toLowerCase().includes(keyword) ? 2 : 0)
            + (keyword.split(/\s+/).filter((token) => token && text.toLowerCase().includes(token)).length)
          : 0;
        if (score > 0) {
          results.push({
            documentId: document.id,
            scopeLabel: document.scopeLabel,
            version: document.version,
            location: `${document.scopeKey}#L${index + 1}`,
            excerpt: lines.slice(index, index + 3).join('\n').trim().slice(0, 400),
            score,
          });
        }
      });
      if (!keyword && document.summary) {
        results.push({
          documentId: document.id,
          scopeLabel: document.scopeLabel,
          version: document.version,
          location: `${document.scopeKey}#summary`,
          excerpt: document.summary.slice(0, 400),
          score: 1,
        });
      }
    }
    return results
      .sort((left, right) => right.score - left.score || right.version - left.version)
      .slice(0, Math.max(1, Math.min(Number(limit) || 8, 30)));
  }

  stats(userId) {
    const documents = this.listDocuments({ userId, limit: 200 });
    const notes = this.listNotes({ userId, limit: 500 });
    return {
      documents: documents.length,
      documentsWithContent: documents.filter((document) => document.content.trim()).length,
      notes: notes.length,
      pendingNotes: notes.filter((note) => note.state === 'PENDING').length,
      archivedNotes: notes.filter((note) => note.state === 'ARCHIVED').length,
      lastUpdatedAt: [...documents, ...notes]
        .reduce((latest, item) => (item.updatedAt > latest ? item.updatedAt : latest), '') || null,
    };
  }
}
