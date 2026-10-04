import { normalizeLexicon } from './businessLexicon.js';

const POLICY_VERSION = 1;
const EXPRESSION_OPERATORS = new Set([
  'FIELD',
  'ADD',
  'SUM',
  'SUBTRACT',
  'DIFFERENCE',
  'MULTIPLY',
  'DIVIDE',
  'RATIO',
  'ABS',
  'NEGATE',
]);

function stringList(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [value])
      .map((item) => String(item ?? '').trim())
      .filter(Boolean),
  )];
}

function normalizeExpression(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const operation = String(
    value.op
    ?? value.operator
    ?? value.type
    ?? (value.field ? 'FIELD' : ''),
  ).trim().toUpperCase();
  if (!EXPRESSION_OPERATORS.has(operation)) {
    return null;
  }
  if (operation === 'FIELD') {
    const field = String(value.field ?? value.metric ?? '').trim();
    return field
      ? {
        op: 'FIELD',
        field,
        aggregator: String(value.aggregator ?? 'SUM').trim().toUpperCase(),
      }
      : null;
  }
  if (operation === 'ABS' || operation === 'NEGATE') {
    const operand = normalizeExpression(
      value.value
      ?? value.operand
      ?? value.field,
    );
    return operand ? { op: operation, value: operand } : null;
  }
  const left = normalizeExpression(
    value.left
    ?? value.numerator
    ?? value.metric,
  );
  const right = normalizeExpression(
    value.right
    ?? value.denominator
    ?? value.secondMetric,
  );
  return left && right ? { op: operation, left, right } : null;
}

function normalizeMetricRule(rule, index) {
  const concept = String(rule?.concept ?? rule?.name ?? '').trim();
  const aliases = stringList(rule?.aliases ?? concept);
  const target = rule?.target ?? {};
  const targetType = String(target.type ?? (target.field ? 'FIELD' : 'FORMULA'))
    .trim()
    .toUpperCase();
  const normalizedTarget = targetType === 'FIELD'
    ? {
      type: 'FIELD',
      field: String(target.field ?? '').trim(),
      aggregator: String(target.aggregator ?? 'SUM').trim().toUpperCase(),
    }
    : {
      type: 'FORMULA',
      outputField: String(
        target.outputField
        ?? rule?.outputField
        ?? `policy_metric_${index + 1}`,
      ).trim(),
      outputFormat: String(
        target.outputFormat
        ?? rule?.outputFormat
        ?? 'NUMBER',
      ).trim().toUpperCase(),
      precision: Number.isInteger(Number(target.precision ?? rule?.precision))
        ? Number(target.precision ?? rule?.precision)
        : null,
      expression: normalizeExpression(target.expression ?? rule?.expression),
    };
  if (
    !concept
    || aliases.length === 0
    || (normalizedTarget.type === 'FIELD' && !normalizedTarget.field)
    || (normalizedTarget.type === 'FORMULA' && !normalizedTarget.expression)
  ) {
    return null;
  }
  return {
    id: String(rule?.id ?? `metric-${index + 1}`).trim(),
    concept,
    aliases,
    excludeWhen: stringList(rule?.excludeWhen),
    priority: Number(rule?.priority) || 0,
    exclusive: rule?.exclusive !== false,
    description: String(rule?.description ?? '').trim(),
    target: normalizedTarget,
  };
}

function normalizeFieldRule(rule, index) {
  const concept = String(rule?.concept ?? rule?.name ?? '').trim();
  const aliases = stringList(rule?.aliases ?? concept);
  const field = String(rule?.field ?? rule?.targetField ?? '').trim();
  if (!concept || !field || aliases.length === 0) {
    return null;
  }
  return {
    id: String(rule?.id ?? `field-${index + 1}`).trim(),
    concept,
    aliases,
    excludeWhen: stringList(rule?.excludeWhen),
    priority: Number(rule?.priority) || 0,
    field,
    operator: String(rule?.operator ?? 'IN').trim().toUpperCase(),
    value: rule?.value,
    ruleSource: String(rule?.ruleSource ?? '').trim(),
  };
}

function normalizeEnumGroup(group, index) {
  const field = String(group?.field ?? '').trim();
  const name = String(group?.name ?? group?.concept ?? '').trim();
  const values = stringList(group?.values);
  if (!field || !name || values.length === 0) {
    return null;
  }
  return {
    id: String(group?.id ?? `enum-${index + 1}`).trim(),
    field,
    name,
    aliases: stringList(group?.aliases ?? name),
    values,
    exclusive: group?.exclusive !== false,
  };
}

export function normalizeSemanticPolicy(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    version: Number(source.version) || POLICY_VERSION,
    metrics: (source.metrics ?? [])
      .map(normalizeMetricRule)
      .filter(Boolean)
      .sort((left, right) => right.priority - left.priority),
    dimensions: (source.dimensions ?? [])
      .map(normalizeFieldRule)
      .filter(Boolean)
      .sort((left, right) => right.priority - left.priority),
    filters: (source.filters ?? [])
      .map(normalizeFieldRule)
      .filter(Boolean)
      .sort((left, right) => right.priority - left.priority),
    enumGroups: (source.enumGroups ?? source.enums ?? [])
      .map(normalizeEnumGroup)
      .filter(Boolean),
    policies: {
      ambiguity: String(source.policies?.ambiguity ?? 'CLARIFY').toUpperCase(),
      allowFuzzyMapping: source.policies?.allowFuzzyMapping === true,
    },
    plugins: Array.isArray(source.plugins) ? source.plugins : [],
    lexicon: normalizeLexicon(source.lexicon),
  };
}

function normalizedText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

function matchedAlias(question, rule) {
  const text = normalizedText(question);
  if (rule.excludeWhen.some((item) => text.includes(normalizedText(item)))) {
    return null;
  }
  const matches = rule.aliases
    .filter((alias) => text.includes(normalizedText(alias)))
    .sort((left, right) => right.length - left.length);
  return matches[0] ?? null;
}

function matchRules(question, rules) {
  return rules
    .map((rule) => ({
      rule,
      matchedText: matchedAlias(question, rule),
    }))
    .filter((item) => item.matchedText);
}

function sourceMatches(sourceText, aliases) {
  const source = normalizedText(sourceText);
  return Boolean(source && aliases.some((alias) => (
    source.includes(normalizedText(alias))
    || normalizedText(alias).includes(source)
  )));
}

export function applySemanticPolicy({
  question,
  policy,
  draft = {},
}) {
  const normalizedPolicy = normalizeSemanticPolicy(policy);
  const nextDraft = {
    ...draft,
    conditions: [...(draft.conditions ?? [])],
    metricFields: [...(draft.metricFields ?? [])],
    derivedMetrics: [...(draft.derivedMetrics ?? [])],
    dimensionFields: [...(draft.dimensionFields ?? [])],
    filterFields: [...(draft.filterFields ?? [])],
  };
  const matches = [];
  const ensureCondition = (rule, kind, matchedText) => {
    const existing = nextDraft.conditions.find((condition) => (
      sourceMatches(condition?.sourceText, rule.aliases)
    ));
    if (existing) {
      existing.kind = kind;
      existing.status = 'RESOLVED';
      existing.ruleSource = `semanticPolicy:${rule.id}`;
      return existing;
    }
    let index = nextDraft.conditions.length + 1;
    while (nextDraft.conditions.some((condition) => condition.id === `policy-condition-${index}`)) {
      index += 1;
    }
    const condition = {
      id: `policy-condition-${index}`,
      sourceText: matchedText,
      kind,
      status: 'RESOLVED',
      ruleSource: `semanticPolicy:${rule.id}`,
    };
    nextDraft.conditions.push(condition);
    return condition;
  };

  for (const { rule, matchedText } of matchRules(question, normalizedPolicy.metrics)) {
    const condition = ensureCondition(
      rule,
      rule.target.type === 'FORMULA' ? 'CALCULATION' : 'METRIC',
      matchedText,
    );
    if (rule.exclusive) {
      nextDraft.metricFields = nextDraft.metricFields.filter((field) => (
        !sourceMatches(field?.sourceText, rule.aliases)
        && String(field?.field ?? '') !== String(rule.target.field ?? '')
      ));
      nextDraft.derivedMetrics = nextDraft.derivedMetrics.filter((metric) => (
        !sourceMatches(metric?.name, rule.aliases)
        && !sourceMatches(metric?.outputField, rule.aliases)
        && String(metric?.outputField ?? '') !== String(rule.target.outputField ?? '')
      ));
    }
    if (rule.target.type === 'FIELD') {
      if (!nextDraft.metricFields.some((field) => (
        String(field?.field ?? '') === rule.target.field
      ))) {
        nextDraft.metricFields.push({
          field: rule.target.field,
          sourceText: matchedText,
          aggregator: rule.target.aggregator,
          ruleSource: `semanticPolicy:${rule.id}`,
          conditionIds: [condition.id],
        });
      }
    } else if (!nextDraft.derivedMetrics.some((metric) => (
      metric?.outputField === rule.target.outputField
    ))) {
      nextDraft.derivedMetrics.push({
        name: rule.concept,
        type: 'EXPRESSION',
        outputField: rule.target.outputField,
        outputFormat: rule.target.outputFormat,
        precision: rule.target.precision,
        expression: rule.target.expression,
        ruleSource: `semanticPolicy:${rule.id}${rule.description ? ` · ${rule.description}` : ''}`,
        conditionIds: [condition.id],
      });
    }
    matches.push({
      category: 'METRIC',
      ruleId: rule.id,
      concept: rule.concept,
      matchedText,
      target: rule.target,
    });
  }

  for (const { rule, matchedText } of matchRules(question, normalizedPolicy.dimensions)) {
    const condition = ensureCondition(rule, 'DIMENSION', matchedText);
    if (!nextDraft.dimensionFields.some((field) => field?.field === rule.field)) {
      nextDraft.dimensionFields.push({
        field: rule.field,
        sourceText: matchedText,
        ruleSource: `semanticPolicy:${rule.id}`,
        conditionIds: [condition.id],
      });
    }
    matches.push({
      category: 'DIMENSION',
      ruleId: rule.id,
      concept: rule.concept,
      matchedText,
      field: rule.field,
    });
  }

  for (const { rule, matchedText } of matchRules(question, normalizedPolicy.filters)) {
    const condition = ensureCondition(rule, 'FILTER', matchedText);
    const exists = nextDraft.filterFields.some((filter) => (
      String(filter?.field ?? filter?.bizName ?? '') === rule.field
      && (
        sourceMatches(filter?.sourceText, rule.aliases)
        || String(filter?.value ?? '') === String(rule.value ?? '')
      )
    ));
    if (!exists) {
      nextDraft.filterFields.push({
        field: rule.field,
        operator: rule.operator,
        value: rule.value,
        sourceText: matchedText,
        ruleSource: rule.ruleSource || `semanticPolicy:${rule.id}`,
        conditionIds: [condition.id],
      });
    }
    matches.push({
      category: 'FILTER',
      ruleId: rule.id,
      concept: rule.concept,
      matchedText,
      field: rule.field,
    });
  }

  return {
    draft: nextDraft,
    matches,
    policy: normalizedPolicy,
  };
}

export function buildSemanticPolicyPrompt(policy) {
  const normalized = normalizeSemanticPolicy(policy);
  const configuredRules = [
    normalized.metrics.length,
    normalized.dimensions.length,
    normalized.filters.length,
    normalized.enumGroups.length,
  ].reduce((sum, count) => sum + count, 0);
  if (configuredRules === 0) {
    return '当前主题未配置业务语义包。遇到业务术语、别名、公式或枚举时必须澄清或报告能力缺口，禁止按相似字段猜测。';
  }
  return [
    '当前主题业务语义包（优先级高于模型的自由判断）：',
    JSON.stringify({
      version: normalized.version,
      metrics: normalized.metrics,
      dimensions: normalized.dimensions,
      filters: normalized.filters,
      enumGroups: normalized.enumGroups,
      policies: normalized.policies,
      plugins: normalized.plugins,
    }, null, 2),
    '业务语义包命中时，必须使用其中的目标字段、公式、过滤和枚举；不得替换为其他相似字段。',
  ].join('\n');
}

export { POLICY_VERSION };
