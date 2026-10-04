// Standalone dataset-profiling component.
//
// Given a dataset's field metadata plus a small sample of rows (and optional
// MIN/MAX ranges per column), it proposes field roles/aggregations and a
// default time condition ("裸跑" 时减少口径与时间范围的追问).
//
// It is deliberately isolated: the only dependency is the business lexicon
// (itself configuration-driven), and it only *suggests*. Callers persist the
// accepted subset into the config
// surfaces the existing pipeline already reads (`dataset_fields.role`,
// `dataset_fields.aggregator`, `business_datasets.config.autoLatestDateRange`
// and `config.autoRangeDays`), so the main flow stays untouched.

import { getPlatformLexicon, profileHintPattern } from './businessLexicon.js';

export const PROFILE_ROLES = Object.freeze(['TIME', 'METRIC', 'DIMENSION', 'IDENTIFIER']);
export const PROFILE_AGGREGATORS = Object.freeze([
  'SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNT_DISTINCT', 'NONE',
]);

const DISTINCT_CAP = 500;
const DATE_PATTERN = /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?([ T]\d{1,2}:\d{2}(:\d{2})?)?/;
const COMPACT_DATE_PATTERN = /^\d{8}$/;

// Used only when there is no usable sample: a numeric column whose name looks
// like a business measure is still worth proposing as a METRIC.
const NUMERIC_SEMANTICS = new Set(['NUMBER', 'NUMERIC', 'DECIMAL', 'INTEGER', 'INT', 'FLOAT', 'DOUBLE', 'BIGINT']);
const NUMERIC_DATATYPE = /^(decimal|numeric|int|bigint|smallint|tinyint|float|double|real|number)/i;

function looksNumeric(field) {
  const semantic = String(field.semanticType ?? '').toUpperCase();
  return NUMERIC_SEMANTICS.has(semantic) || NUMERIC_DATATYPE.test(String(field.dataType ?? ''));
}

function toFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseTemporal(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim();
  if (!text) {
    return null;
  }
  if (COMPACT_DATE_PATTERN.test(text)) {
    const parsed = Date.parse(
      `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T00:00:00Z`,
    );
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (!DATE_PATTERN.test(text)) {
    return null;
  }
  const parsed = Date.parse(text.replace(/\//g, '-').replace(' ', 'T'));
  return Number.isNaN(parsed) ? null : parsed;
}

function collectStats(values) {
  const stats = {
    sampleCount: 0,
    nullCount: 0,
    distinctCount: 0,
    distinctCapped: false,
    numericCount: 0,
    temporalCount: 0,
    integerCount: 0,
    numericMin: null,
    numericMax: null,
    temporalMin: null,
    temporalMax: null,
    booleanValues: new Set(),
    sampleValues: [],
  };
  const seen = new Set();
  for (const value of values) {
    if (value === null || value === undefined || value === '') {
      stats.nullCount += 1;
      continue;
    }
    stats.sampleCount += 1;
    if (seen.size < DISTINCT_CAP) {
      seen.add(String(value));
    } else {
      stats.distinctCapped = true;
    }
    if (stats.sampleValues.length < 5) {
      stats.sampleValues.push(String(value));
    }
    const numeric = toFiniteNumber(value);
    if (numeric !== null) {
      stats.numericCount += 1;
      if (Number.isInteger(numeric)) {
        stats.integerCount += 1;
      }
      stats.numericMin = stats.numericMin === null ? numeric : Math.min(stats.numericMin, numeric);
      stats.numericMax = stats.numericMax === null ? numeric : Math.max(stats.numericMax, numeric);
    }
    const temporal = parseTemporal(value);
    if (temporal !== null) {
      stats.temporalCount += 1;
      stats.temporalMin = stats.temporalMin === null ? temporal : Math.min(stats.temporalMin, temporal);
      stats.temporalMax = stats.temporalMax === null ? temporal : Math.max(stats.temporalMax, temporal);
    }
    if ([true, false, 0, 1, '0', '1', 'true', 'false'].includes(value)) {
      stats.booleanValues.add(String(value));
    }
  }
  stats.distinctCount = seen.size;
  return stats;
}

function ratio(part, total) {
  return total > 0 ? part / total : 0;
}

function summarizeStats(stats) {
  const nonNull = stats.sampleCount;
  return {
    sampleCount: nonNull,
    nullCount: stats.nullCount,
    nullRatio: Number(ratio(stats.nullCount, stats.nullCount + nonNull).toFixed(3)),
    distinctCount: stats.distinctCount,
    distinctCapped: stats.distinctCapped,
    uniqueness: Number(ratio(stats.distinctCount, nonNull).toFixed(3)),
    numericRatio: Number(ratio(stats.numericCount, nonNull).toFixed(3)),
    temporalRatio: Number(ratio(stats.temporalCount, nonNull).toFixed(3)),
    integerRatio: Number(ratio(stats.integerCount, stats.numericCount || 1).toFixed(3)),
    numericMin: stats.numericMin,
    numericMax: stats.numericMax,
    sampleValues: stats.sampleValues,
  };
}

function classifyField(field, stats, summary, lexicon = null) {
  const name = String(field.fieldName ?? '');
  const lower = name.toLowerCase();
  const reasons = [];

  const looksBoolean = stats.booleanValues.size > 0
    && stats.booleanValues.size <= 2
    && summary.numericRatio === 1
    && summary.integerRatio === 1
    && stats.numericMin >= 0
    && stats.numericMax <= 1;

  if (summary.temporalRatio >= 0.8 && summary.sampleCount >= 3) {
    reasons.push(`样本中 ${Math.round(summary.temporalRatio * 100)}% 的值可解析为日期/时间`);
    return { role: 'TIME', confidence: summary.temporalRatio >= 0.95 ? 0.95 : 0.75, reasons };
  }
  if (field.semanticType === 'DATE' && summary.sampleCount < 3) {
    reasons.push('字段类型为日期时间，样本不足');
    return { role: 'TIME', confidence: 0.6, reasons };
  }

  if (profileHintPattern(lexicon ?? getPlatformLexicon(), 'identifier')?.test(lower)) {
    reasons.push('字段名符合词表里的标识列命名');
    return { role: 'IDENTIFIER', confidence: 0.9, reasons };
  }
  if (
    field.semanticType === 'STRING'
    && summary.sampleCount >= 5
    && summary.uniqueness >= 0.95
    && summary.numericRatio < 0.5
  ) {
    reasons.push('字符串列取值几乎唯一，判断为业务标识');
    return { role: 'IDENTIFIER', confidence: 0.7, reasons };
  }

  if (looksBoolean) {
    reasons.push('取值仅为 0/1 或 true/false，判断为标志位维度');
    return { role: 'DIMENSION', confidence: 0.8, reasons };
  }

  if (summary.numericRatio >= 0.9 && summary.sampleCount >= 3) {
    if (summary.distinctCount <= 1 && !summary.distinctCapped) {
      reasons.push('数值列取值单一，更像常量维度而非度量');
      return { role: 'DIMENSION', confidence: 0.5, reasons };
    }
    reasons.push(`样本中 ${Math.round(summary.numericRatio * 100)}% 的值为数值`);
    return { role: 'METRIC', confidence: summary.numericRatio >= 0.98 ? 0.9 : 0.7, reasons };
  }

  // Degraded path: no usable sample (e.g. the datasource is unreachable), so we
  // fall back to field name/type. Only propose METRIC when the sample does not
  // contradict the name (empty sample or mostly numeric).
  if (
    looksNumeric(field)
    && profileHintPattern(lexicon ?? getPlatformLexicon(), 'metric')?.test(lower)
    && (summary.sampleCount < 3 || summary.numericRatio >= 0.5)
  ) {
    reasons.push('字段类型为数值且名称符合度量语义，样本不足时按指标处理');
    return { role: 'METRIC', confidence: 0.55, reasons };
  }

  if (profileHintPattern(lexicon ?? getPlatformLexicon(), 'time')?.test(lower)) {
    reasons.push('字段名包含时间语义，但样本无法确认，建议人工核对');
    return { role: 'TIME', confidence: 0.4, reasons };
  }

  reasons.push('取值以枚举/文本为主，判断为分析维度');
  return { role: 'DIMENSION', confidence: summary.sampleCount >= 3 ? 0.7 : 0.4, reasons };
}

function suggestAggregator(field, stats, summary, role, lexicon = null) {
  if (role !== 'METRIC') {
    return { aggregator: 'NONE', reason: '非度量字段不做聚合' };
  }
  const lower = String(field.fieldName ?? '').toLowerCase();
  const hint = (key) => profileHintPattern(lexicon ?? getPlatformLexicon(), key)?.test(lower);
  if (hint('rate')) {
    return { aggregator: 'AVG', reason: '比率类指标默认取平均' };
  }
  if (hint('stock')) {
    return { aggregator: 'MAX', reason: '存量/库存类指标默认取最大值' };
  }
  if (hint('average')) {
    return { aggregator: 'AVG', reason: '单价/均值类指标默认取平均' };
  }
  if (hint('extreme')) {
    return { aggregator: 'MAX', reason: '极值类字段默认取最大值' };
  }
  if (hint('count')) {
    return { aggregator: 'SUM', reason: '计数/数量类指标默认求和' };
  }
  if (summary.integerRatio === 1 && summary.numericMin >= 0 && summary.uniqueness < 0.98) {
    return { aggregator: 'SUM', reason: '非负整数度量默认求和' };
  }
  return { aggregator: 'SUM', reason: '默认可加度量求和' };
}

function suggestTimeCondition({ timeField, ranges }) {
  if (!timeField) {
    return null;
  }
  const range = ranges[timeField.fieldName] ?? {};
  const start = parseTemporal(range.min);
  const end = parseTemporal(range.max);
  const spanDays = start !== null && end !== null && end >= start
    ? Math.round((end - start) / 86_400_000) + 1
    : null;
  let autoRangeDays = 30;
  if (spanDays !== null) {
    if (spanDays >= 1095) {
      autoRangeDays = 90;
    } else if (spanDays >= 60) {
      autoRangeDays = 30;
    } else if (spanDays >= 14) {
      autoRangeDays = 7;
    } else {
      autoRangeDays = Math.max(1, spanDays);
    }
  }
  return {
    field: timeField.fieldName,
    autoLatestDateRange: true,
    autoRangeDays,
    dataStart: range.min != null ? String(range.min).slice(0, 10) : null,
    dataEnd: range.max != null ? String(range.max).slice(0, 10) : null,
    spanDays,
    reason: spanDays !== null
      ? `数据覆盖约 ${spanDays} 天，建议未指定时间范围时默认近 ${autoRangeDays} 天`
      : `建议未指定时间范围时默认近 ${autoRangeDays} 天`,
  };
}

export function profileDataset({
  datasetId = null,
  fields = [],
  rows = [],
  ranges = {},
  options = {},
  lexicon = null,
} = {}) {
  const sampleSize = rows.length;
  const proposals = [];
  const columnStats = new Map();

  for (const field of fields) {
    const values = rows.map((row) => row?.[field.fieldName]);
    const stats = collectStats(values);
    columnStats.set(field.fieldName, stats);
    const summary = summarizeStats(stats);
    const { role, confidence, reasons: roleReasons } = classifyField(field, stats, summary, lexicon);
    const { aggregator, reason: aggregatorReason } = suggestAggregator(field, stats, summary, role, lexicon);
    const reasons = [...roleReasons];
    if (field.role && field.role !== role) {
      reasons.push(`当前配置为 ${field.role}，按数据特征建议调整为 ${role}`);
    }
    proposals.push({
      fieldName: field.fieldName,
      displayName: field.displayName ?? field.fieldName,
      dataType: field.dataType ?? '',
      semanticType: field.semanticType ?? 'STRING',
      currentRole: field.role ?? 'DIMENSION',
      currentAggregator: field.aggregator ?? 'NONE',
      suggestedRole: role,
      suggestedAggregator: aggregator,
      confidence,
      changed: (field.role ?? 'DIMENSION') !== role
        || (field.aggregator ?? 'NONE') !== aggregator,
      reasons,
      aggregatorReason,
      stats: summary,
    });
  }

  const timeProposal = proposals
    .filter((item) => item.suggestedRole === 'TIME')
    .sort((left, right) => right.confidence - left.confidence)[0] ?? null;
  const timeCondition = suggestTimeCondition({
    timeField: timeProposal,
    ranges,
  });

  const countByRole = (role) => proposals.filter((item) => item.suggestedRole === role).length;
  const degradedReason = options.degraded ? String(options.degraded) : null;
  return {
    datasetId: datasetId !== null ? Number(datasetId) : null,
    generatedAt: new Date().toISOString(),
    sampleSize,
    degraded: degradedReason !== null,
    degradedReason,
    options: {
      sampleSize: Number(options.sampleSize ?? sampleSize),
    },
    timeCondition,
    fields: proposals,
    summary: {
      fieldCount: proposals.length,
      timeFieldCount: countByRole('TIME'),
      metricCount: countByRole('METRIC'),
      dimensionCount: countByRole('DIMENSION'),
      identifierCount: countByRole('IDENTIFIER'),
      changedCount: proposals.filter((item) => item.changed).length,
    },
  };
}

// Validates the subset a user accepted before it is persisted.
export function normalizeProfileSelection({ fields = [], config = null } = {}) {
  const normalizedFields = fields.map((field) => {
    const role = String(field.role ?? '').toUpperCase();
    if (!PROFILE_ROLES.includes(role)) {
      throw Object.assign(new Error(`unsupported field role: ${field.role}`), { statusCode: 400 });
    }
    // Mirror the dataset layer default: metrics aggregate, everything else does not.
    const aggregator = String(
      field.aggregator ?? (role === 'METRIC' ? 'SUM' : 'NONE'),
    ).toUpperCase();
    if (!PROFILE_AGGREGATORS.includes(aggregator)) {
      throw Object.assign(
        new Error(`unsupported field aggregator: ${field.aggregator}`),
        { statusCode: 400 },
      );
    }
    if (role !== 'METRIC' && aggregator !== 'NONE') {
      throw Object.assign(
        new Error(`only METRIC fields can have an aggregator: ${field.fieldName}`),
        { statusCode: 400 },
      );
    }
    return {
      fieldName: String(field.fieldName ?? ''),
      role,
      aggregator,
      ...(field.displayName != null ? { displayName: String(field.displayName) } : {}),
      ...(field.description != null ? { description: String(field.description) } : {}),
    };
  }).filter((field) => field.fieldName);

  let normalizedConfig = null;
  if (config && typeof config === 'object') {
    normalizedConfig = {};
    if (config.autoLatestDateRange != null) {
      normalizedConfig.autoLatestDateRange = config.autoLatestDateRange !== false;
    }
    if (config.autoRangeDays != null) {
      const days = Number(config.autoRangeDays);
      if (!Number.isFinite(days) || days < 1 || days > 3650) {
        throw Object.assign(new Error('autoRangeDays must be between 1 and 3650'), { statusCode: 400 });
      }
      normalizedConfig.autoRangeDays = Math.round(days);
    }
  }
  return { fields: normalizedFields, config: normalizedConfig };
}
