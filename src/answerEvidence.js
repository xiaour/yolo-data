const DATA_ANALYSIS_MODES = new Set(['METRIC_QUERY', 'TREND', 'ATTRIBUTION']);

const ARTIFACT_OPERATION_REASONS = new Set([
  'result_operation',
  'explicit_reference',
  'result_reference',
]);

export const UNGROUNDED_ANSWER_MESSAGE = [
  '本轮没有形成可验证的数据查询结果。',
  '为避免给出未经数据验证的数字，我不会基于推测作答。',
  '请确认查询范围、时间或口径后重试。',
].join('');

const DATA_UNIT_PATTERN = /(?:\d[\d,.]*\s*(?:万元|亿元|千元|百元|元|%|％|个|件|单|笔|行|人|次|吨|箱))/;
const NUMERIC_TOKEN_PATTERN = /(?<![\d])(?:[+-]?\d{1,3}(?:,\d{3})+|\d+\.\d+|\d{4,})(?!\s*(?:年|月|日|季度|号))/;
const MARKDOWN_TABLE_PATTERN = /(?:^|\n)\s*\|[^\n]*\|[^\n]*\n\s*\|?\s*:?-{2,}/;
const DATA_CONCLUSION_PATTERN = /(?:增长|下降|上升|减少|增加|贡献|拉动|拖累|同比|环比)[^。；\n]{0,32}[+\-−]?\d/;

// 证据守卫只拦截“看起来在报数或下数据结论”的回答。澄清、能力缺口和配置错误
// 本来就没有结果集，不能因为缺少 evidence 而被统一改写成同一条兜底文案。
export function looksLikeDataClaim(message) {
  const text = String(message ?? '').trim();
  if (!text) {
    return false;
  }
  return DATA_UNIT_PATTERN.test(text)
    || NUMERIC_TOKEN_PATTERN.test(text)
    || MARKDOWN_TABLE_PATTERN.test(text)
    || DATA_CONCLUSION_PATTERN.test(text);
}

export function buildAnswerEvidence({
  semanticParse = null,
  data = null,
  queryFingerprint = null,
  dataHash = null,
  executionCount = 0,
} = {}) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const rowCount = rows.length;
  const contract = semanticParse?.queryContract ?? null;
  const resultQuality = semanticParse?.resultQuality ?? null;
  return {
    // An audited empty result is still grounded. Treating zero rows as
    // ungrounded causes valid "no matching data" answers to be replaced by a
    // clarification and may trigger pointless retries.
    grounded: Boolean(contract && queryFingerprint && dataHash),
    contractId: semanticParse?.planId ?? null,
    planId: semanticParse?.planId ?? null,
    queryFingerprint: queryFingerprint ?? semanticParse?.queryFingerprint ?? null,
    dataHash: dataHash ?? semanticParse?.dataHash ?? null,
    rowCount,
    columnCount: Array.isArray(data?.columns) ? data.columns.length : 0,
    executionCount: Number(executionCount) || 0,
    truncated: Boolean(resultQuality?.truncated),
    limit: resultQuality?.limit ?? contract?.limit ?? null,
  };
}

export function requiresGroundedAnswer({
  analysisMode = null,
  contextReason = null,
  hasClarification = false,
} = {}) {
  if (hasClarification || ARTIFACT_OPERATION_REASONS.has(String(contextReason ?? ''))) {
    return false;
  }
  return DATA_ANALYSIS_MODES.has(String(analysisMode?.mode ?? 'METRIC_QUERY'));
}
