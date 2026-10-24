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
import { UserMemoryRepository } from './userMemoryRepository.js';
import {
  SUMMARY_BUDGET, CONTENT_BUDGET, MAX_PENDING_NOTES, LEGACY_MIGRATION_KEY,
  memoryScopeKey, clampText, nowIso,
} from './userMemoryModel.js';
export {
  MEMORY_KINDS, NOTE_SOURCES, NOTE_STATES, memoryKindLabel, memoryScopeKey, normalizeNoteContent,
} from './userMemoryModel.js';

export class UserMemoryStore {
  constructor(database, {
    summaryBudget = SUMMARY_BUDGET,
    contentBudget = CONTENT_BUDGET,
    maxPendingNotes = MAX_PENDING_NOTES,
  } = {}) {
    this.database = database;
    this.repository = new UserMemoryRepository(database);
    this.summaryBudget = summaryBudget;
    this.contentBudget = contentBudget;
    this.maxPendingNotes = maxPendingNotes;
    this.migrateLegacyMemories();
  }

  // 旧的行式记忆（user_memories）按原样保留在库中，只把内容迁移成笔记，避免语义丢失。
  migrateLegacyMemories() {
    // Legacy row memories are a SQLite-era compatibility table. MySQL uses
    // the async schema and must not touch the synchronous driver during boot.
    if (!this.database?.db?.prepare) {
      return 0;
    }
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

  listDocuments(options = {}) {
    return this.repository.listDocuments(options);
  }

  async listDocumentsAsync(options = {}) {
    return this.repository.listDocumentsAsync(options);
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

  async listMaintenanceTargetsAsync({ compactThreshold = 0, limit = 100 } = {}) {
    const targets = new Map();
    const targetKey = (userId, scopeKey) => `${userId}:${scopeKey}`;
    const pendingRows = await this.database.query(`
      SELECT user_id AS userId, theme_id AS themeId, scope_key AS scopeKey, COUNT(*) AS pending
      FROM user_memory_notes WHERE state = 'PENDING'
      GROUP BY user_id, scope_key
    `);
    for (const row of pendingRows) {
      targets.set(targetKey(row.userId, row.scopeKey), {
        userId: row.userId, themeId: row.themeId ?? null, scopeKey: row.scopeKey,
        pendingNotes: Number(row.pending) || 0, contentLength: 0,
      });
    }
    for (const document of await this.listDocumentsAsync({ limit: 500 })) {
      const key = targetKey(document.userId, document.scopeKey);
      const entry = targets.get(key) ?? {
        userId: document.userId, themeId: document.themeId ?? null,
        scopeKey: document.scopeKey, pendingNotes: 0, contentLength: 0,
      };
      entry.contentLength = String(document.content ?? '').length;
      if (entry.contentLength > 0 || entry.pendingNotes > 0) targets.set(key, entry);
    }
    return [...targets.values()]
      .filter((item) => item.pendingNotes > 0 || (compactThreshold > 0 && item.contentLength >= compactThreshold))
      .sort((left, right) => right.pendingNotes - left.pendingNotes || right.contentLength - left.contentLength)
      .slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
  }

  getDocument(id) {
    return this.repository.getDocument(id);
  }

  async getDocumentAsync(id) {
    return this.repository.getDocumentAsync(id);
  }

  getDocumentByScope(userId, themeId) {
    return this.repository.getDocumentByScope(userId, themeId);
  }

  async getDocumentByScopeAsync(userId, themeId) {
    return this.repository.getDocumentByScopeAsync(userId, themeId);
  }

  async ensureDocumentAsync(userId, themeId = null) {
    const existing = await this.getDocumentByScopeAsync(userId, themeId);
    if (existing) return existing;
    const timestamp = nowIso();
    const values = [Number(userId), themeId ? Number(themeId) : null, memoryScopeKey(themeId),
      this.summaryBudget, this.contentBudget, timestamp, timestamp];
    await this.database.transaction(async (tx) => {
      const [current] = await tx.query(
        'SELECT id FROM user_memory_documents WHERE user_id = ? AND scope_key = ?',
        [Number(userId), memoryScopeKey(themeId)],
      );
      if (!current) {
        await tx.execute(`INSERT INTO user_memory_documents
          (user_id, theme_id, scope_key, scope_label, summary, content, version, status,
           summary_budget, content_budget, created_at, updated_at)
          VALUES (?, ?, ?, '', '', '', 0, 1, ?, ?, ?, ?)`, values);
      }
    });
    return this.getDocumentByScopeAsync(userId, themeId);
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

  async updateDocumentAsync(id, { summary, content, status, scopeLabel } = {}) {
    const current = await this.getDocumentAsync(id);
    if (!current) return null;
    const nextSummary = summary === undefined ? current.summary : clampText(summary, current.summaryBudget);
    const nextContent = content === undefined ? current.content : clampText(content, current.contentBudget);
    if (nextSummary !== current.summary || nextContent !== current.content) {
      await this.saveConsolidatedAsync(id, {
        summary: nextSummary, content: nextContent, changeReason: '人工编辑',
      });
    }
    await this.database.execute(`UPDATE user_memory_documents
      SET status = ?, scope_label = ?, updated_at = ? WHERE id = ?`, [
      status === undefined ? current.status : (Number(status) ? 1 : 0),
      scopeLabel === undefined ? current.scopeLabel : String(scopeLabel), nowIso(), Number(id),
    ]);
    return this.getDocumentAsync(id);
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

  async saveConsolidatedAsync(id, {
    summary, content, changeReason = '', noteCount = 0,
  }) {
    const current = await this.getDocumentAsync(id);
    if (!current) return null;
    const nextVersion = Number(current.version) + 1;
    const nextSummary = clampText(summary ?? current.summary, current.summaryBudget);
    const nextContent = clampText(content ?? current.content, current.contentBudget);
    const timestamp = nowIso();
    await this.database.transaction(async (tx) => {
      await tx.execute(`INSERT INTO user_memory_versions
        (document_id, version, summary, content, note_count, change_reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [current.id, nextVersion, nextSummary, nextContent,
        Number(noteCount) || 0, String(changeReason ?? ''), timestamp]);
      await tx.execute(`UPDATE user_memory_documents
        SET summary = ?, content = ?, version = ?, last_consolidated_at = ?, updated_at = ?
        WHERE id = ?`, [nextSummary, nextContent, nextVersion, timestamp, timestamp, current.id]);
    });
    return this.getDocumentAsync(current.id);
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

  async listVersionsAsync(documentId, limit = 20) {
    return this.database.query(`
      SELECT id, document_id AS documentId, version, summary, content,
             note_count AS noteCount, change_reason AS changeReason, created_at AS createdAt
      FROM user_memory_versions
      WHERE document_id = ?
      ORDER BY version DESC
      LIMIT ?
    `, [Number(documentId), Math.max(1, Math.min(Number(limit) || 20, 100))]);
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

  async rollbackAsync(documentId, version) {
    const [snapshot] = await this.database.query(
      'SELECT summary, content FROM user_memory_versions WHERE document_id = ? AND version = ?',
      [Number(documentId), Number(version)],
    );
    if (!snapshot) return null;
    return this.saveConsolidatedAsync(documentId, {
      summary: snapshot.summary, content: snapshot.content, changeReason: `回滚至 v${Number(version)}`,
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

  async removeDocumentAsync(id) {
    const current = await this.getDocumentAsync(id);
    if (!current) return false;
    return this.database.transaction(async (tx) => {
      await tx.execute('DELETE FROM user_memory_notes WHERE user_id = ? AND scope_key = ?', [current.userId, current.scopeKey]);
      await tx.execute('DELETE FROM user_memory_versions WHERE document_id = ?', [current.id]);
      const result = await tx.execute('DELETE FROM user_memory_documents WHERE id = ?', [current.id]);
      return Number(result.affectedRows) > 0;
    });
  }

  listNotes(options = {}) {
    return this.repository.listNotes(options);
  }

  async listNotesAsync(options = {}) {
    return this.repository.listNotesAsync(options);
  }

  getNote(id) {
    return this.repository.getNote(id);
  }

  async getNoteAsync(id) {
    return this.repository.getNoteAsync(id);
  }

  pendingNotes(userId, themeId = null, limit = MAX_PENDING_NOTES) {
    return this.repository.pendingNotes(userId, themeId, limit);
  }

  async pendingNotesAsync(userId, themeId = null, limit = MAX_PENDING_NOTES) {
    return this.repository.pendingNotesAsync(userId, themeId, limit);
  }
  createNote(input) {
    return this.repository.createNote(input);
  }

  async createNoteAsync(input) {
    return this.repository.createNoteAsync(input);
  }

  updateNote(id, changes = {}) {
    return this.repository.updateNote(id, changes);
  }

  async updateNoteAsync(id, changes = {}) {
    return this.repository.updateNoteAsync(id, changes);
  }

  removeNote(id) {
    return this.repository.removeNote(id);
  }

  async removeNoteAsync(id) {
    return this.repository.removeNoteAsync(id);
  }

  markNotesMerged(ids, version) {
    return this.repository.markNotesMerged(ids, version);
  }

  async markNotesMergedAsync(ids, version) {
    return this.repository.markNotesMergedAsync(ids, version);
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
    const retrievalText = lines.join('\n\n');
    this.markDocumentUsed(documents.map((document) => document.id));
    return {
      role: 'system',
      // Slot extraction must only see the memory body. Keeping the instruction
      // block separate prevents platform guidance from being parsed as a user
      // business condition.
      retrievalText,
      content: [
      '用户长期记忆：以下是该用户在本平台历史协作中沉淀的业务知识与偏好，只注入摘要。',
      '用途：补全用户未明说的默认口径与术语映射，减少重复澄清。',
      '与本轮问题直接相关的记忆细节已在本轮问数前前置注入；仍可用 search_user_memory 工具按需检索完整记忆正文。',
        '当本轮默认口径、时间范围或术语取自记忆时，在口径说明里一句话注明“沿用你的历史偏好”，不要展开记忆原文。',
        '约束：与主题提示词、平台规则或本轮用户明确指令冲突时，一律以后者为准；不得据此编造数据或替代正式数据来源。',
        retrievalText,
      ].join('\n'),
    };
  }

  async buildContextMessageAsync(userId, themeId = null) {
    const documents = (await this.listDocumentsAsync({ userId, themeId, status: 1, limit: 200 }))
      .filter((document) => document.summary || document.content);
    if (documents.length === 0) return null;
    const lines = documents.map((document) => {
      const body = document.summary || clampText(document.content, document.summaryBudget);
      return `[${document.scopeLabel}]（v${document.version}）\n${body}`;
    });
    const retrievalText = lines.join('\n\n');
    await this.markDocumentUsedAsync(documents.map((document) => document.id));
    return {
      role: 'system',
      retrievalText,
      content: [
        '用户长期记忆：以下是该用户在本平台历史协作中沉淀的业务知识与偏好，只注入摘要。',
        '用途：补全用户未明说的默认口径与术语映射，减少重复澄清。',
        '与本轮问题直接相关的记忆细节已在本轮问数前前置注入；仍可用 search_user_memory 工具按需检索完整记忆正文。',
        '当本轮默认口径、时间范围或术语取自记忆时，在口径说明里一句话注明“沿用你的历史偏好”，不要展开记忆原文。',
        '约束：与主题提示词、平台规则或本轮用户明确指令冲突时，一律以后者为准；不得据此编造数据或替代正式数据来源。',
        retrievalText,
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

  async searchAsync(userId, themeId, query, limit = 8) {
    const keyword = String(query ?? '').trim().toLowerCase();
    const documents = (await this.listDocumentsAsync({ userId, themeId, status: 1, limit: 500 }))
      .filter((document) => document.summary || document.content);
    const results = [];
    for (const document of documents) {
      const lines = String(document.content ?? '').split('\n');
      lines.forEach((line, index) => {
        const text = line.trim();
        if (!text) return;
        const score = keyword
          ? (text.toLowerCase().includes(keyword) ? 2 : 0)
            + keyword.split(/\s+/).filter((token) => token && text.toLowerCase().includes(token)).length
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

  async markDocumentUsedAsync(ids) {
    const list = (ids ?? []).map(Number).filter(Number.isFinite);
    if (!list.length) return;
    const placeholders = list.map(() => '?').join(',');
    await this.database.execute(`UPDATE user_memory_documents
      SET injected_count = injected_count + 1, last_injected_at = ?
      WHERE id IN (${placeholders})`, [nowIso(), ...list]);
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

  async statsAsync(userId) {
    const [row] = await this.database.query(`
      SELECT
        COUNT(*) AS notes,
        SUM(CASE WHEN state = 'PENDING' THEN 1 ELSE 0 END) AS pendingNotes
      FROM user_memory_notes WHERE user_id = ?
    `, [Number(userId)]);
    const [documentStats] = await this.database.query(`
      SELECT COUNT(*) AS documents,
        SUM(CASE WHEN TRIM(content) <> '' THEN 1 ELSE 0 END) AS documentsWithContent
      FROM user_memory_documents WHERE user_id = ?
    `, [Number(userId)]);
    return {
      documents: Number(documentStats?.documents ?? 0),
      documentsWithContent: Number(documentStats?.documentsWithContent ?? 0),
      notes: Number(row?.notes ?? 0),
      pendingNotes: Number(row?.pendingNotes ?? 0),
    };
  }
}
