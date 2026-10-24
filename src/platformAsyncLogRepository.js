import { currentTraceId } from './trace.js';

export function nowIso() {
  return new Date().toISOString();
}

export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function asJson(value) {
  return JSON.stringify(value ?? []);
}

export function asBool(value) {
  return value === 1 || value === true;
}

// Log persistence shares the platform connection and its migration lifecycle.
export class PlatformAsyncLogRepository {
  constructor(db, platformStore = null) {
    this.db = db;
    this.platformStore = platformStore;
  }

  query(sql, bindings) {
    return this.platformStore
      ? this.platformStore.query(sql, bindings)
      : Promise.resolve(this.db.prepare(sql).all(...bindings));
  }

  async listDatasetQueryLogsAsync(limit = 100, { traceId = null } = {}) {
    const rows = await this.query(`
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
      ORDER BY l.id DESC LIMIT ?
    `, [traceId ? String(traceId) : null, traceId ? String(traceId) : null,
      Math.max(1, Math.min(Number(limit) || 100, 500))]);
    return rows.map((row) => ({ ...row, success: asBool(row.success) }));
  }

  async logDatasetQueryAsync(input) {
    if (!this.platformStore) return this.logDatasetQuery(input);
    const { userId = null, sessionId = null, traceId = currentTraceId(), datasetId,
      sqlText, rowCount = 0, latencyMs = 0, success, errorMessage = '' } = input;
    const result = await this.platformStore.execute(`INSERT INTO dataset_query_logs
      (user_id, session_id, trace_id, dataset_id, sql_text, row_count, latency_ms,
       success, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      userId ? Number(userId) : null, sessionId ? Number(sessionId) : null,
      traceId ? String(traceId) : null, Number(datasetId), String(sqlText ?? ''),
      Number(rowCount) || 0, Number(latencyMs) || 0, success ? 1 : 0,
      String(errorMessage ?? ''), nowIso(),
    ]);
    return Number(result.insertId);
  }

  async listAuditLogsAsync(limit = 100, { traceId = null } = {}) {
    const rows = await this.query(`
      SELECT a.id, a.user_id AS userId, u.display_name AS userName,
             a.theme_id AS themeId, t.name AS themeName,
             a.action, a.detail_json AS detailJson, a.trace_id AS traceId,
             a.created_at AS createdAt
      FROM audit_logs a
      LEFT JOIN app_users u ON u.id = a.user_id
      LEFT JOIN themes t ON t.id = a.theme_id
      WHERE (? IS NULL OR a.trace_id = ?)
      ORDER BY a.id DESC LIMIT ?
    `, [traceId ? String(traceId) : null, traceId ? String(traceId) : null,
      Math.max(1, Math.min(Number(limit) || 100, 500))]);
    return rows.map((row) => ({ ...row, detail: parseJson(row.detailJson, {}) }));
  }

  async addAuditLogAsync({ userId = null, themeId = null, action, detail = {},
    traceId = currentTraceId() }) {
    if (!this.platformStore) return this.addAuditLog({ userId, themeId, action, detail, traceId });
    const result = await this.platformStore.execute(`INSERT INTO audit_logs
      (user_id, theme_id, action, detail_json, trace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
      userId ? Number(userId) : null, themeId ? Number(themeId) : null,
      action, asJson(detail), traceId ? String(traceId) : null, nowIso(),
    ]);
    return Number(result.insertId);
  }

  async listLlmLogsAsync(limit = 200, { traceId = null } = {}) {
    const rows = await this.query(`
      SELECT l.id, l.user_id AS userId, u.display_name AS userName,
             l.session_id AS sessionId, l.theme_id AS themeId, t.name AS themeName,
             l.trace_id AS traceId, l.call_type AS callType, l.provider, l.model,
             l.prompt_digest AS promptDigest, l.response_digest AS responseDigest,
             l.token_usage_json AS tokenUsageJson, l.latency_ms AS latencyMs,
             l.success, l.error_message AS errorMessage, l.created_at AS createdAt
      FROM llm_call_logs l
      LEFT JOIN app_users u ON u.id = l.user_id
      LEFT JOIN themes t ON t.id = l.theme_id
      WHERE (? IS NULL OR l.trace_id = ?)
      ORDER BY l.id DESC LIMIT ?
    `, [traceId ? String(traceId) : null, traceId ? String(traceId) : null,
      Math.max(1, Math.min(Number(limit) || 200, 1000))]);
    return rows.map((row) => ({ ...row, success: asBool(row.success),
      tokenUsage: parseJson(row.tokenUsageJson, {}) }));
  }

  async logLlmCallAsync(input) {
    if (!this.platformStore) return this.logLlmCall(input);
    const { userId = null, sessionId = null, themeId = null, traceId = currentTraceId(),
      callType, provider = 'deepseek', model, promptDigest, responseDigest, tokenUsage = {},
      latencyMs = 0, success, errorMessage = '' } = input;
    const result = await this.platformStore.execute(`INSERT INTO llm_call_logs
      (user_id, session_id, theme_id, trace_id, call_type, provider, model,
       prompt_digest, response_digest, token_usage_json, latency_ms, success,
       error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      userId ? Number(userId) : null, sessionId ? Number(sessionId) : null,
      themeId ? Number(themeId) : null, traceId ? String(traceId) : null,
      String(callType), String(provider), String(model ?? ''),
      String(promptDigest ?? '').slice(0, 500), String(responseDigest ?? '').slice(0, 500),
      asJson(tokenUsage), Math.max(0, Number(latencyMs) || 0), success ? 1 : 0,
      String(errorMessage ?? ''), nowIso(),
    ]);
    return Number(result.insertId);
  }

  async llmLogStatsAsync() {
    if (!this.platformStore) return this.llmLogStats();
    const [row] = await this.platformStore.query(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successCount,
      AVG(latency_ms) AS avgLatencyMs FROM llm_call_logs`);
    return {
      total: Number(row.total ?? 0), successCount: Number(row.successCount ?? 0),
      successRate: row.total ? Math.round(Number(row.successCount) * 100 / Number(row.total)) : 0,
      avgLatencyMs: Math.round(Number(row.avgLatencyMs ?? 0)),
    };
  }

  async sumTokenUsageAsync({ userId = null, themeId = null, sinceIso = null } = {}) {
    if (!this.platformStore) return this.sumTokenUsage({ userId, themeId, sinceIso });
    const clauses = [];
    const params = [];
    if (userId != null) { clauses.push('user_id = ?'); params.push(Number(userId)); }
    if (themeId != null) { clauses.push('theme_id = ?'); params.push(Number(themeId)); }
    if (sinceIso) { clauses.push('created_at >= ?'); params.push(String(sinceIso)); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.platformStore.query(
      `SELECT token_usage_json AS tokenUsageJson FROM llm_call_logs ${where}`, params,
    );
    return rows.reduce((total, row) => {
      const usage = parseJson(row.tokenUsageJson, {});
      return total + (Number(usage.total_tokens
        ?? (Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0))) || 0);
    }, 0);
  }

}
