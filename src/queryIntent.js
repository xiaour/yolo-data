import { normalizeBusinessTerm } from './indicatorSearch.js';

const CONTEXTUAL_QUESTION_PATTERN =
  /^(那|再|换|按|这个|上述|它|还有|呢|以及|和|同上|本月|这个月|上月|上个月|本周|这周|上周|今天|今日|昨天|今年|去年|本季度|上季度|近\s*\d+|最近\s*\d+)|在.{0,12}基础上|这个表|上述表|上表|以上|保留上文|现有基础/;
const EXPLICIT_REFERENCE_PATTERN =
  /上表|上述表|这个表|该表|上一轮|刚才|前面|上述结果|基于以上|在此基础上|保留上文|现有基础/;
const RESULT_OPERATION_PATTERN =
  /加入一行|新增一行|增加一行|加入一列|新增一列|增加一列|按单独列|修改列名|调整格式|保留.*数据|转换成\s*Excel|导出\s*Excel|改成.*图|坐标轴|排序/;
const CLARIFICATION_PATTERN =
  /请补充|请确认|需要确认|请指定|请提供|还差|无法唯一确定|请明确|需要先明确|需要您|请选择|是否确认|需确认/;
const METRIC_INTENT_PATTERN =
  /多少|数量|金额|额度|数值|[额量率数值]|比例|占比|合计|总计|平均|最大|最小|排名|对比|同比|环比|趋势|走势/;
const TIME_INTENT_PATTERN =
  /本月|这个月|上月|上个月|本周|这周|上周|今天|今日|昨天|今年|去年|本季度|上季度|近\s*\d+|最近\s*\d+|\d{4}年/;
const FILTER_INTENT_PATTERN =
  /按|各|分|维度|分组|筛选|过滤|展示/;
const ATTRIBUTION_PATTERN =
  /具体原因|原因|为何|为什么|归因|驱动因素|影响因素|主因|上升还是下滑|上升或下滑|增长原因|下滑原因|下降原因|拉动因素|影响来源/;
const ARTIFACT_REFRESH_PATTERN =
  /重新(?:查询|取数|拉取)|刷新|最新数据|重查|再查一次/;

function text(question) {
  return normalizeBusinessTerm(question);
}

function compact(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '').trim();
}

function fieldAliases(field) {
  return [
    field?.fieldName,
    field?.displayName,
    field?.name,
    field?.bizName,
  ].filter(Boolean).map((value) => text(value));
}

function includesAny(source, values) {
  return values.some((value) => value && source.includes(value));
}

function resolveTopN(question) {
  const match = String(question ?? '').match(
    /(?:top\s*(\d+)|前\s*(\d+)|排名前\s*(\d+))/i,
  );
  const value = Number(match?.[1] ?? match?.[2] ?? match?.[3]);
  return Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(value, 2000))
    : null;
}

const TIME_GRAIN_PATTERNS = [
  [
    'WEEK',
    /(?:按(?:照)?)?每(?:一)?个?(?:周|星期)|按周|周维度|周分组|逐周|周趋势/,
  ],
  [
    'MONTH',
    /(?:按(?:照)?)?每(?:一)?个?月|按月|月度|月维度|月分组|逐月|月趋势/,
  ],
  [
    'QUARTER',
    /(?:按(?:照)?)?每(?:一)?个?季度|按季度|季度维度|季度分组|逐季度|季度趋势/,
  ],
  [
    'YEAR',
    /(?:按(?:照)?)?每(?:一)?个?年|按年|年度|年维度|年分组|逐年|年趋势/,
  ],
  [
    'DAY',
    /每天|每日|每一天|按日|日维度|日分组|逐日|日趋势/,
  ],
];

export function extractTimeGrainExpression(question) {
  const source = text(question);
  for (const [grain, pattern] of TIME_GRAIN_PATTERNS) {
    const match = source.match(pattern);
    if (match) {
      return { grain, sourceText: match[0] };
    }
  }
  return null;
}

export function inferTimeGrain(question) {
  return extractTimeGrainExpression(question)?.grain ?? null;
}

export function inferAnalysisMode(question) {
  const source = text(question);
  const attributionMatch = source.match(ATTRIBUTION_PATTERN);
  if (attributionMatch) {
    return {
      mode: 'ATTRIBUTION',
      sourceText: attributionMatch[0],
      requiresComparison: true,
      requiresBreakdown: true,
    };
  }
  if (/趋势|走势/.test(source)) {
    return {
      mode: 'TREND',
      sourceText: source.match(/趋势|走势/)?.[0] ?? '',
      requiresComparison: false,
      requiresBreakdown: false,
    };
  }
  return {
    mode: 'METRIC_QUERY',
    sourceText: '',
    requiresComparison: false,
    requiresBreakdown: false,
  };
}

export function resolveClarificationPolicy(history = [], analysisMode = 'METRIC_QUERY') {
  let used = 0;
  for (let index = (history ?? []).length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== 'assistant') {
      break;
    }
    if (!CLARIFICATION_PATTERN.test(String(message.content ?? ''))) {
      break;
    }
    used += 1;
  }
  const max = analysisMode === 'ATTRIBUTION' ? 1 : 2;
  return {
    used,
    max,
    remaining: Math.max(0, max - used),
    allowed: used < max,
    policy: analysisMode === 'ATTRIBUTION'
      ? 'ATTRIBUTION_SINGLE_BATCH'
      : 'STANDARD_BOUNDED',
  };
}

export function isClarificationText(value) {
  return CLARIFICATION_PATTERN.test(String(value ?? ''));
}

export function resolveConversationContext(question, history = []) {
  const current = String(question ?? '').trim();
  if (!current) {
    return {
      question: current,
      mode: 'NEW_TOPIC',
      reason: 'empty_question',
      inheritedUserMessages: [],
      inheritQueryContext: false,
      historyMessageCount: history.length,
    };
  }
  const previousUserMessages = (history ?? [])
    .filter((message) => message?.role === 'user')
    .map((message) => String(message.content ?? '').trim())
    .filter(Boolean)
    .slice(-3);
  const lastAssistant = [...(history ?? [])]
    .reverse()
    .find((message) => message?.role === 'assistant');
  const hasMetricIntent = METRIC_INTENT_PATTERN.test(current);
  const hasTimeIntent = TIME_INTENT_PATTERN.test(current);
  const hasFilterIntent = FILTER_INTENT_PATTERN.test(current);
  const explicitReference = EXPLICIT_REFERENCE_PATTERN.test(current);
  const resultOperation = RESULT_OPERATION_PATTERN.test(current);
  const anaphoric = CONTEXTUAL_QUESTION_PATTERN.test(current)
    && !(hasMetricIntent && (hasTimeIntent || hasFilterIntent));
  const awaitingClarification = CLARIFICATION_PATTERN.test(
    String(lastAssistant?.content ?? ''),
  );
  const slotAnswer = awaitingClarification
    && !hasMetricIntent
    && current.length <= 30;

  if (previousUserMessages.length === 0) {
    return {
      question: current,
      mode: 'NEW_TOPIC',
      reason: 'first_turn',
      inheritedUserMessages: [],
      inheritQueryContext: false,
      historyMessageCount: history.length,
    };
  }
  if (resultOperation || explicitReference) {
    return {
      question: current,
      mode: 'FOLLOW_UP',
      reason: resultOperation ? 'result_operation' : 'explicit_reference',
      inheritedUserMessages: previousUserMessages.slice(-3),
      inheritQueryContext: true,
      historyMessageCount: history.length,
    };
  }
  if (slotAnswer) {
    return {
      question: [...previousUserMessages.slice(-3), current].join('；'),
      mode: 'FOLLOW_UP',
      reason: 'clarification_slot',
      inheritedUserMessages: previousUserMessages.slice(-3),
      inheritQueryContext: true,
      historyMessageCount: history.length,
    };
  }
  if (anaphoric) {
    return {
      question: [...previousUserMessages.slice(-1), current].join('；'),
      mode: 'FOLLOW_UP',
      reason: 'anaphoric_follow_up',
      inheritedUserMessages: previousUserMessages.slice(-1),
      inheritQueryContext: true,
      historyMessageCount: history.length,
    };
  }
  return {
    question: current,
    mode: 'INDEPENDENT',
    reason: hasMetricIntent ? 'standalone_question' : 'independent_question',
    inheritedUserMessages: [],
    inheritQueryContext: false,
    historyMessageCount: history.length,
  };
}

export function resolveArtifactReusePolicy(
  question,
  context = {},
  artifactCount = 0,
) {
  const explicitRefresh = ARTIFACT_REFRESH_PATTERN.test(String(question ?? ''));
  const reuseArtifactsOnly = Number(artifactCount) > 0
    && !explicitRefresh
    && ['result_operation', 'explicit_reference'].includes(context?.reason);
  return {
    reuseArtifactsOnly,
    controlledRequeryAllowed: reuseArtifactsOnly,
    explicitRefresh,
    reason: explicitRefresh
      ? 'explicit_refresh'
      : reuseArtifactsOnly
        ? context.reason
        : 'fresh_query_allowed',
  };
}

export function resolveConversationQuestion(question, history = []) {
  return resolveConversationContext(question, history).question;
}

function inferDatasetMetrics(question, fields) {
  const source = text(question);
  const results = [];
  const add = (field, aggregator, label) => {
    if (field && !results.some((item) => item.field === field.fieldName)) {
      results.push({
        field: field.fieldName,
        aggregator,
        label: label ?? field.displayName ?? field.fieldName,
      });
    }
  };
  const metricFields = (fields ?? []).filter((field) => field.role === 'METRIC');

  for (const field of metricFields) {
    const aliases = fieldAliases(field);
    if (includesAny(source, aliases)) {
      add(field, field.aggregator ?? 'SUM');
    }
  }
  return results;
}

function inferDatasetDimensions(question, fields) {
  const source = text(question);
  const candidates = (fields ?? []).filter(
    (field) => field.role === 'DIMENSION' || field.role === 'TIME',
  );
  const selected = [];
  for (const field of candidates) {
    const matched = includesAny(source, fieldAliases(field)) ? field : null;
    if (matched && !selected.includes(matched.fieldName)) {
      selected.push(matched.fieldName);
    }
  }
  if (
    inferTimeGrain(source)
    || /趋势|走势/.test(source)
  ) {
    const dateField = candidates.find((field) => field.role === 'TIME');
    if (dateField && !selected.includes(dateField.fieldName)) {
      selected.unshift(dateField.fieldName);
    }
  }
  return selected.slice(0, 2);
}

export function inferDatasetQuerySpec({
  question,
  fields,
  fallbackMetrics = [],
  fallbackDimensions = [],
}) {
  const metrics = inferDatasetMetrics(question, fields);
  const inferredDimensions = inferDatasetDimensions(question, fields);
  const detailRequested = /明细|清单|列表|原始记录|所有记录|逐笔/.test(String(question));
  const dimensions = inferredDimensions.length > 0
    ? inferredDimensions
    : detailRequested
      ? fallbackDimensions
      : [];
  const topN = resolveTopN(question);
  const timeGrain = inferTimeGrain(question);
  const ranking = /排名|排行|对比|最高|最低|top\s*\d*|前\s*\d+/i.test(String(question));
  const effectiveMetrics = metrics.length > 0 ? metrics : fallbackMetrics;
  const order = ranking && effectiveMetrics[0] ? [{
    field: effectiveMetrics[0].field,
    direction: /最低|升序/.test(String(question)) ? 'ASC' : 'DESC',
  }] : [];
  return {
    metrics: effectiveMetrics,
    dimensions: dimensions.length > 0 ? dimensions : (
      metrics.length > 0 ? [] : fallbackDimensions
    ),
    order,
    limit: topN ?? 200,
    timeGrain,
    aggregationIntent: effectiveMetrics.length > 0
      ? (dimensions.length > 0 ? 'GROUP' : 'SUMMARY')
      : 'DETAIL',
  };
}

function inferIndicatorMetrics(question, metrics, fallbackMetrics) {
  const source = text(question);
  const matches = [];
  const noTaxRequested = /不含税|未税/.test(source);
  for (const metric of metrics ?? []) {
    const aliases = [
      metric.metricName,
      metric.name,
      metric.metricBizName,
      metric.bizName,
    ].filter(Boolean).map((value) => text(value));
    let bestScore = 0;
    for (const alias of aliases) {
      if (!alias) {
        continue;
      }
      const coreAlias = alias.replace(/^(含税|不含税|未税)/, '');
      let score = 0;
      if (source.includes(alias)) {
        score = alias.length * 10;
      } else if (coreAlias && source.includes(coreAlias)) {
        const excludesTax = /^(不含税|未税)/.test(alias);
        score = coreAlias.length * 10 + (
          excludesTax === noTaxRequested ? 20 : 5
        );
      }
      bestScore = Math.max(bestScore, score);
    }
    if (bestScore > 0) {
      matches.push({ metric, score: bestScore });
    }
  }
  if (matches.length === 0) {
    return fallbackMetrics;
  }
  const bestScore = Math.max(...matches.map((item) => item.score));
  return [...new Set(matches
    .filter((item) => item.score === bestScore)
    .map((item) => item.metric.metricBizName ?? item.metric.bizName)
    .filter(Boolean))];
}

function inferIndicatorDimensions(question, dimensions, fallbackDimensions, dateField) {
  const source = text(question);
  const selected = [];
  for (const dimension of dimensions ?? []) {
    const matched = includesAny(
      source,
      [
        dimension.dimensionName,
        dimension.name,
        dimension.dimensionBizName,
        dimension.bizName,
      ].filter(Boolean).map((value) => text(value)),
    ) ? dimension : null;
    const name = matched?.dimensionBizName ?? matched?.bizName;
    if (name && !selected.includes(name)) {
      selected.push(name);
    }
  }
  if ((inferTimeGrain(source) || /趋势|走势/.test(source)) && dateField) {
    selected.unshift(dateField);
  }
  const detailRequested = /明细|清单|列表|原始记录|所有记录|逐笔/.test(String(question));
  if (selected.length > 0) {
    return [...new Set(selected)].slice(0, 2);
  }
  if (detailRequested) {
    return fallbackDimensions;
  }
  return [];
}

export function inferIndicatorQuerySpec({
  question,
  metrics,
  dimensions,
  fallbackMetrics = [],
  fallbackDimensions = [],
  dateField = null,
}) {
  const inferredMetrics = inferIndicatorMetrics(question, metrics, fallbackMetrics);
  const inferredDimensions = inferIndicatorDimensions(
    question,
    dimensions,
    fallbackDimensions,
    dateField,
  );
  const ranking = /排名|排行|对比|最高|最低|top\s*\d*|前\s*\d+/i.test(String(question));
  const topN = resolveTopN(question);
  const timeGrain = inferTimeGrain(question);
  return {
    metrics: inferredMetrics,
    dimensions: inferredDimensions,
    limit: topN ?? 200,
    timeGrain,
    order: ranking && inferredMetrics[0] ? [{
      field: inferredMetrics[0],
      direction: /最低|升序/.test(String(question)) ? 'ASC' : 'DESC',
    }] : [],
    aggregationIntent: inferredMetrics.length > 0
      ? (inferredDimensions.length > 0 ? 'GROUP' : 'SUMMARY')
      : 'DETAIL',
  };
}

export function mergeSemanticFilters(fallbackFilters = [], inferredFilters = []) {
  const merged = new Map();
  for (const filter of fallbackFilters ?? []) {
    const key = String(filter?.bizName ?? filter?.field ?? '').trim();
    if (key) {
      merged.set(key, filter);
    }
  }
  for (const filter of inferredFilters ?? []) {
    const key = String(filter?.bizName ?? filter?.field ?? '').trim();
    if (key) {
      merged.set(key, filter);
    }
  }
  return [...merged.values()];
}

export { resolveTopN };
