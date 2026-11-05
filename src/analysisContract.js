import { ANALYSIS_REPORT_PROMPT_RULES, analysisReportPromptShape,
  normalizeAnalysisReport, summarizeAnalysisReport,
  validateAnalysisReport } from './analysisReportContract.js';
// 沙箱分析的通用数值契约。报告字段与证据校验位于 analysisReportContract.js。
export const ANALYSIS_CONTRACT_VERSION = 2;

export const ANALYSIS_RESULT_FILE = 'analysis.json';

export const ANALYSIS_TOLERANCE = 1e-6;

export const MAX_ANALYSIS_ROWS = 200;
export const MAX_LABEL_LENGTH = 120;

// 平台可验证的断言登记表。断言是"数学恒等式"，不是业务规则：
// 平台不判断该用什么方法，只判断模型声称成立的等式是否真的成立。
export const ANALYSIS_CLAIMS = [
  {
    code: 'ADDITIVE',
    label: '可加性',
    description: '各行指定字段之和，必须精确等于总计中指定字段的值（默认 Σcontribution = totals.delta）。',
    fields: { row: 'contribution', total: 'delta' },
  },
  {
    code: 'SHARE_SUM',
    label: '份额归一',
    description: '各行 share 之和必须等于 scale（默认 1）。',
    fields: { row: 'share', scale: 1 },
  },
  {
    code: 'DELTA_CONSISTENT',
    label: '变化量自洽',
    description: '每行 delta 必须等于 current - base。',
    fields: {},
  },
];

const CLAIM_BY_CODE = new Map(ANALYSIS_CLAIMS.map((claim) => [claim.code, claim]));

function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toText(value, maxLength = MAX_LABEL_LENGTH) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function issue(code, level, message, extra = {}) {
  return { code, level, message: String(message), ...extra };
}

// 归一化：把任意来源（沙箱 JSON、持久化产物）收敛成 canonical 形状。
// 只做清洗与裁剪，**不计算任何业务结论**。
export function normalizeAnalysisResult(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const rows = (Array.isArray(source.rows) ? source.rows : [])
    .slice(0, MAX_ANALYSIS_ROWS)
    .map((row, index) => {
      const item = row && typeof row === 'object' ? row : {};
      return {
        key: toText(item.key ?? item.name ?? index),
        label: toText(item.label ?? item.key ?? item.name ?? index),
        base: toNumber(item.base),
        current: toNumber(item.current),
        delta: toNumber(item.delta),
        changeRate: toNumber(item.changeRate),
        contribution: toNumber(item.contribution),
        share: toNumber(item.share),
        rank: toNumber(item.rank),
        segment: toText(item.segment, 60) || null,
        direction: toText(item.direction, 24) || null,
        note: toText(item.note, 400),
      };
    });
  const totals = source.totals && typeof source.totals === 'object' ? source.totals : {};
  return {
    version: ANALYSIS_CONTRACT_VERSION,
    kind: toText(source.kind, 60) || 'UNSPECIFIED',
    metric: source.metric && typeof source.metric === 'object'
      ? {
        label: toText(source.metric.label, 60),
        unit: toText(source.metric.unit, 24),
        isRate: source.metric.isRate === true,
      }
      : null,
    periods: source.periods && typeof source.periods === 'object'
      ? {
        current: toText(source.periods.current, 60) || null,
        previous: toText(source.periods.previous, 60) || null,
      }
      : null,
    totals: {
      base: toNumber(totals.base),
      current: toNumber(totals.current),
      delta: toNumber(totals.delta),
    },
    rows,
    claims: (Array.isArray(source.claims) ? source.claims : [])
      .map((claim) => (claim && typeof claim === 'object'
        ? {
          code: toText(claim.code ?? claim, 40).toUpperCase(),
          row: toText(claim.row, 40) || null,
          total: toText(claim.total, 40) || null,
          scale: toNumber(claim.scale) ?? 1,
        }
        : { code: toText(claim, 40).toUpperCase(), row: null, total: null, scale: 1 }))
      .filter((claim) => claim.code),
    ...normalizeAnalysisReport(source),
    notes: (Array.isArray(source.notes) ? source.notes : []).map((note) => toText(note, 400)).filter(Boolean),
  };
}

function checkClaim(result, claim, tolerance) {
  const definition = CLAIM_BY_CODE.get(claim.code);
  if (!definition) {
    return issue('ANALYSIS-UNKNOWN-CLAIM', 'warning', `未登记的断言：${claim.code}，平台无法验证。`, {
      claim: claim.code,
      supported: ANALYSIS_CLAIMS.map((item) => item.code),
    });
  }
  if (claim.code === 'DELTA_CONSISTENT') {
    const inconsistent = result.rows.filter((row) => (
      row.delta !== null
      && row.base !== null
      && row.current !== null
      && Math.abs(row.delta - (row.current - row.base)) > tolerance
    ));
    return inconsistent.length === 0
      ? null
      : issue('ANALYSIS-DELTA-CONSISTENT', 'error',
        `${inconsistent.length} 行的 delta 不等于 current - base（例如 ${inconsistent[0].label}）。`, {
          samples: inconsistent.slice(0, 3).map((row) => row.label),
        });
  }
  if (claim.code === 'SHARE_SUM') {
    const scale = Number(claim.scale) || 1;
    const usable = result.rows.filter((row) => row.share !== null);
    if (usable.length === 0) {
      return issue('ANALYSIS-SHARE-MISSING', 'error', '声明了份额归一，但没有任何行提供 share。');
    }
    const sum = usable.reduce((total, row) => total + row.share, 0);
    return Math.abs(sum - scale) <= tolerance
      ? null
      : issue('ANALYSIS-SHARE-SUM', 'error', `各行 share 之和为 ${sum}，不等于 ${scale}。`, { sum, scale });
  }
  if (claim.code === 'ADDITIVE') {
    const rowField = claim.row || definition.fields.row;
    const totalField = claim.total || definition.fields.total;
    const usable = result.rows.filter((row) => toNumber(row?.[rowField]) !== null);
    if (usable.length === 0) {
      return issue('ANALYSIS-ADDITIVE-MISSING', 'error', `声明了可加性，但没有任何行提供 ${rowField}。`);
    }
    const total = toNumber(result.totals?.[totalField]);
    if (total === null) {
      return issue('ANALYSIS-ADDITIVE-MISSING', 'error', `声明了可加性，但 totals.${totalField} 缺失。`);
    }
    const sum = usable.reduce((accumulated, row) => accumulated + row[rowField], 0);
    return Math.abs(sum - total) <= tolerance
      ? null
      : issue('ANALYSIS-ADDITIVITY', 'error',
        `Σ${rowField} = ${sum}，与 totals.${totalField} = ${total} 不一致（差 ${sum - total}）。`, {
          sum, total, residual: sum - total,
        });
  }
  return null;
}

// 确定性校验。返回 { valid, issues, claims, normalized }。
// valid=false 表示必须修正后重跑；warning 不阻断，但会进入证据。
const NUMERIC_ROW_FIELDS = [
  'base', 'current', 'delta', 'changeRate', 'contribution', 'share', 'rank',
];

// 扫描原始输入里的非有限数值（Infinity / NaN / 1e999 等）。
// 归一化会把它们收敛成 null，因此必须在归一化之前检查，否则这条规则永远不触发。
function hasNonFiniteNumbers(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  if (rows.some((row) => (
    row && typeof row === 'object'
    && NUMERIC_ROW_FIELDS.some((field) => {
      const raw = row?.[field];
      if (raw === null || raw === undefined || raw === '') {
        return false;
      }
      return !Number.isFinite(Number(raw));
    })
  ))) {
    return true;
  }
  const totals = payload?.totals && typeof payload.totals === 'object' ? payload.totals : {};
  return ['base', 'current', 'delta'].some((field) => {
    const raw = totals?.[field];
    return raw !== null && raw !== undefined && raw !== '' && !Number.isFinite(Number(raw));
  });
}

export function validateAnalysisResult(payload, {
  tolerance = ANALYSIS_TOLERANCE,
  requireReport = false,
} = {}) {
  const result = normalizeAnalysisResult(payload);
  const issues = [];

  if (result.kind === 'UNSPECIFIED') {
    issues.push(issue('ANALYSIS-KIND-MISSING', 'warning', '结果未声明 kind，展示与检索将缺少分类依据。'));
  }
  if (result.rows.length === 0) {
    issues.push(issue('ANALYSIS-EMPTY', 'error', '结果没有任何行，无法构成可交付的分析结论。'));
  }
  const totals = result.totals;
  if (totals.base !== null && totals.current !== null && totals.delta !== null
      && Math.abs(totals.delta - (totals.current - totals.base)) > tolerance) {
    issues.push(issue('ANALYSIS-TOTALS', 'error',
      `totals.delta（${totals.delta}）不等于 current - base（${totals.current - totals.base}）。`));
  }
  if (result.rows.some((row) => !row.key && !row.label)) {
    issues.push(issue('ANALYSIS-ROW-KEY', 'error', '存在缺少 key/label 的行。'));
  }
  if (hasNonFiniteNumbers(payload)) {
    issues.push(issue('ANALYSIS-NON-FINITE', 'error', '存在 NaN / Infinity 数值，分析结果不可用。'));
  }

  const claimResults = [];
  for (const claim of result.claims) {
    const claimIssue = checkClaim(result, claim, tolerance);
    if (claimIssue) {
      issues.push(claimIssue);
      claimResults.push({ code: claim.code, verified: false, issue: claimIssue.code });
    } else {
      claimResults.push({ code: claim.code, verified: true, issue: null });
    }
  }
  issues.push(...validateAnalysisReport(result, { requireReport }));

  const errors = issues.filter((item) => item.level === 'error');
  return {
    valid: errors.length === 0 && result.rows.length > 0,
    issues,
    claims: claimResults,
    normalized: result,
  };
}

// 供注入模型提示词：告诉模型"代码产物必须长什么样"。
// 只描述结构与断言，不教授任何具体分析方法（方法由 Skill 与模型自行决定）。
export function buildAnalysisContractPrompt() {
  return [
    '分析结果契约（生成代码时必须把结果写到 output/analysis.json）：',
    JSON.stringify({
      version: ANALYSIS_CONTRACT_VERSION,
      kind: '自报类型标签，例如 ATTRIBUTION / TREND / COMPOSITION，平台不解释其含义',
      metric: { label: '指标名称', unit: '单位', isRate: false },
      periods: { current: '本期', previous: '上期' },
      totals: { base: 0, current: 0, delta: 0 },
      rows: [
        {
          key: '分组键', label: '分组显示名', base: 0, current: 0,
          delta: 0, changeRate: 0, contribution: 0, share: 0, rank: 1,
          segment: 'NEW|LOST|GROWING|DECLINING|OFFSET|STABLE',
          direction: 'INCREASE|DECREASE|FLAT', note: '',
        },
      ],
      claims: [
        { code: 'ADDITIVE', row: 'contribution', total: 'delta' },
        { code: 'SHARE_SUM', scale: 1 },
        { code: 'DELTA_CONSISTENT' },
      ],
      ...analysisReportPromptShape(),
      notes: ['可选：口径说明、假设与局限'],
    }, null, 2),
    '规则：',
    '- 只能基于 input/ 中已物化的结果快照计算，禁止在代码里重新访问数据库或捏造数据。',
    '- 声明了 ADDITIVE 就必须让各行的指定字段之和精确等于 totals 中指定字段，平台会逐条复算。',
    '- 声明了 SHARE_SUM 就必须让各行 share 之和等于 scale。',
    '- 声明了 DELTA_CONSISTENT 就必须让每行 delta 等于 current - base。',
    '- 任何 NaN / Infinity、任何无法用现有数据支撑的结论，都会导致本轮结果被拒绝并要求重写代码。',
    ...ANALYSIS_REPORT_PROMPT_RULES,
    `- 行数上限 ${MAX_ANALYSIS_ROWS}。`,
  ].join('\n');
}

// 确定性摘要：只做排序与格式化，不新增任何判断。
// 平台用它在回答里呈现"代码算出来的结论"，避免模型复述数字时引入偏差。
export function summarizeAnalysisResult(result, { topN = 5 } = {}) {
  const normalized = result?.normalized ?? normalizeAnalysisResult(result);
  const lines = [];
  if (normalized.kind && normalized.kind !== 'UNSPECIFIED') {
    lines.push(`分析类型：${normalized.kind}`);
  }
  const totals = normalized.totals ?? {};
  if (totals.delta !== null) {
    lines.push(`总变化：${totals.delta}`);
  }
  const ranked = [...normalized.rows]
    .filter((row) => row.contribution !== null)
    .sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution))
    .slice(0, topN);
  for (const row of ranked) {
    const share = row.share === null ? '' : `，占比 ${row.share}`;
    lines.push(`${row.label}：变化 ${row.delta ?? '-'}，贡献 ${row.contribution}${share}`);
  }
  return lines.join('\n');
}

export { summarizeAnalysisReport };
