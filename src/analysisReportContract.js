const MAX_FINDINGS = 20;
const MAX_OPPORTUNITIES = 12;
const FINDING_STATUSES = new Set(['SUPPORTED', 'CONDITIONAL', 'CONTRADICTED', 'NOT_TESTED']);
const OPPORTUNITY_STATUSES = new Set(['SUPPORTED', 'HYPOTHESIS']);
const CONFIDENCE_LEVELS = new Set(['HIGH', 'MEDIUM', 'LOW']);

function text(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function evidenceRefs(value) {
  return (Array.isArray(value) ? value : []).map((item) => text(item, 160)).filter(Boolean);
}

function finding(item, index) {
  const source = item && typeof item === 'object' ? item : {};
  const status = text(source.status, 32).toUpperCase();
  const confidence = text(source.confidence, 16).toUpperCase();
  return {
    id: text(source.id ?? `finding-${index + 1}`, 80),
    title: text(source.title, 160),
    statement: text(source.statement, 1200),
    evidenceRefs: evidenceRefs(source.evidenceRefs),
    status: FINDING_STATUSES.has(status) ? status : 'NOT_TESTED',
    confidence: CONFIDENCE_LEVELS.has(confidence) ? confidence : 'LOW',
  };
}

function opportunity(item, index) {
  const source = item && typeof item === 'object' ? item : {};
  const status = text(source.status, 32).toUpperCase();
  const confidence = text(source.confidence, 16).toUpperCase();
  return {
    id: text(source.id ?? `opportunity-${index + 1}`, 80),
    title: text(source.title, 160), rationale: text(source.rationale, 1200),
    action: text(source.action, 800), expectedImpact: text(source.expectedImpact, 400),
    evidenceRefs: evidenceRefs(source.evidenceRefs),
    status: OPPORTUNITY_STATUSES.has(status) ? status : 'HYPOTHESIS',
    confidence: CONFIDENCE_LEVELS.has(confidence) ? confidence : 'LOW',
  };
}

export function normalizeAnalysisReport(source) {
  return {
    executiveSummary: text(source.executiveSummary, 1600),
    findings: (Array.isArray(source.findings) ? source.findings : [])
      .slice(0, MAX_FINDINGS).map(finding),
    opportunities: (Array.isArray(source.opportunities) ? source.opportunities : [])
      .slice(0, MAX_OPPORTUNITIES).map(opportunity),
    limitations: (Array.isArray(source.limitations) ? source.limitations : [])
      .map((item) => text(item, 600)).filter(Boolean),
  };
}

function issue(code, message, extra = {}) {
  return { code, level: 'error', message, ...extra };
}

export function validateAnalysisReport(result, { requireReport = false } = {}) {
  const issues = [];
  if (requireReport && !result.executiveSummary) {
    issues.push(issue('ANALYSIS-REPORT-SUMMARY', '分析报告缺少 executiveSummary。'));
  }
  if (requireReport && result.findings.length === 0) {
    issues.push(issue('ANALYSIS-REPORT-FINDINGS', '分析报告至少需要一条带证据引用的 finding。'));
  }
  const keys = new Set(['totals', 'totals.base', 'totals.current', 'totals.delta']);
  const rowKeys = new Set();
  for (const row of result.rows) {
    if (rowKeys.has(row.key)) {
      issues.push(issue('ANALYSIS-ROW-KEY-DUPLICATE', `分析结果存在重复 row key：${row.key}。`));
    }
    rowKeys.add(row.key);
    keys.add(row.key);
    keys.add(`row:${row.key}`);
  }
  const checkRefs = (item, kind) => {
    const unknown = item.evidenceRefs.filter((ref) => !keys.has(ref));
    if (unknown.length > 0) {
      issues.push(issue('ANALYSIS-EVIDENCE-REF',
        `${kind}「${item.title || item.id}」引用了不存在的证据：${unknown.join('、')}。`,
        { id: item.id, refs: unknown }));
    }
  };
  for (const item of result.findings) {
    checkRefs(item, '发现');
    if (['SUPPORTED', 'CONDITIONAL', 'CONTRADICTED'].includes(item.status)
        && item.evidenceRefs.length === 0) {
      issues.push(issue('ANALYSIS-FINDING-EVIDENCE',
        `发现「${item.title || item.id}」标记为 ${item.status}，但没有 evidenceRefs。`));
    }
  }
  for (const item of result.opportunities) {
    checkRefs(item, '机会');
    if (item.status === 'SUPPORTED' && item.evidenceRefs.length === 0) {
      issues.push(issue('ANALYSIS-OPPORTUNITY-EVIDENCE',
        `机会「${item.title || item.id}」标记为 SUPPORTED，必须引用证据；证据不足时应标记为 HYPOTHESIS。`));
    }
  }
  return issues;
}

export function analysisReportPromptShape() {
  return {
    executiveSummary: '面向业务用户的一段结论摘要，只能概括下方已引用证据的发现',
    findings: [{ id: 'finding-1', title: '发现标题', statement: '可验证的结论',
      evidenceRefs: ['totals.delta', 'row:分组键'],
      status: 'SUPPORTED|CONDITIONAL|CONTRADICTED|NOT_TESTED', confidence: 'HIGH|MEDIUM|LOW' }],
    opportunities: [{ id: 'opportunity-1', title: '机会标题', rationale: '机会依据或待验证逻辑',
      action: '下一步验证或行动', expectedImpact: '可选：预期影响，不得虚构数值',
      evidenceRefs: ['row:分组键'], status: 'SUPPORTED|HYPOTHESIS', confidence: 'HIGH|MEDIUM|LOW' }],
    limitations: ['数据范围、口径、样本或因果解释限制'],
  };
}

export const ANALYSIS_REPORT_PROMPT_RULES = [
  '- findings 中 SUPPORTED / CONDITIONAL / CONTRADICTED 的结论必须通过 evidenceRefs 引用 totals、totals.delta 或 row:<key>。',
  '- opportunities 中证据充分的项可标记 SUPPORTED；证据不足但值得验证的项必须标记 HYPOTHESIS，不得伪装成事实。',
  '- 相关性、同期变化和分组差异不能自动证明因果；未做因果检验时必须在 limitations 中说明。',
];

export function summarizeAnalysisReport(result, { topN = 8 } = {}) {
  const value = result?.normalized ?? result;
  const status = { SUPPORTED: '数据支持', CONDITIONAL: '条件成立', CONTRADICTED: '证据矛盾',
    NOT_TESTED: '尚未验证', HYPOTHESIS: '待验证假设' };
  const confidence = { HIGH: '高', MEDIUM: '中', LOW: '低' };
  const sections = value.executiveSummary ? [`## 分析结论\n${value.executiveSummary}`] : [];
  if (value.findings?.length) {
    sections.push(`## 关键发现\n${value.findings.slice(0, topN).map((item) =>
      `- **${item.title || item.id}**：${item.statement} （${status[item.status] ?? item.status}，置信度${confidence[item.confidence] ?? item.confidence}）`).join('\n')}`);
  }
  if (value.opportunities?.length) {
    sections.push(`## 机会与行动\n${value.opportunities.slice(0, topN).map((item) =>
      `- **${item.title || item.id}**（${status[item.status] ?? item.status}，置信度${confidence[item.confidence] ?? item.confidence}）：${item.rationale}；下一步：${item.action}${item.expectedImpact ? `；预期影响：${item.expectedImpact}` : ''}`).join('\n')}`);
  }
  if (value.limitations?.length) {
    sections.push(`## 限制\n${value.limitations.map((item) => `- ${item}`).join('\n')}`);
  }
  return sections.join('\n\n');
}
