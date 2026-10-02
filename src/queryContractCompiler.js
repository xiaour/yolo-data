import crypto from 'node:crypto';
import {
  buildPreviousAlignedWindow,
  extractTemporalMentions,
} from './timeSemantics.js';
import {
  extractTimeGrainExpression,
  inferAnalysisMode,
} from './queryIntent.js';
import { resolveSemanticValue } from './semanticValues.js';
import {
  normalizeLikePattern,
  resolveFilterScope,
} from './querySemantics.js';
import { normalizeDerivedMetrics } from './derivedMetrics.js';
import {
  attachGateMetadata,
  summarizeGateIssues,
} from './gateRegistry.js';
import { classifyAnalysisSemantics } from './analysisSemantics.js';
import { applySemanticPolicy } from './semanticPolicy.js';
import { resolveWithPlugins } from './analysisPluginRegistry.js';
import { normalizeAnalysisPipeline } from './analysisPipeline.js';
import { CONTRACT_COMPILER_VERSION } from './contractVersion.js';

const CONDITION_KINDS = new Set([
  'METRIC',
  'DIMENSION',
  'FILTER',
  'SCOPE',
  'TIME',
  'LIMIT',
  'COMPARISON',
  'CALCULATION',
  'ANALYSIS_STAGE',
  'RESULT_ACTION',
  'OTHER',
]);
const CONDITION_STATUSES = new Set([
  'RESOLVED',
  'UNRESOLVED',
  'NOT_APPLICABLE',
]);
const SUPPORTED_CALCULATIONS = new Set(['NONE', 'PERIOD_COMPARISON']);
const TIME_GRAINS = new Set(['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR']);
const RESULT_ACTION_PATTERN =
  /导出|下载|输出|保存|生成|excel|xlsx|csv|cel|表格|文件/i;
const PRESENTATION_PATTERN =
  /趋势|走势|折线图|折线展示|图形展示|可视化/;
const QUESTION_FILLER_PATTERN =
  '请|麻烦|帮我|给我|提供|查询|查一下|看看|看一下|查看|请问|的|了|呢|吗|多少|是多少|有哪些|哪些|哪个|什么|分别|以及|并且|然后|同时|另外|并|按照|分组|展示|输出|统计|分析|排名|对比|和|与|vs|数据|具体原因|原因|为何|为什么|归因|上升还是下滑|上升或下滑|上升|下滑|下降|增长';

function normalizePostProcessing(postProcessing) {
  return postProcessing && typeof postProcessing === 'object'
    ? JSON.parse(JSON.stringify(postProcessing))
    : null;
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function compact(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s，,。；;：:！!？?、"'“”‘’（）()【】[\]{}]/g, '');
}

function compactWithoutSuffix(value) {
  return compact(value).replace(
    /(名称|名字|编号|编码|代码|id|name|code)$/i,
    '',
  );
}

function coreAliases(item, type) {
  return fieldAliases(item, type)
    .map(compactWithoutSuffix)
    .filter((value) => value.length >= 2);
}

function fieldAliases(item, type = 'DIMENSION') {
  if (type === 'DATASET') {
    return [
      item?.fieldName,
      item?.displayName,
      item?.name,
    ].filter(Boolean).map(String);
  }
  if (type === 'METRIC') {
    return [
      item?.metricBizName,
      item?.bizName,
      item?.metricName,
      item?.name,
    ].filter(Boolean).map(String);
  }
  return [
    item?.dimensionBizName,
    item?.bizName,
    item?.dimensionName,
    item?.name,
  ].filter(Boolean).map(String);
}

function resolveFieldDetailed(requested, available, type) {
  const target = compact(requested);
  if (!target) {
    return null;
  }
  for (const item of available ?? []) {
    const aliases = fieldAliases(item, type);
    const matchedAlias = aliases.find((alias) => compact(alias) === target);
    if (matchedAlias) {
      const canonical = canonicalField(item, type);
      return {
        item,
        mode: compact(canonical) === target ? 'EXACT' : 'ALIAS',
        matchedAlias,
      };
    }
  }
  for (const item of available ?? []) {
    const aliases = fieldAliases(item, type);
    const matchedAlias = aliases.find((alias) => {
      const normalized = compact(alias);
      return normalized.includes(target) || target.includes(normalized);
    });
    if (matchedAlias) {
      return {
        item,
        mode: 'FUZZY',
        matchedAlias,
      };
    }
  }
  return null;
}

function resolveField(requested, available, type) {
  return resolveFieldDetailed(requested, available, type)?.item ?? null;
}

function canonicalField(item, type) {
  if (!item) {
    return '';
  }
  if (type === 'DATASET') {
    return String(item.fieldName ?? '');
  }
  if (type === 'METRIC') {
    return String(item.metricBizName ?? item.bizName ?? item.metricName ?? item.name ?? '');
  }
  return String(
    item.dimensionBizName ?? item.bizName ?? item.dimensionName ?? item.name ?? '',
  );
}

function isDateField(field) {
  if (field?.role === 'TIME') {
    return true;
  }
  return /(^|_)(date|time|day|week|month|quarter|year)($|_)|sdt|日期|时间|账期/i.test(
    String(field?.fieldName ?? field?.dimensionBizName ?? field?.bizName ?? ''),
  );
}

function resolveTimeField(available) {
  const candidates = (available ?? []).filter(isDateField);
  return candidates.find((field) => /^(sdt|ds|dt|stat_date|partition_date)$/i.test(
    String(field?.fieldName ?? field?.dimensionBizName ?? field?.bizName ?? ''),
  )) ?? candidates[0] ?? null;
}

function normalizeCondition(condition, index) {
  const sourceText = String(condition?.sourceText ?? '').trim();
  const originalKind = String(condition?.kind ?? 'OTHER').trim().toUpperCase();
  const originalStatus = String(condition?.status ?? 'UNRESOLVED').trim().toUpperCase();
  const presentationIntent = (
    PRESENTATION_PATTERN.test(sourceText)
    || inferAnalysisMode(sourceText).mode === 'ATTRIBUTION'
  )
    && ['CALCULATION', 'RESULT_ACTION', 'OTHER'].includes(originalKind);
  const kind = presentationIntent ? 'RESULT_ACTION' : originalKind;
  const status = presentationIntent ? 'RESOLVED' : originalStatus;
  return {
    id: String(condition?.id ?? `condition-${index + 1}`),
    sourceText,
    kind: CONDITION_KINDS.has(kind) ? kind : 'OTHER',
    status: CONDITION_STATUSES.has(status) ? status : 'UNRESOLVED',
    reason: String(condition?.reason ?? '').trim(),
    ruleSource: String(condition?.ruleSource ?? '').trim(),
  };
}

function normalizeConditionIds(value) {
  return uniqueStrings(Array.isArray(value) ? value : [value].filter(Boolean));
}

function normalizeMetricFields(metrics, available, issues, fieldType = 'METRIC') {
  const normalized = (metrics ?? []).map((metric, index) => {
    const requested = typeof metric === 'string' ? metric : metric?.field;
    const resolution = resolveFieldDetailed(requested, available, fieldType);
    const resolved = resolution?.item ?? null;
    const field = canonicalField(resolved, fieldType);
    if (!field) {
      issues.push({
        level: 'ERROR',
        code: 'METRIC_FIELD_UNRESOLVED',
        message: `指标字段无法映射到实时语义定义: ${requested ?? index + 1}`,
      });
    }
    return {
      field,
      requested: String(requested ?? ''),
      mappingMode: resolution?.mode ?? 'UNRESOLVED',
      matchedAlias: resolution?.matchedAlias ?? '',
      sourceText: String(
        (typeof metric === 'object' ? metric?.sourceText : null) ?? '',
      ).trim(),
      aggregator: String(
        (typeof metric === 'object' ? metric?.aggregator : null) ?? 'SUM',
      ).toUpperCase(),
      conditionIds: normalizeConditionIds(
        typeof metric === 'object' ? metric?.conditionIds : null,
      ),
      internal: metric?.internal === true,
    };
  }).filter((item) => item.field);
  const merged = new Map();
  for (const metric of normalized) {
    const key = `${metric.field}\u001f${metric.aggregator}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...metric });
      continue;
    }
    existing.conditionIds = [
      ...new Set([
        ...(existing.conditionIds ?? []),
        ...(metric.conditionIds ?? []),
      ]),
    ];
    existing.internal = existing.internal || metric.internal;
    if (!existing.sourceText && metric.sourceText) {
      existing.sourceText = metric.sourceText;
      existing.requested = metric.requested;
      existing.mappingMode = metric.mappingMode;
      existing.matchedAlias = metric.matchedAlias;
    }
  }
  return [...merged.values()];
}

function normalizeDimensionFields(dimensions, available, issues, fieldType = 'DIMENSION') {
  return (dimensions ?? []).map((dimension, index) => {
    const requested = typeof dimension === 'string' ? dimension : dimension?.field;
    const resolution = resolveFieldDetailed(requested, available, fieldType);
    const resolved = resolution?.item ?? null;
    const field = canonicalField(resolved, fieldType);
    if (!field) {
      issues.push({
        level: 'ERROR',
        code: 'DIMENSION_FIELD_UNRESOLVED',
        message: `维度字段无法映射到实时语义定义: ${requested ?? index + 1}`,
      });
    }
    return {
      field,
      requested: String(requested ?? ''),
      mappingMode: resolution?.mode ?? 'UNRESOLVED',
      matchedAlias: resolution?.matchedAlias ?? '',
      sourceText: String(
        (typeof dimension === 'object' ? dimension?.sourceText : null) ?? '',
      ).trim(),
      timeGrain: String(
        (typeof dimension === 'object' ? dimension?.timeGrain : null) ?? '',
      ).toUpperCase(),
      isTime: isDateField(resolved),
      ruleSource: String(
        (typeof dimension === 'object' ? dimension?.ruleSource : null) ?? '',
      ).trim(),
      conditionIds: normalizeConditionIds(
        typeof dimension === 'object' ? dimension?.conditionIds : null,
      ),
    };
  }).filter((item) => item.field);
}

function resolveFilterValue(
  value,
  resolvedField,
  operator,
  issues,
  requestedField,
  ruleSource = '',
) {
  const normalizedOperator = String(operator ?? 'IN').toUpperCase();
  const governance = resolvedField?.valueDomain?.governance ?? null;
  if (
    ['IS_NULL', 'IS_NOT_NULL'].includes(normalizedOperator)
    || !resolvedField?.valueDomain?.values?.length
  ) {
    if (
      !['IS_NULL', 'IS_NOT_NULL'].includes(normalizedOperator)
      && String(ruleSource ?? '').startsWith('semanticPolicy:')
      && governance?.allowUnverifiedPolicyValue === true
    ) {
      return {
        value,
        mapping: {
          requested: value,
          resolved: value,
          mode: 'POLICY_DECLARED_UNVERIFIED',
          confidence: 1,
          aliases: [],
          domainStatus: governance.status,
          domainVersion: governance.version,
        },
      };
    }
    if (
      !['IS_NULL', 'IS_NOT_NULL'].includes(normalizedOperator)
      && governance
      && governance.rejectUnknownValue !== false
    ) {
      const domainStatus = String(governance?.status ?? 'UNKNOWN').toUpperCase();
      if (
        domainStatus === 'UNKNOWN'
        || domainStatus === 'REFRESHING'
        || domainStatus === 'FAILED'
      ) {
        issues.push({
          level: 'ERROR',
          code: 'FILTER_DOMAIN_NOT_READY',
          message: `字段「${requestedField}」的默认值域尚未完成初始化，不能验证过滤值。`,
        });
      } else if (domainStatus === 'STALE' || domainStatus === 'PARTIAL') {
        issues.push({
          level: 'ERROR',
          code: domainStatus === 'STALE'
            ? 'FILTER_DOMAIN_STALE'
            : 'FILTER_DOMAIN_PARTIAL',
          message: `字段「${requestedField}」的默认值域状态为 ${domainStatus}，请先刷新值域。`,
        });
      }
    }
    return { value, mapping: null };
  }
  const requestValues = Array.isArray(value) ? value : [value];
  const resolutions = requestValues.map((item) => resolveSemanticValue(
    item,
    resolvedField.valueDomain,
  ));
  const unresolved = resolutions
    .map((resolution, index) => ({ resolution, value: requestValues[index] }))
    .filter((item) => !item.resolution.matched);
  if (unresolved.length > 0) {
    const ruleBound = String(ruleSource ?? '').trim()
      && unresolved.every((item) => valueDeclaredInRule(item.value, ruleSource));
    const policyUnverifiedAllowed = String(ruleSource ?? '').startsWith('semanticPolicy:')
      && governance?.allowUnverifiedPolicyValue === true;
    if (ruleBound || policyUnverifiedAllowed) {
      const resolvedValues = resolutions.map((resolution, index) => (
        resolution.matched ? resolution.value : requestValues[index]
      ));
      return {
        value: Array.isArray(value) ? resolvedValues : resolvedValues[0],
        mapping: {
          requested: value,
          resolved: Array.isArray(value) ? resolvedValues : resolvedValues[0],
          mode: policyUnverifiedAllowed && !ruleBound
            ? 'POLICY_DECLARED_UNVERIFIED'
            : 'RULE',
          confidence: 1,
          aliases: resolutions.map((resolution) => resolution.alias),
          domainStatus: governance?.status ?? null,
          domainVersion: governance?.version ?? null,
        },
      };
    }
    for (const item of unresolved) {
      const candidates = (item.resolution.candidates ?? [])
        .map((candidate) => candidate.value)
        .join('、');
      issues.push({
        level: 'ERROR',
        code: item.resolution.reason === 'AMBIGUOUS'
          ? 'FILTER_VALUE_AMBIGUOUS'
          : item.resolution.domainStatus === 'STALE'
            ? 'FILTER_DOMAIN_STALE'
            : item.resolution.domainStatus === 'PARTIAL'
              ? 'FILTER_DOMAIN_PARTIAL'
              : 'FILTER_VALUE_NOT_IN_DOMAIN',
        message: item.resolution.reason === 'AMBIGUOUS'
          ? `过滤值「${item.value}」在字段「${requestedField}」中可能匹配多个枚举值：${candidates}`
          : `过滤值「${item.value}」不在字段「${requestedField}」的默认值域中`,
      });
    }
    return { value, mapping: null };
  }
  const resolvedValues = resolutions.map((resolution) => resolution.value);
  const modes = resolutions.map((resolution) => resolution.mode);
  const mode = modes.includes('FUZZY')
    ? 'FUZZY'
    : modes.includes('ALIAS')
      ? 'ALIAS'
      : 'EXACT';
  return {
    value: Array.isArray(value) ? resolvedValues : resolvedValues[0],
    mapping: {
      requested: value,
      resolved: Array.isArray(value) ? resolvedValues : resolvedValues[0],
      mode,
      confidence: Math.min(...resolutions.map((resolution) => resolution.confidence ?? 1)),
      aliases: resolutions.map((resolution) => resolution.alias),
      domainStatus: governance?.status ?? null,
      domainVersion: governance?.version ?? null,
    },
  };
}

function normalizeFilters(filters, available, issues, fieldType = 'DIMENSION') {
  return (filters ?? []).map((filter, index) => {
    const requested = filter?.field ?? filter?.bizName;
    const resolution = resolveFieldDetailed(requested, available, fieldType);
    const resolved = resolution?.item ?? null;
    const field = canonicalField(resolved, fieldType);
    const operator = String(filter?.operator ?? 'IN').toUpperCase();
    const sourceText = String(filter?.sourceText ?? '').trim();
    const value = operator === 'LIKE'
      ? normalizeLikePattern(filter?.value, sourceText)
      : filter?.value;
    const scope = resolveFilterScope({
      field: resolved,
      operator,
      sourceText,
    });
    if (!field) {
      issues.push({
        level: 'ERROR',
        code: 'FILTER_FIELD_UNRESOLVED',
        message: `过滤字段无法映射到实时语义定义: ${requested ?? index + 1}`,
      });
    }
    const valueResolution = resolveFilterValue(
      value,
      resolved,
      operator,
      issues,
      requested,
      filter?.ruleSource,
    );
    return {
      field,
      requested: String(requested ?? ''),
      mappingMode: resolution?.mode ?? 'UNRESOLVED',
      matchedAlias: resolution?.matchedAlias ?? '',
      operator,
      value: valueResolution.value,
      requestedValue: filter?.value,
      scope,
      valueMapping: valueResolution.mapping,
      sourceText,
      ruleSource: String(filter?.ruleSource ?? '').trim(),
      conditionIds: normalizeConditionIds(filter?.conditionIds),
    };
  }).filter((item) => item.field);
}

function dedupeFilters(filters = []) {
  const merged = new Map();
  for (const filter of filters) {
    const key = [
      String(filter.field ?? ''),
      String(filter.operator ?? '').toUpperCase(),
      JSON.stringify(
        (Array.isArray(filter.value) ? [...filter.value] : [filter.value])
          .map((value) => String(value ?? ''))
          .sort(),
      ),
      String(filter.scope ?? 'ROW').toUpperCase(),
    ].join('|');
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...filter });
      continue;
    }
    existing.conditionIds = normalizeConditionIds([
      ...(existing.conditionIds ?? []),
      ...(filter.conditionIds ?? []),
    ]);
    if (!existing.ruleSource && filter.ruleSource) {
      existing.ruleSource = filter.ruleSource;
    }
  }
  return [...merged.values()];
}

function normalizeScopeModifiers(modifiers) {
  return (modifiers ?? []).map((modifier) => ({
    sourceText: String(modifier?.sourceText ?? '').trim(),
    action: String(modifier?.action ?? 'NO_FILTER').toUpperCase() === 'ALL_SCOPE'
      ? 'ALL_SCOPE'
      : 'NO_FILTER',
    ruleSource: String(modifier?.ruleSource ?? '').trim(),
    conditionIds: normalizeConditionIds(modifier?.conditionIds),
  })).filter((modifier) => modifier.sourceText);
}

function normalizeTimeWindows(windows, timeField) {
  return (windows ?? []).map((window, index) => ({
    id: String(window?.id ?? `window-${index + 1}`),
    sourceText: String(window?.sourceText ?? window?.expression ?? '').trim(),
    label: String(window?.label ?? window?.sourceText ?? window?.expression ?? '').trim(),
    dateMode: String(window?.dateMode ?? 'BETWEEN').toUpperCase(),
    unit: window?.unit === undefined || window?.unit === null
      ? null
      : Math.max(1, Number(window.unit) || 1),
    period: window?.period ? String(window.period).toUpperCase() : null,
    startDate: window?.startDate ?? null,
    endDate: window?.endDate ?? null,
    dateField: canonicalField(timeField, 'DIMENSION') || null,
    ruleSource: String(window?.ruleSource ?? '').trim(),
    conditionIds: normalizeConditionIds(window?.conditionIds),
  }));
}

function splitQuestionClauses(question) {
  return String(question ?? '')
    .split(/[，,。；;！!？?\n]+|(?=(?:并且|同时|另外|然后|以及|再按|再计算))/)
    .map((clause) => clause.trim())
    .filter((clause) => compact(clause).length >= 2)
    .filter((clause) => !/^(?:并|然后|再|还有|以及|说明|展示|输出)$/.test(clause));
}

function isResultActionClause(clause) {
  return RESULT_ACTION_PATTERN.test(String(clause ?? ''));
}

function conditionCoverage(clause, conditions) {
  const target = compact(clause).replace(
    new RegExp(QUESTION_FILLER_PATTERN, 'gi'),
    '',
  );
  if (!target) {
    return 1;
  }
  let covered = 0;
  for (const condition of conditions) {
    const source = compact(condition.sourceText).replace(
      new RegExp(QUESTION_FILLER_PATTERN, 'gi'),
      '',
    );
    if (source && target.includes(source)) {
      covered += Math.min(source.length, target.length);
    }
  }
  return Math.min(1, covered / target.length);
}

function textHasRule(source, rule, ruleSources) {
  const ruleText = compact(
    String(rule ?? '').replace(/第[一二三四五六七八九十\d]+节[:：]?/g, ''),
  );
  if (!ruleText) {
    return false;
  }
  const candidates = [source, ...(ruleSources ?? [])]
    .map(compact)
    .filter(Boolean);
  if (candidates.some((item) => item.includes(ruleText))) {
    return true;
  }
  const bigrams = [...new Set(
    Array.from({ length: Math.max(0, ruleText.length - 1) }, (_, index) => (
      ruleText.slice(index, index + 2)
    )),
  )];
  if (bigrams.length < 4) {
    return false;
  }
  return candidates.some((item) => {
    const matched = bigrams.filter((bigram) => item.includes(bigram)).length;
    return matched / bigrams.length >= 0.72;
  });
}

function valueDeclaredInRule(value, ruleSource) {
  const tokens = new Set(
    String(ruleSource ?? '')
      .split(/[\s、,，;；|/+*=：:]+/)
      .map(compact)
      .filter(Boolean),
  );
  const normalized = compact(value);
  return Boolean(normalized && tokens.has(normalized));
}

function valueAppearsInText(value, text) {
  const target = compact(text);
  const values = Array.isArray(value) ? value : [value];
  return values.every((item) => {
    const normalized = compact(item);
    if (normalized && target.includes(normalized)) {
      return true;
    }
    const numeric = Number(item);
    if (!Number.isFinite(numeric)) {
      return false;
    }
    for (const match of String(text ?? '').matchAll(
      /(-?\d+(?:\.\d+)?)\s*(亿|万|千|百)?/g,
    )) {
      const base = Number(match[1]);
      const multiplier = match[2] === '亿'
        ? 100_000_000
        : match[2] === '万'
          ? 10_000
          : match[2] === '千'
            ? 1_000
            : match[2] === '百'
              ? 100
              : 1;
      if (Number.isFinite(base) && base * multiplier === numeric) {
        return true;
      }
    }
    return false;
  });
}

function parseChineseNumber(value) {
  const digits = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  const text = String(value ?? '');
  if (/^\d+$/.test(text)) {
    return Number(text);
  }
  const tenIndex = text.indexOf('十');
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : digits[text[tenIndex - 1]];
    const ones = text[tenIndex + 1] ? digits[text[tenIndex + 1]] : 0;
    return Number.isFinite(tens) && Number.isFinite(ones)
      ? tens * 10 + ones
      : null;
  }
  return text.length === 1 && digits[text] ? digits[text] : null;
}

function resolveTopN(text) {
  const match = String(text ?? '').match(
    /top\s*(\d+)|前\s*(\d+|[一二两三四五六七八九十]+)|排名前\s*(\d+|[一二两三四五六七八九十]+)/i,
  );
  return parseChineseNumber(match?.[1] ?? match?.[2] ?? match?.[3]);
}

function inferConditionBindings(conditions, bindings) {
  const cloned = (bindings ?? []).map((binding) => ({
    ...binding,
    conditionIds: [...(binding.conditionIds ?? [])],
  }));
  for (const condition of conditions) {
    const kindToBinding = {
      METRIC: 'METRIC',
      DIMENSION: 'DIMENSION',
      FILTER: 'FILTER',
      SCOPE: 'SCOPE',
      TIME: 'TIME',
      DERIVED: 'DERIVED',
    };
    const bindingType = kindToBinding[condition.kind];
    if (!bindingType) {
      continue;
    }
    const candidates = cloned.filter((binding) => {
      const type = binding.kind ?? bindingType;
      return type === bindingType;
    });
    if (candidates.some((binding) => binding.conditionIds.includes(condition.id))) {
      continue;
    }
    if (candidates.length === 1) {
      candidates[0].conditionIds.push(condition.id);
      continue;
    }
    const matching = candidates.filter((binding) => {
      const source = compact(condition.sourceText);
      const bindingText = compact(
        binding.requested || binding.sourceText || binding.label || '',
      );
      return source && (
        source.includes(bindingText)
        || bindingText.includes(source)
      );
    });
    if (matching.length === 1) {
      matching[0].conditionIds.push(condition.id);
    }
  }
  return cloned;
}

function normalizeDateWindowFromMention(window, mention) {
  const dateInfo = mention.dateInfo ?? {};
  return {
    ...window,
    sourceText: window.sourceText || mention.expression,
    label: window.label || mention.expression,
    dateMode: String(dateInfo.dateMode ?? window.dateMode ?? 'BETWEEN').toUpperCase(),
    unit: dateInfo.unit ?? window.unit ?? null,
    period: dateInfo.period ?? window.period ?? null,
    startDate: dateInfo.startDate ?? window.startDate ?? null,
    endDate: dateInfo.endDate ?? window.endDate ?? null,
  };
}

function endOfMonth(dateText) {
  const match = String(dateText ?? '').match(/^(\d{4})-(\d{2})/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return null;
  }
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${match[1]}-${match[2]}-${String(day).padStart(2, '0')}`;
}

function normalizeWindowRange(window) {
  const next = { ...window };
  if (next.startDate && !next.endDate) {
    next.endDate = endOfMonth(next.startDate);
  }
  if (next.startDate && next.endDate && String(next.startDate) > String(next.endDate)) {
    next.endDate = endOfMonth(next.startDate);
  }
  return next;
}

function dateRangeContains(outerStart, outerEnd, innerStart, innerEnd) {
  return [outerStart, outerEnd, innerStart, innerEnd].every(
    (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')),
  ) && String(outerStart) <= String(innerStart)
    && String(outerEnd) >= String(innerEnd)
    && (
      String(outerStart) < String(innerStart)
      || String(outerEnd) > String(innerEnd)
    );
}

function bindMentionWindows(question, windows, now, conditions = []) {
  const mentions = extractTemporalMentions(question, now);
  const issues = [];
  const addedConditions = [];
  const addedWindowExpressions = [];
  const bound = (windows ?? []).map((window) => ({ ...window }));
  const findTimeCondition = (mentionText) => conditions.find((condition) => {
    if (condition.kind !== 'TIME') {
      return false;
    }
    const source = compact(condition.sourceText);
    return source && (
      source.includes(mentionText)
      || mentionText.includes(source)
    );
  });
  const ensureTimeCondition = (mention) => {
    const mentionText = compact(mention.expression);
    const existing = findTimeCondition(mentionText);
    if (existing) {
      return existing;
    }
    let index = conditions.length + 1;
    while (conditions.some((condition) => condition.id === `time-auto-${index}`)) {
      index += 1;
    }
    const condition = {
      id: `time-auto-${index}`,
      sourceText: mention.expression,
      kind: 'TIME',
      status: 'RESOLVED',
    };
    conditions.push(condition);
    addedConditions.push(condition);
    return condition;
  };
  for (const mention of mentions.sort(
    (left, right) => right.expression.length - left.expression.length,
  )) {
    const mentionText = compact(mention.expression);
    const condition = ensureTimeCondition(mention);
    const index = bound.findIndex((window) => {
      const dateInfo = mention.dateInfo ?? {};
      if (
        dateInfo.startDate
        && dateInfo.endDate
        && String(window.startDate ?? '') === String(dateInfo.startDate)
        && String(window.endDate ?? '') === String(dateInfo.endDate)
      ) {
        return true;
      }
      const values = [window.sourceText, window.label, window.ruleSource];
      return values.some((value) => {
        const current = compact(value);
        return current && (
          current.includes(mentionText)
          || mentionText.includes(current)
        );
      });
    });
    if (index < 0) {
      bound.push(normalizeWindowRange(normalizeDateWindowFromMention({
        sourceText: mention.expression,
        label: mention.expression,
        expression: mention.expression,
        conditionIds: [condition.id],
      }, mention)));
      addedWindowExpressions.push(mention.expression);
      continue;
    }
    const existingWindow = bound[index];
    const normalizedMention = normalizeDateWindowFromMention(existingWindow, mention);
    const incomingMentionText = compact(mention.expression);
    const samePrimaryMention = [existingWindow.sourceText, existingWindow.label]
      .map(compact)
      .filter(Boolean)
      .some((value) => value === incomingMentionText);
    const explicitRange = /(?:到|至|~|—|－|-)/.test(mention.expression);
    const mentionIsNarrower = dateRangeContains(
      existingWindow.startDate,
      existingWindow.endDate,
      normalizedMention.startDate,
      normalizedMention.endDate,
    );
    bound[index] = normalizeWindowRange(
      mentionIsNarrower
        ? (samePrimaryMention && !explicitRange ? normalizedMention : existingWindow)
        : normalizedMention,
    );
    bound[index].conditionIds = [
      ...new Set([
        ...(bound[index].conditionIds ?? []),
        condition.id,
      ]),
    ];
  }
  return {
    mentions,
    windows: bound.map(normalizeWindowRange),
    issues,
    addedConditions,
    addedWindowExpressions,
  };
}

function semanticSourceMatches(left, right) {
  const a = compact(left);
  const b = compact(right);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

function semanticConditionKinds(category) {
  if (category.code === 'DIMENSION') {
    return ['DIMENSION', 'FILTER'];
  }
  if (category.code === 'COMPARISON') {
    return ['COMPARISON', 'CALCULATION', 'RESULT_ACTION'];
  }
  if (category.code === 'CALCULATION') {
    return ['CALCULATION', 'COMPARISON', 'METRIC'];
  }
  if (category.code === 'SCOPE') {
    return ['SCOPE', 'FILTER'];
  }
  if (category.code === 'FILTER') {
    return ['FILTER', 'SCOPE', 'ANALYSIS_STAGE'];
  }
  if (category.code === 'CALCULATION') {
    return ['CALCULATION', 'COMPARISON', 'METRIC', 'ANALYSIS_STAGE'];
  }
  if (category.code === 'RESULT_ACTION') {
    return ['RESULT_ACTION', 'CALCULATION'];
  }
  return [category.conditionKind];
}

function findSemanticCondition(conditions, category) {
  const kinds = new Set(semanticConditionKinds(category));
  const matched = conditions.find((condition) => (
    kinds.has(condition.kind)
    && semanticSourceMatches(condition.sourceText, category.sourceText)
  ));
  if (
    matched
    || category.code !== 'DIMENSION'
    || !/^(?:分别|各自|分开)$/.test(compact(category.sourceText))
  ) {
    return matched;
  }
  return conditions.find((condition) => condition.kind === 'FILTER') ?? null;
}

function completePlatformSemanticConditions(profile, conditions) {
  const added = [];
  let rankLimit = null;
  for (const category of profile?.categories ?? []) {
    if (!category.autoComplete || category.code === 'TIME_WINDOW') {
      continue;
    }
    const existing = findSemanticCondition(conditions, category);
    if (existing) {
      continue;
    }
    let index = conditions.length + 1;
    while (conditions.some((condition) => (
      condition.id === `semantic-auto-${index}`
    ))) {
      index += 1;
    }
    const condition = {
      id: `semantic-auto-${index}`,
      sourceText: category.sourceText,
      kind: category.conditionKind,
      status: 'RESOLVED',
      reason: `平台按${category.label}语义自动补全`,
      ruleSource: `analysisSemantics:${category.code}`,
    };
    conditions.push(condition);
    added.push(condition);
    if (category.code === 'RANKING') {
      const topN = resolveTopN(category.sourceText);
      if (Number.isFinite(topN) && topN > 0) {
        rankLimit = topN;
      }
    }
  }
  return { added, rankLimit };
}

function auditSemanticCategories(profile, conditions, issues) {
  for (const category of profile?.categories ?? []) {
    if (
      category.owner === 'PLATFORM'
      || category.code === 'TIME_WINDOW'
      || findSemanticCondition(conditions, category)
    ) {
      continue;
    }
    issues.push({
      level: 'ERROR',
      code: 'SEMANTIC_CATEGORY_NOT_BOUND',
      phase: 'PLAN',
      categoryCode: category.code,
      message: `检测到${category.label}语义「${category.sourceText}」，但条件账本没有对应的 ${category.conditionKind}/${category.code} 条件。`,
    });
  }
}

function buildSemanticCoverage(
  profile,
  conditions,
  automaticConditionIds = [],
  automaticSources = [],
) {
  const automatic = new Set(automaticConditionIds);
  return (profile?.categories ?? []).map((category) => {
    const condition = findSemanticCondition(conditions, category);
    const automaticallyCompleted = automatic.has(condition?.id)
      || automaticSources.some((source) => (
        semanticSourceMatches(source, category.sourceText)
      ));
    return {
      code: category.code,
      label: category.label,
      owner: category.owner,
      conditionKind: category.conditionKind,
      sourceText: category.sourceText,
      status: condition
        ? automaticallyCompleted
          ? 'AUTO_COMPLETED'
          : 'BOUND'
        : 'MISSING',
    };
  });
}

function validateConditionBindings(conditions, {
  metricFields,
  derivedMetrics = [],
  dimensionFields,
  filterFields,
  scopeModifiers,
  timeWindows,
  limit,
  calculation,
  scope,
}) {
  const issues = [];
  const conditionsById = new Map(conditions.map((condition) => [condition.id, condition]));
  const links = {
    METRIC: metricFields,
    DIMENSION: dimensionFields,
    FILTER: filterFields,
    SCOPE: scopeModifiers,
    TIME: timeWindows,
    DERIVED: derivedMetrics,
  };
  for (const condition of conditions) {
    if (condition.status === 'UNRESOLVED') {
      issues.push({
        level: 'ERROR',
        code: 'UNRESOLVED_CONDITION',
        conditionId: condition.id,
        message: `条件未解析，禁止执行: ${condition.sourceText || condition.reason || condition.id}`,
      });
      continue;
    }
    const candidates = links[condition.kind];
    if (condition.kind === 'LIMIT') {
      if (!Number.isFinite(Number(limit)) || Number(limit) <= 0) {
        issues.push({
          level: 'ERROR',
          code: 'LIMIT_NOT_RESOLVED',
          conditionId: condition.id,
          message: `行数限制未解析: ${condition.sourceText}`,
        });
      }
      continue;
    }
    if (condition.kind === 'COMPARISON') {
      const hasComparison = calculation?.type === 'PERIOD_COMPARISON'
        || timeWindows.length >= 2
        || dimensionFields.length > 0;
      if (!hasComparison) {
        issues.push({
          level: 'ERROR',
          code: 'COMPARISON_NOT_RESOLVED',
          conditionId: condition.id,
          message: `对比条件未解析: ${condition.sourceText}`,
        });
      }
      continue;
    }
    if (condition.kind === 'CALCULATION') {
      const type = String(calculation?.type ?? 'NONE').toUpperCase();
      const hasDerivedMetric = derivedMetrics.some((metric) => (
        (metric.conditionIds ?? []).includes(condition.id)
      ));
      if (type === 'NONE' && !hasDerivedMetric) {
        issues.push({
          level: 'ERROR',
          code: 'CALCULATION_NOT_RESOLVED',
          conditionId: condition.id,
          message: `计算条件未解析: ${condition.sourceText}`,
        });
      } else if (!SUPPORTED_CALCULATIONS.has(type)) {
        issues.push({
          level: 'ERROR',
          code: 'CALCULATION_UNSUPPORTED',
          conditionId: condition.id,
          message: `当前工作流不支持该计算口径: ${type}`,
        });
      }
      continue;
    }
    if (
      condition.kind === 'RESULT_ACTION'
      || condition.kind === 'OTHER'
      || condition.kind === 'ANALYSIS_STAGE'
    ) {
      continue;
    }
    if (!Array.isArray(candidates) || !candidates.some(
      (item) => item.conditionIds?.includes(condition.id),
    )) {
      issues.push({
        level: 'ERROR',
        code: 'CONDITION_BINDING_MISSING',
        conditionId: condition.id,
        message: `${condition.kind} 条件没有绑定到查询元素: ${
          condition.sourceText || condition.id
        }`,
      });
    }
  }

  for (const field of [
    ...metricFields,
    ...dimensionFields,
    ...filterFields,
    ...(derivedMetrics ?? []),
  ]) {
    for (const conditionId of field.conditionIds ?? []) {
      const condition = conditionsById.get(conditionId);
      if (!condition) {
        issues.push({
          level: 'ERROR',
          code: 'UNKNOWN_CONDITION_REFERENCE',
          message: `查询元素引用了不存在的条件: ${conditionId}`,
        });
      }
    }
  }
  return issues;
}

function validateDeterministicSignals({
  question,
  metricFields,
  derivedMetrics = [],
  dimensionFields,
  filterFields,
  availableMetrics,
  availableDimensions,
  fieldType,
  timeWindows,
  limit,
  calculation,
}) {
  const issues = [];
  const text = String(question ?? '');
  const topN = resolveTopN(text);
  if (Number.isFinite(topN) && topN > 0) {
    if (!dimensionFields.some((dimension) => dimension.isTime !== true)) {
      issues.push({
        level: 'ERROR',
        code: 'RANKING_DIMENSION_REQUIRED',
        message: `问题要求排名前 ${topN}，但契约没有业务拆解维度。`,
      });
    }
    if (Number(limit) > topN) {
      issues.push({
        level: 'ERROR',
        code: 'RANKING_LIMIT_MISMATCH',
        message: `问题要求前 ${topN} 行，但查询限制为 ${limit} 行。`,
      });
    }
  }

  const timeGrainIntent = extractTimeGrainExpression(text);
  if (timeGrainIntent) {
    const hasGrain = String(calculation?.timeGrain ?? '').toUpperCase() === timeGrainIntent.grain;
    const hasTimeDimension = dimensionFields.some((dimension) => dimension.isTime === true);
    if (!hasGrain || !hasTimeDimension) {
      issues.push({
        level: 'ERROR',
        code: 'TIME_GRAIN_NOT_RESOLVED',
        message: `问题要求按 ${timeGrainIntent.grain} 分组，但契约缺失时间维度或时间粒度。`,
      });
    }
  }

  if (
    /趋势|走势/.test(text)
    && !dimensionFields.some((dimension) => dimension.isTime === true)
  ) {
    issues.push({
      level: 'ERROR',
      code: 'TREND_TIME_DIMENSION_REQUIRED',
      message: '问题要求趋势展示，但契约没有绑定时间维度。',
    });
  }

  if (inferAnalysisMode(text).mode === 'ATTRIBUTION') {
    const hasComparison = String(calculation?.type ?? '').toUpperCase() === 'PERIOD_COMPARISON'
      || timeWindows.length >= 2;
    if (!hasComparison) {
      issues.push({
        level: 'ERROR',
        code: 'ATTRIBUTION_COMPARISON_REQUIRED',
        message: '归因分析必须提供本期与等长上期两个时间窗口，不得先反问用户对比基准。',
      });
    }
    if (!dimensionFields.some((dimension) => dimension.isTime !== true)) {
      issues.push({
        level: 'ERROR',
        code: 'ATTRIBUTION_BREAKDOWN_REQUIRED',
        message: '归因分析必须从主题提示词声明的归因维度中选择业务拆解维度，不得只返回总量。',
      });
    }
  }

  if (/对比|同比|环比|相比|vs/i.test(text)) {
    const comparisonType = String(calculation?.type ?? 'NONE').toUpperCase();
    if (comparisonType !== 'PERIOD_COMPARISON' && timeWindows.length < 2) {
      issues.push({
        level: 'ERROR',
        code: 'PERIOD_COMPARISON_NOT_RESOLVED',
        message: '问题包含对比语义，但契约没有两个以上周期或周期对比计算。',
      });
    }
  }

  const compactQuestion = compact(text);
  const thresholdSignal = /(?:低于|不超过|小于|大于|高于|不低于|不少于|超过|至少|至多)\s*-?\d/.test(text);
  if (
    thresholdSignal
    && !filterFields.some((filter) => filter.scope === 'AGGREGATE')
  ) {
    issues.push({
      level: 'ERROR',
      code: 'FILTER_THRESHOLD_NOT_BOUND',
      message: '问题包含聚合指标阈值，但契约没有绑定聚合过滤条件。',
    });
  }
  if (/分别|各自|分开/.test(text)) {
    for (const filter of filterFields) {
      if (dimensionFields.some((dimension) => dimension.field === filter.field)) {
        continue;
      }
      const dimension = (availableDimensions ?? []).find((item) => (
        canonicalField(item, fieldType) === filter.field
      ));
      if (!dimension || isDateField(dimension)) {
        continue;
      }
      dimensionFields.push({
        field: filter.field,
        requested: filter.requested,
        mappingMode: filter.mappingMode,
        matchedAlias: filter.matchedAlias,
        sourceText: filter.sourceText,
        timeGrain: '',
        isTime: false,
        ruleSource: filter.ruleSource,
        conditionIds: filter.conditionIds,
      });
    }
  }
  const selectedDimensionFields = new Set(dimensionFields.map((item) => item.field));
  const selectedFilterFields = new Set(filterFields.map((item) => item.field));
  const selectedCoreAliases = new Set(
    (availableDimensions ?? [])
      .filter((dimension) => (
        selectedDimensionFields.has(canonicalField(dimension, fieldType))
        || selectedFilterFields.has(canonicalField(dimension, fieldType))
      ))
      .flatMap((dimension) => coreAliases(dimension, fieldType)),
  );
  for (const dimension of availableDimensions ?? []) {
    if (isDateField(dimension)) {
      continue;
    }
    const field = canonicalField(dimension, fieldType);
    const mentioned = coreAliases(dimension, fieldType).some(
      (alias) => compactQuestion.includes(alias),
    );
    const coreMatched = coreAliases(dimension, fieldType).some(
      (alias) => selectedCoreAliases.has(alias),
    );
    const coveredByMoreSpecificAlias = coreAliases(dimension, fieldType).some(
      (alias) => [...selectedCoreAliases].some(
        (selectedAlias) => (
          selectedAlias.length > alias.length
          && selectedAlias.includes(alias)
        ),
      ),
    );
    if (
      mentioned
      && !selectedDimensionFields.has(field)
      && !selectedFilterFields.has(field)
      && !coreMatched
      && !coveredByMoreSpecificAlias
    ) {
      issues.push({
        level: 'ERROR',
        code: 'DIMENSION_CONDITION_MISSING',
        message: `问题提到了维度「${fieldAliases(dimension, fieldType)[0]}」，但契约没有绑定该维度或过滤条件。`,
      });
    }
  }

  return issues;
}

function validateFilterTraceability(filters, conditions, ruleSources, sourceText = '') {
  const issues = [];
  const conditionMap = new Map(conditions.map((condition) => [condition.id, condition]));
  for (const filter of filters) {
    const conditionText = (filter.conditionIds ?? [])
      .map((id) => conditionMap.get(id)?.sourceText ?? '')
      .join(' ');
    const direct = valueAppearsInText(
      filter.requestedValue ?? filter.value,
      `${filter.sourceText} ${conditionText}`,
    );
    if (direct) {
      continue;
    }
    const rule = filter.ruleSource
      || (filter.conditionIds ?? [])
        .map((id) => conditionMap.get(id)?.ruleSource ?? '')
        .find(Boolean);
    if (String(rule ?? '').startsWith('semanticPolicy:')) {
      continue;
    }
    if (!textHasRule(sourceText, rule, ruleSources)) {
      issues.push({
        level: 'ERROR',
        code: 'FILTER_RULE_NOT_TRACEABLE',
        message: `过滤值 ${JSON.stringify(filter.value)} 不在问题原文中，且没有可追溯的主题提示词规则: ${
          filter.requested || filter.field
        }`,
      });
    }
  }
  return issues;
}

function validateScopeTraceability(modifiers, ruleSources, sourceText = '') {
  const issues = [];
  for (const modifier of modifiers ?? []) {
    if (String(modifier.ruleSource ?? '').startsWith('semanticPolicy:')) {
      continue;
    }
    if (!textHasRule(sourceText, modifier.ruleSource, ruleSources)) {
      issues.push({
        level: 'ERROR',
        code: 'SCOPE_RULE_NOT_TRACEABLE',
        message: `全量范围条件没有可追溯的主题规则: ${modifier.sourceText}`,
      });
    }
  }
  return issues;
}

function buildCoverage(question, conditions) {
  return splitQuestionClauses(question).map((clause) => ({
    clause,
    ratio: isResultActionClause(clause)
      ? 1
      : conditionCoverage(clause, conditions),
  }));
}

function buildMappingProvenance({
  sourceType,
  metricFields,
  dimensionFields,
  filterFields,
}) {
  const mappings = [
    ...metricFields.map((field) => ({ kind: 'METRIC', ...field })),
    ...dimensionFields.map((field) => ({ kind: 'DIMENSION', ...field })),
    ...filterFields.map((field) => ({ kind: 'FILTER', ...field })),
  ].map((field) => ({
    kind: field.kind,
    requested: field.requested,
    field: field.field,
    matchedAlias: field.matchedAlias,
    mappingMode: field.mappingMode,
  }));
  const valueMappings = filterFields
    .filter((field) => field.valueMapping)
    .map((field) => ({
      field: field.field,
      requested: field.requested,
      ...field.valueMapping,
    }));
  const fuzzyValueMapping = valueMappings.some((mapping) => mapping.mode === 'FUZZY');
  if (sourceType === 'INDICATOR') {
    return {
      mode: 'INDICATOR_LIBRARY',
      label: '指标库口径',
      confidence: 1,
      requiresAttention: fuzzyValueMapping,
      reason: fuzzyValueMapping
        ? '指标和字段来自 Supersonic 指标库，部分过滤值通过高置信度近似枚举映射。'
        : '结果来自 Supersonic 指标库已确认的指标定义与字段。',
      fieldMappings: mappings,
      valueMappings,
    };
  }
  const fuzzyMappings = mappings.filter((mapping) => mapping.mappingMode === 'FUZZY');
  if (fuzzyMappings.length > 0) {
    return {
      mode: 'LLM_FUZZY',
      label: '大模型模糊匹配',
      confidence: 0.65,
      requiresAttention: true,
      reason: `以下字段由模型选择后通过名称或描述相似匹配到数据集：${
        fuzzyMappings.map((mapping) => `${mapping.requested} -> ${mapping.field}`).join('，')
      }`,
      fieldMappings: mappings,
      valueMappings,
    };
  }
  const aliasMappings = mappings.filter((mapping) => mapping.mappingMode === 'ALIAS');
  if (aliasMappings.length > 0) {
    return {
      mode: fuzzyValueMapping ? 'LLM_FUZZY' : 'DATASET_ALIAS',
      label: fuzzyValueMapping ? '大模型模糊匹配' : '数据集字段语义匹配',
      confidence: 0.88,
      requiresAttention: fuzzyValueMapping,
      reason: fuzzyValueMapping
        ? '过滤值通过高置信度近似枚举映射到数据集字段值域。'
        : '结果使用业务数据集，字段通过已登记名称或显示名完成匹配。',
      fieldMappings: mappings,
      valueMappings,
    };
  }
  if (fuzzyValueMapping) {
    return {
      mode: 'LLM_FUZZY',
      label: '大模型模糊匹配',
      confidence: 0.72,
      requiresAttention: true,
      reason: '过滤值通过高置信度近似枚举映射到数据集字段值域。',
      fieldMappings: mappings,
      valueMappings,
    };
  }
  return {
    mode: 'DATASET_EXACT',
    label: '数据集字段精确匹配',
    confidence: 1,
    requiresAttention: false,
    reason: '结果直接使用业务数据集中精确匹配的指标和维度字段。',
    fieldMappings: mappings,
    valueMappings,
  };
}

function validatePostProcessing({
  postProcessing,
  sourceType,
  metricFields,
  dimensionFields,
  metricAvailable,
  dimensionAvailable,
  fieldType,
  metricType,
  issues,
}) {
  if (!postProcessing) {
    return;
  }
  if (sourceType !== 'BUSINESS_DATASET') {
    issues.push({
      level: 'ERROR',
      code: 'POST_PROCESSING_REQUIRES_DATASET',
      message: '值归并、同比计算和透视输出必须使用业务数据集查询。',
    });
    return;
  }
  const dimensions = dimensionAvailable.filter((field) => field.role !== 'METRIC');
  const selectedMetrics = new Set(metricFields.map((field) => field.field));
  const selectedDimensions = new Set(dimensionFields.map((field) => field.field));
  const groupedField = postProcessing.groupValues?.outputField;
  if (postProcessing.groupValues) {
    const resolved = resolveField(
      postProcessing.groupValues.field,
      dimensions,
      fieldType,
    );
    if (resolved) {
      postProcessing.groupValues.field = canonicalField(resolved, fieldType);
    }
    if (!resolved || !selectedDimensions.has(canonicalField(resolved, fieldType))) {
      issues.push({
        level: 'ERROR',
        code: 'POST_PROCESSING_GROUP_FIELD_UNRESOLVED',
        message: `值归并字段无法映射到当前数据集: ${postProcessing.groupValues.field ?? '-'}`,
      });
    }
    if (!String(postProcessing.groupValues.outputField ?? '').trim()) {
      issues.push({
        level: 'ERROR',
        code: 'POST_PROCESSING_GROUP_OUTPUT_REQUIRED',
        message: '值归并缺少 outputField。',
      });
    }
  }
  if (postProcessing.periodComparison) {
    const resolved = resolveField(
      postProcessing.periodComparison.metric,
      metricAvailable,
      metricType,
    );
    if (resolved) {
      postProcessing.periodComparison.metric = canonicalField(resolved, metricType);
    }
    if (!resolved || !selectedMetrics.has(canonicalField(resolved, metricType))) {
      issues.push({
        level: 'ERROR',
        code: 'POST_PROCESSING_COMPARISON_METRIC_UNRESOLVED',
        message: `同比计算字段无法映射到当前数据集指标: ${postProcessing.periodComparison.metric ?? '-'}`,
      });
    }
    if (!String(postProcessing.periodComparison.outputField ?? '').trim()) {
      issues.push({
        level: 'ERROR',
        code: 'POST_PROCESSING_COMPARISON_OUTPUT_REQUIRED',
        message: '同比计算缺少 outputField。',
      });
    }
    const comparisonRowFields = postProcessing.periodComparison.rowFields;
    if (Array.isArray(comparisonRowFields) && comparisonRowFields.length > 0) {
      postProcessing.periodComparison.rowFields = comparisonRowFields.map((fieldName) => {
        const rowField = resolveField(fieldName, dimensions, fieldType);
        if (rowField) {
          return canonicalField(rowField, fieldType);
        }
        return String(fieldName ?? '').trim() === String(groupedField ?? '').trim()
          ? groupedField
          : fieldName;
      });
    }
  }
  if (postProcessing.pivot) {
    postProcessing.pivot.rowFields = (postProcessing.pivot.rowFields ?? []).map((fieldName) => {
      const resolved = resolveField(fieldName, dimensions, fieldType);
      if (!resolved || !selectedDimensions.has(canonicalField(resolved, fieldType))) {
        issues.push({
          level: 'ERROR',
          code: 'POST_PROCESSING_PIVOT_ROW_UNRESOLVED',
          message: `透视行字段无法映射到当前数据集: ${fieldName}`,
        });
      }
      return resolved ? canonicalField(resolved, fieldType) : fieldName;
    });
    const columnField = String(postProcessing.pivot.columnField ?? '').trim();
    const resolvedColumn = resolveField(columnField, dimensions, fieldType);
    if (resolvedColumn) {
      postProcessing.pivot.columnField = canonicalField(resolvedColumn, fieldType);
    }
    if (
      !columnField
      || (!resolvedColumn && columnField !== groupedField)
    ) {
      issues.push({
        level: 'ERROR',
        code: 'POST_PROCESSING_PIVOT_COLUMN_UNRESOLVED',
        message: `透视列字段无法映射到当前数据集: ${columnField || '-'}`,
      });
    }
    const comparisonOutput = String(
      postProcessing.periodComparison?.outputField ?? '',
    ).trim();
    postProcessing.pivot.valueFields = (postProcessing.pivot.valueFields ?? []).map((valueField) => {
      const fieldName = typeof valueField === 'string'
        ? valueField
        : valueField?.field;
      const resolved = resolveField(fieldName, metricAvailable, metricType);
      if (
        !resolved
        && String(fieldName ?? '').trim() !== comparisonOutput
      ) {
        issues.push({
          level: 'ERROR',
          code: 'POST_PROCESSING_PIVOT_VALUE_UNRESOLVED',
          message: `透视值字段无法映射到当前数据集: ${fieldName ?? '-'}`,
        });
      }
      const normalizedField = resolved
        ? canonicalField(resolved, metricType)
        : fieldName;
      return typeof valueField === 'string'
        ? normalizedField
        : { ...valueField, field: normalizedField };
    });
  }
}

function validateAnalysisPipeline({
  question,
  pipeline,
  issues,
}) {
  if (!pipeline) {
    return;
  }
  const stages = pipeline.stages ?? [];
  const consecutiveMonths = String(question ?? '').match(
    /连续\s*(\d+|[一二两三四五六七八九十]+)\s*个?\s*月/,
  );
  if (consecutiveMonths) {
    const requiredMonths = parseChineseNumber(consecutiveMonths[1]);
    const countOutputs = stages
      .filter((stage) => stage.type === 'ROLLUP')
      .flatMap((stage) => stage.outputs ?? [])
      .filter((output) => output.type === 'COUNT_IF' && output.outputField);
    const thresholdFilters = stages
      .filter((stage) => stage.type === 'FILTER')
      .flatMap((stage) => stage.predicate?.conditions ?? [])
      .filter((condition) => (
        countOutputs.some((output) => output.outputField === condition.field)
      ));
    const satisfied = thresholdFilters.some((condition) => {
      const threshold = Number(condition.value);
      return Number.isFinite(threshold)
        && ['>=', '=', '>'].includes(String(condition.operator).toUpperCase())
        && threshold >= requiredMonths;
    });
    if (!satisfied) {
      issues.push({
        level: 'ERROR',
        code: 'ANALYSIS_PIPELINE_QUALIFICATION_DEGRADED',
        phase: 'PLAN',
        message: `用户要求连续 ${requiredMonths} 个月满足条件，分析管线必须保留该最终资格阈值，不得为了返回结果降级为更少月数。`,
      });
    }
  }

  const topN = resolveTopN(question);
  if (Number.isFinite(topN) && topN > 0) {
    const finalLimit = [...stages].reverse().find((stage) => stage.type === 'LIMIT');
    if (!finalLimit) {
      issues.push({
        level: 'ERROR',
        code: 'ANALYSIS_PIPELINE_TOP_N_MISSING',
        phase: 'PLAN',
        message: `问题要求前 ${topN} 行，分析管线缺少最终 LIMIT 阶段。`,
      });
    } else if (Number(finalLimit.value) !== topN) {
      issues.push({
        level: 'ERROR',
        code: 'ANALYSIS_PIPELINE_TOP_N_MISMATCH',
        phase: 'PLAN',
        message: `问题要求前 ${topN} 行，分析管线最终 LIMIT 为 ${finalLimit.value} 行。`,
      });
    }
  }
}

function validateBindingTextCoverage(question, {
  conditions,
  metricFields,
  dimensionFields,
  filterFields,
  scopeModifiers,
  timeWindows,
  skipResidual = false,
}) {
  const issues = [];
  const bindingSources = [
    ...metricFields,
    ...dimensionFields,
    ...filterFields,
    ...scopeModifiers,
    ...timeWindows,
  ].map((item) => String(item.sourceText ?? '').trim()).filter(Boolean);
  const conditionSources = conditions
    .map((condition) => String(condition.sourceText ?? '').trim())
    .filter(Boolean);
  for (const item of [
    ...metricFields,
    ...dimensionFields,
    ...filterFields,
    ...scopeModifiers,
    ...timeWindows,
  ]) {
    if (!String(item.sourceText ?? '').trim()) {
      issues.push({
        level: 'ERROR',
        code: 'BINDING_SOURCE_REQUIRED',
        message: `查询元素缺少问题原文绑定: ${item.field || item.id || '-'}`,
      });
    }
  }
  for (const source of bindingSources) {
    if (!compact(question).includes(compact(source))) {
      issues.push({
        level: 'ERROR',
        code: 'BINDING_SOURCE_NOT_IN_QUESTION',
        message: `查询元素引用了问题中不存在的原文: ${source}`,
      });
    }
  }
  if (skipResidual) {
    return issues;
  }
  const structuralSources = conditions
    .filter((condition) => (
      ['LIMIT', 'COMPARISON', 'CALCULATION'].includes(condition.kind)
      && condition.status !== 'UNRESOLVED'
    ))
    .map((condition) => condition.sourceText)
    .filter(Boolean);
  const nonQuerySources = conditions
    .filter((condition) => (
      condition.kind === 'RESULT_ACTION'
      || (condition.kind === 'OTHER' && condition.status === 'NOT_APPLICABLE')
    ))
    .map((condition) => condition.sourceText)
    .filter(Boolean);
  for (const clause of splitQuestionClauses(question)) {
    if (isResultActionClause(clause)) {
      continue;
    }
    let residual = compact(clause);
    const clauseBindings = [...bindingSources, ...conditionSources].filter(
      (source) => residual.includes(compact(source)),
    );
    const applicableSources = [
      ...clauseBindings,
      ...structuralSources.filter((source) => residual.includes(compact(source))),
      ...nonQuerySources.filter((source) => residual.includes(compact(source))),
    ];
    for (const source of [...new Set(applicableSources)].sort(
      (left, right) => compact(right).length - compact(left).length,
    )) {
      residual = residual.split(compact(source)).join('');
    }
    residual = residual.replace(
      new RegExp(QUESTION_FILLER_PATTERN, 'gi'),
      '',
    );
    if (residual.length >= 2) {
      issues.push({
        level: 'ERROR',
        code: 'QUESTION_RESIDUE_NOT_BOUND',
        message: `问题片段存在未绑定条件: ${clause}（残留：${residual}）`,
      });
    }
  }
  return issues;
}

export class QueryContractCompiler {
  compile({
    question,
    sourceType,
    indicator = null,
    dataset = null,
    availableMetrics = [],
    availableDimensions = [],
    datasetFields = [],
    theme = {},
    scope = {},
    draft = {},
    now = new Date(),
    sourceContext = '',
  }) {
    const normalizedSourceType = String(sourceType ?? draft.sourceType ?? '').toUpperCase();
    const analysisMode = inferAnalysisMode(question);
    const timeGrainIntent = extractTimeGrainExpression(question);
    const issues = [];
    const semanticPolicyApplication = applySemanticPolicy({
      question,
      policy: theme.semanticPolicy,
      draft,
    });
    draft = {
      ...semanticPolicyApplication.draft,
      conditions: [...(semanticPolicyApplication.draft.conditions ?? [])],
    };
    const semanticProfile = classifyAnalysisSemantics(question, now);
    const conditions = draft.conditions.map(normalizeCondition);
    const semanticCompletion = completePlatformSemanticConditions(
      semanticProfile,
      conditions,
    );
    auditSemanticCategories(semanticProfile, conditions, issues);
    if (conditions.length === 0) {
      issues.push({
        level: 'ERROR',
        code: 'CONDITION_LEDGER_REQUIRED',
        message: '查询契约必须包含逐项条件账本。',
      });
    }

    const metricAvailable = normalizedSourceType === 'BUSINESS_DATASET'
      ? datasetFields.filter((field) => field.role === 'METRIC')
      : availableMetrics;
    const dimensionAvailable = normalizedSourceType === 'BUSINESS_DATASET'
      ? datasetFields
      : availableDimensions;
    const fieldType = normalizedSourceType === 'BUSINESS_DATASET'
      ? 'DATASET'
      : 'DIMENSION';
    const metricType = normalizedSourceType === 'BUSINESS_DATASET'
      ? 'DATASET'
      : 'METRIC';

    let metricFields = normalizeMetricFields(
      draft.metricFields ?? draft.metrics,
      metricAvailable,
      issues,
      metricType,
    );
    let derivedMetrics = normalizeDerivedMetrics(
      draft.derivedMetrics,
      (requested) => canonicalField(
        resolveField(requested, metricAvailable, metricType),
        metricType,
      ),
    );
    if (
      Array.isArray(draft.derivedMetrics)
      && draft.derivedMetrics.length !== derivedMetrics.length
    ) {
      issues.push({
        level: 'ERROR',
        code: 'DERIVED_METRIC_INVALID',
        message: '存在无法解析的派生指标定义。',
      });
    }
    for (const definition of derivedMetrics) {
      for (const operand of definition.operands ?? [definition.left, definition.right].filter(Boolean)) {
        if (
          operand.source !== 'DERIVED'
          && !metricFields.some((metric) => metric.field === operand.field)
        ) {
          metricFields.push({
            field: operand.field,
            requested: operand.field,
            mappingMode: 'DERIVED',
            matchedAlias: operand.field,
            sourceText: definition.name,
            aggregator: operand.aggregator ?? 'SUM',
            conditionIds: definition.conditionIds ?? [],
            internal: true,
          });
        }
      }
    }
    let dimensionFields = normalizeDimensionFields(
      draft.dimensionFields ?? draft.dimensions,
      dimensionAvailable.filter((field) => field.role !== 'METRIC'),
      issues,
      fieldType,
    );
    const requiresPreferredDatasetTimeField = (
      normalizedSourceType === 'BUSINESS_DATASET'
      && (
        Boolean(timeGrainIntent)
        || analysisMode.mode === 'TREND'
      )
    );
    if (requiresPreferredDatasetTimeField) {
      const preferredTimeField = resolveTimeField(
        dimensionAvailable.filter((field) => field.role !== 'METRIC'),
      );
      if (preferredTimeField) {
        const existingTimeDimension = dimensionFields.find(
          (dimension) => dimension.isTime,
        );
        const field = canonicalField(preferredTimeField, fieldType);
        dimensionFields = dimensionFields.filter(
          (dimension) => !dimension.isTime,
        );
        dimensionFields.unshift({
          field,
          requested: field,
          mappingMode: 'EXACT',
          matchedAlias: fieldAliases(preferredTimeField, fieldType)[0] ?? field,
          sourceText: existingTimeDimension?.sourceText
            ?? timeGrainIntent?.sourceText
            ?? analysisMode.sourceText,
          timeGrain: timeGrainIntent?.grain ?? existingTimeDimension?.timeGrain ?? '',
          isTime: true,
          conditionIds: existingTimeDimension?.conditionIds ?? [],
        });
      }
    }
    if (timeGrainIntent) {
      const timeDimension = dimensionFields.find((dimension) => dimension.isTime);
      if (timeDimension) {
        timeDimension.timeGrain = timeGrainIntent.grain;
        if (!timeDimension.sourceText) {
          timeDimension.sourceText = timeGrainIntent.sourceText;
        }
      } else {
        const timeField = resolveTimeField(
          dimensionAvailable.filter((field) => field.role !== 'METRIC'),
        );
        if (timeField) {
          const field = canonicalField(timeField, fieldType);
          dimensionFields.push({
            field,
            requested: field,
            mappingMode: 'EXACT',
            matchedAlias: fieldAliases(timeField, fieldType)[0] ?? field,
            sourceText: timeGrainIntent.sourceText,
            timeGrain: timeGrainIntent.grain,
            isTime: true,
            conditionIds: [],
          });
        }
      }
    }
    if (analysisMode.mode === 'ATTRIBUTION') {
      let attributionCondition = conditions.find((condition) => (
        condition.kind === 'RESULT_ACTION'
        && inferAnalysisMode(condition.sourceText).mode === 'ATTRIBUTION'
      ));
      if (!attributionCondition) {
        attributionCondition = {
          id: `attribution-${conditions.length + 1}`,
          sourceText: analysisMode.sourceText || '原因',
          kind: 'RESULT_ACTION',
          status: 'RESOLVED',
          reason: '识别为归因分析要求',
          ruleSource: '平台通用归因意图识别',
        };
        conditions.push(attributionCondition);
      }
      for (const dimension of dimensionFields.filter((item) => item.isTime !== true)) {
        if (!dimension.sourceText) {
          dimension.sourceText = attributionCondition.sourceText;
        }
        dimension.conditionIds = [
          ...new Set([
            ...(dimension.conditionIds ?? []),
            attributionCondition.id,
          ]),
        ];
      }
    }
    const derivedFilterFields = derivedMetrics.map((definition) => ({
      fieldName: definition.outputField,
      displayName: definition.name,
      role: 'METRIC',
      aggregator: 'DERIVED',
    }));
    let filterFields = normalizeFilters(
      draft.filterFields ?? draft.filters,
      [...dimensionAvailable, ...derivedFilterFields],
      issues,
      fieldType,
    );
    filterFields = dedupeFilters(filterFields);
    let scopeModifiers = normalizeScopeModifiers(
      draft.scopeModifiers ?? draft.scopeFields,
    );
    const timeField = resolveTimeField(dimensionAvailable);
    let timeWindows = normalizeTimeWindows(draft.timeWindows ?? draft.dateWindows, timeField);
    const timeBinding = bindMentionWindows(question, timeWindows, now, conditions);
    timeWindows = timeBinding.windows;
    issues.push(...timeBinding.issues);

    if (timeBinding.mentions.length > 0 && !timeField) {
      issues.push({
        level: 'ERROR',
        code: 'TIME_FIELD_UNAVAILABLE',
        message: '问题包含时间条件，但当前语义对象没有可用时间字段。',
      });
    }
    if (analysisMode.mode === 'ATTRIBUTION' && timeWindows.length > 0) {
      const previousWindow = buildPreviousAlignedWindow(timeWindows[0]);
      if (previousWindow && timeBinding.mentions.length <= 1) {
        previousWindow.conditionIds = [
          ...new Set([
            ...(timeWindows[0].conditionIds ?? []),
            ...(timeWindows[1]?.conditionIds ?? []),
          ]),
        ];
        if (timeWindows.length === 1) {
          timeWindows.push(previousWindow);
        } else {
          timeWindows[1] = {
            ...timeWindows[1],
            ...previousWindow,
            id: timeWindows[1].id ?? previousWindow.id,
            label: timeWindows[1].label || previousWindow.label,
            expression: timeWindows[1].expression || previousWindow.expression,
          };
        }
      }
    }

    metricFields = inferConditionBindings(
      conditions,
      metricFields.map((field) => ({ ...field, kind: 'METRIC' })),
    ).map(({ kind, ...field }) => field);
    dimensionFields = inferConditionBindings(
      conditions,
      dimensionFields.map((field) => ({ ...field, kind: 'DIMENSION' })),
    ).map(({ kind, ...field }) => field);
    filterFields = inferConditionBindings(
      conditions,
      filterFields.map((field) => ({ ...field, kind: 'FILTER' })),
    ).map(({ kind, ...field }) => field);
    derivedMetrics = inferConditionBindings(
      conditions,
      derivedMetrics.map((metric) => ({ ...metric, kind: 'DERIVED' })),
    ).map(({ kind, ...metric }) => metric);
    scopeModifiers = inferConditionBindings(
      conditions,
      scopeModifiers.map((modifier) => ({ ...modifier, kind: 'SCOPE' })),
    ).map(({ kind, ...modifier }) => modifier);
    timeWindows = inferConditionBindings(
      conditions,
      timeWindows.map((window) => ({ ...window, kind: 'TIME' })),
    ).map(({ kind, ...window }) => window);
    const postProcessing = normalizePostProcessing(draft.postProcessing);
    const analysisPipeline = normalizeAnalysisPipeline(draft.analysisPipeline);
    if (
      draft.analysisPipeline
      && typeof draft.analysisPipeline === 'object'
      && !analysisPipeline
    ) {
      issues.push({
        level: 'ERROR',
        code: 'ANALYSIS_PIPELINE_INVALID',
        message: '分析流水线配置无效，必须至少包含一个受支持的通用算子阶段。',
      });
    }
    if (analysisPipeline && normalizedSourceType !== 'BUSINESS_DATASET') {
      issues.push({
        level: 'ERROR',
        code: 'ANALYSIS_PIPELINE_REQUIRES_DATASET',
        message: '通用分析管线只能应用于业务数据集查询。',
      });
    }
    validatePostProcessing({
      postProcessing,
      sourceType: normalizedSourceType,
      metricFields,
      derivedMetrics,
      dimensionFields,
      metricAvailable,
      dimensionAvailable,
      fieldType,
      metricType,
      issues,
    });
    validateAnalysisPipeline({
      question,
      pipeline: analysisPipeline,
      issues,
    });

    const limit = Math.max(
      1,
      Math.min(
        analysisPipeline
          ? 50000
          : semanticCompletion.rankLimit
          || Number(draft.limit)
          || Number(draft.topN)
          || 200,
        analysisPipeline ? 50000 : 2000,
      ),
    );
    const requestedCalculationType = String(
      draft.calculation?.type ?? draft.calculationType ?? 'NONE',
    ).toUpperCase();
    const hasOrderedComparisonWindows = [
      'PERIOD_COMPARISON',
    ].includes(requestedCalculationType) && timeWindows.length >= 2;
    const calculation = {
      type: analysisMode.mode === 'ATTRIBUTION' && timeWindows.length >= 2
        ? 'PERIOD_COMPARISON'
        : requestedCalculationType,
      baseWindowIndex: hasOrderedComparisonWindows
        ? 0
        : draft.calculation?.baseWindowIndex
          ?? (analysisMode.mode === 'ATTRIBUTION' ? 0 : null),
      compareWindowIndex: hasOrderedComparisonWindows
        ? 1
        : draft.calculation?.compareWindowIndex
          ?? (analysisMode.mode === 'ATTRIBUTION' ? 1 : null),
      description: String(draft.calculation?.description ?? '').trim(),
    };
    const timeGrain = String(
      timeGrainIntent?.grain
      ?? draft.timeGrain
      ?? dimensionFields.find((dimension) => isDateField(dimension))?.timeGrain
      ?? '',
    ).toUpperCase();
    calculation.timeGrain = TIME_GRAINS.has(timeGrain) ? timeGrain : null;

    const order = (draft.order ?? []).map((item) => {
      const datasetOrder = normalizedSourceType === 'BUSINESS_DATASET';
      let resolved = resolveField(
        item?.field,
        datasetOrder ? datasetFields : availableMetrics,
        datasetOrder ? 'DATASET' : 'METRIC',
      );
      if (!resolved && !datasetOrder) {
        resolved = resolveField(item?.field, availableDimensions, 'DIMENSION');
      }
      return {
        field: canonicalField(
          resolved,
          datasetOrder ? 'DATASET' : (
            availableMetrics.includes(resolved) ? 'METRIC' : 'DIMENSION'
          ),
        ),
        direction: String(item?.direction ?? 'DESC').toUpperCase() === 'ASC'
          ? 'ASC'
          : 'DESC',
      };
    }).filter((item) => item.field);

    const ruleSources = [
      theme.systemPrompt,
      theme.description,
      indicator?.businessCaliber,
      indicator?.description,
      ...(indicator?.metrics ?? []).flatMap((metric) => [
        metric.metricName,
        metric.name,
        metric.description,
      ]),
      ...(indicator?.dimensions ?? []).flatMap((dimension) => [
        dimension.dimensionName,
        dimension.name,
        dimension.description,
      ]),
      ...(datasetFields ?? []).flatMap((field) => [
        field.displayName,
        field.description,
      ]),
    ].filter(Boolean);

    issues.push(...validateConditionBindings(conditions, {
      metricFields,
      derivedMetrics,
      dimensionFields,
      filterFields,
      scopeModifiers,
      timeWindows,
      limit,
      calculation,
      scope,
    }));
    const deterministicIssues = validateDeterministicSignals({
      question,
      metricFields,
      derivedMetrics,
      dimensionFields,
      filterFields,
      availableMetrics: metricAvailable,
      availableDimensions: dimensionAvailable.filter((field) => field.role !== 'METRIC'),
      fieldType,
      timeWindows,
      limit,
      calculation,
    });
    const pipelineExemptCodes = new Set([
      'RANKING_DIMENSION_REQUIRED',
      'RANKING_LIMIT_MISMATCH',
      'TIME_GRAIN_NOT_RESOLVED',
      'FILTER_THRESHOLD_NOT_BOUND',
    ]);
    issues.push(...(
      analysisPipeline
        ? deterministicIssues.filter((issue) => !pipelineExemptCodes.has(issue.code))
        : deterministicIssues
    ));
    const bindingText = String(sourceContext || question || '').trim();
    issues.push(...validateFilterTraceability(
      analysisPipeline
        ? filterFields.filter((filter) => filter.scope !== 'AGGREGATE')
        : filterFields,
      conditions,
      ruleSources,
      bindingText,
    ));
    issues.push(...validateScopeTraceability(
      scopeModifiers,
      ruleSources,
      bindingText,
    ));
    issues.push(...validateBindingTextCoverage(bindingText, {
      conditions,
      metricFields,
      derivedMetrics,
      dimensionFields,
      filterFields,
      scopeModifiers,
      timeWindows,
      skipResidual: Boolean(postProcessing) || Boolean(analysisPipeline),
    }));

    if (metricFields.length === 0) {
      issues.push({
        level: 'ERROR',
        code: 'METRIC_REQUIRED',
        message: '查询契约未绑定任何指标字段。',
      });
    }
    if (normalizedSourceType === 'INDICATOR' && !indicator) {
      issues.push({
        level: 'ERROR',
        code: 'INDICATOR_REQUIRED',
        message: '指标查询缺少已确认的指标对象。',
      });
    }
    if (normalizedSourceType === 'BUSINESS_DATASET' && !dataset) {
      issues.push({
        level: 'ERROR',
        code: 'DATASET_REQUIRED',
        message: '业务数据集查询缺少已确认的数据集对象。',
      });
    }

    const coverage = postProcessing || analysisPipeline
      ? []
      : buildCoverage(bindingText, conditions);
    for (const item of coverage) {
      if (item.ratio < 0.72) {
        issues.push({
          level: 'ERROR',
          code: 'QUESTION_CLAUSE_NOT_COVERED',
          message: `问题片段未被条件账本完整覆盖: ${item.clause}`,
        });
      }
    }

    const mappingProvenance = buildMappingProvenance({
      sourceType: normalizedSourceType,
      metricFields,
      dimensionFields,
      filterFields,
    });
    const semanticResolutions = semanticPolicyApplication.matches
      .filter((item) => item.category === 'METRIC')
      .map((item) => resolveWithPlugins({
        concept: item.concept,
        candidates: metricAvailable,
        policy: theme.semanticPolicy,
      }));
    const fuzzyMappings = [
      ...mappingProvenance.fieldMappings,
      ...mappingProvenance.valueMappings,
    ].filter((mapping) => mapping.mappingMode === 'FUZZY' || mapping.mode === 'FUZZY');
    if (
      fuzzyMappings.length > 0
      && semanticPolicyApplication.policy.policies.allowFuzzyMapping !== true
    ) {
      issues.push({
        level: 'ERROR',
        code: 'SEMANTIC_MAPPING_AMBIGUOUS',
        message: `存在未受语义包允许的模糊映射: ${
          fuzzyMappings.map((mapping) => (
            mapping.requested || mapping.field || mapping.resolved?.join?.('、') || '-'
          )).join('、')
        }；请补充业务语义包规则或改为明确字段。`,
      });
    }
    const contract = {
      version: 1,
      compilerVersion: CONTRACT_COMPILER_VERSION,
      id: crypto.randomUUID(),
      sourceType: normalizedSourceType,
      question: String(question ?? '').trim(),
      indicatorId: indicator ? String(indicator.id) : null,
      datasetId: dataset ? Number(dataset.id) : null,
      conditions,
      metricFields,
      internalMetrics: metricFields
        .filter((field) => field.internal === true)
        .map((field) => field.field),
      derivedMetrics,
      dimensionFields,
      filterFields,
      scopeModifiers,
      timeWindows,
      timeGrain: calculation.timeGrain,
      limit,
      order,
      calculation,
      postProcessing,
      analysisPipeline,
      provenance: mappingProvenance,
      coverage,
      semanticCoverage: buildSemanticCoverage(
        semanticProfile,
        conditions,
        [
          ...semanticCompletion.added.map((condition) => condition.id),
          ...timeBinding.addedConditions.map((condition) => condition.id),
        ],
        timeBinding.addedWindowExpressions,
      ),
      semanticPolicy: {
        matches: semanticPolicyApplication.matches,
        allowFuzzyMapping: semanticPolicyApplication.policy.policies.allowFuzzyMapping,
      },
      semanticResolutions,
      createdAt: new Date().toISOString(),
      fieldType,
      metricType,
      analysisMode: analysisMode.mode,
      attribution: analysisMode.mode === 'ATTRIBUTION'
        ? {
          comparisonPolicy: 'PROMPT_FIRST_ALIGNED_PREVIOUS_PERIOD',
          requireBreakdown: true,
          clarificationPolicy: 'SINGLE_BATCH_ONLY_IF_RULES_MISSING',
        }
        : null,
    };

    const gatedIssues = attachGateMetadata(issues);
    contract.gateSummary = summarizeGateIssues(gatedIssues);
    return {
      id: contract.id,
      valid: !gatedIssues.some((issue) => issue.level === 'ERROR'),
      issues: gatedIssues,
      contract,
    };
  }

  review(contract, {
    indicator = null,
    dataset = null,
    theme = {},
    scope = {},
  } = {}) {
    const issues = [];
    if (!contract) {
      return {
        valid: false,
        issues: [{
          level: 'ERROR',
          code: 'QUERY_CONTRACT_REQUIRED',
          message: '执行查询前必须先编译查询契约。',
        }],
      };
    }
    if (contract.sourceType === 'INDICATOR' && !indicator) {
      issues.push({
        level: 'ERROR',
        code: 'INDICATOR_REQUIRED',
        message: '执行指标查询前必须确认指标定义。',
      });
    }
    if (contract.sourceType === 'BUSINESS_DATASET' && !dataset) {
      issues.push({
        level: 'ERROR',
        code: 'DATASET_REQUIRED',
        message: '执行业务数据集查询前必须确认数据集定义。',
      });
    }
    if (!SUPPORTED_CALCULATIONS.has(
      String(contract.calculation?.type ?? 'NONE').toUpperCase(),
    )) {
      issues.push({
        level: 'ERROR',
        code: 'CALCULATION_UNSUPPORTED',
        message: '查询契约包含不支持的派生计算。',
      });
    }
    if (
      contract.calculation?.type === 'PERIOD_COMPARISON'
      && (contract.timeWindows ?? []).length < 2
    ) {
      issues.push({
        level: 'ERROR',
        code: 'COMPARISON_WINDOWS_REQUIRED',
        message: '周期对比至少需要两个时间窗口。',
      });
    }
    if (
      contract.analysisMode === 'ATTRIBUTION'
      && !(contract.dimensionFields ?? []).some((dimension) => dimension.isTime !== true)
    ) {
      issues.push({
        level: 'ERROR',
        code: 'ATTRIBUTION_BREAKDOWN_REQUIRED',
        message: '归因查询契约缺少业务拆解维度。',
      });
    }
    if (!scope?.unrestrictedDimensions && scope?.allowedDimensions?.length) {
      const allowed = new Set(scope.allowedDimensions.map(compact));
      for (const dimension of contract.dimensionFields ?? []) {
        if (!allowed.has(compact(dimension.field))) {
          issues.push({
            level: 'ERROR',
            code: 'CONTRACT_DIMENSION_NOT_ALLOWED',
            message: `契约维度不在主题白名单中: ${dimension.field}`,
          });
        }
      }
    }
    const gatedIssues = attachGateMetadata(issues);
    return {
      valid: !gatedIssues.some((issue) => issue.level === 'ERROR'),
      issues: gatedIssues,
      gateSummary: summarizeGateIssues(gatedIssues),
      checkedAt: new Date().toISOString(),
    };
  }
}

export {
  canonicalField,
  isDateField,
  isResultActionClause,
  resolveField,
  splitQuestionClauses,
};
