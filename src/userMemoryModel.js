// Shared memory domain values and row mapping. No persistence dependencies.
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
export const KIND_SET = new Set(KIND_CODES);
const DEFAULT_KIND = 'BUSINESS_KNOWLEDGE';
export const MIN_NOTE_LENGTH = 4;
export const MAX_NOTE_LENGTH = 400;
export const SUMMARY_BUDGET = 1200;
export const CONTENT_BUDGET = 8000;
export const MAX_PENDING_NOTES = 400;
export const LEGACY_MIGRATION_KEY = 'userMemory.legacyMigrated';

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

export function normalizeKind(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return KIND_SET.has(code) ? code : DEFAULT_KIND;
}

export function clampText(value, budget) {
  const text = String(value ?? '').trim();
  return text.length <= budget ? text : `${text.slice(0, budget - 1).trimEnd()}…`;
}

export function noteKey(content) {
  return crypto
    .createHash('sha256')
    .update(normalizeNoteContent(content).toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

export function nowIso() {
  return new Date().toISOString();
}

export function mapDocument(row) {
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

export function mapNote(row) {
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

export const DOCUMENT_COLUMNS = `
  d.id, d.user_id AS userId, d.theme_id AS themeId, t.name AS themeName,
  d.scope_key AS scopeKey, d.scope_label AS scopeLabel, d.summary, d.content,
  d.version, d.status, d.summary_budget AS summaryBudget,
  d.content_budget AS contentBudget, d.last_consolidated_at AS lastConsolidatedAt,
  d.injected_count AS injectedCount, d.last_injected_at AS lastInjectedAt,
  d.created_at AS createdAt, d.updated_at AS updatedAt
`;

export const NOTE_COLUMNS = `
  n.id, n.user_id AS userId, n.theme_id AS themeId, t.name AS themeName,
  n.scope_key AS scopeKey, n.kind, n.source, n.state, n.content,
  n.session_id AS sessionId, n.merged_version AS mergedVersion,
  n.created_at AS createdAt, n.updated_at AS updatedAt
`;
