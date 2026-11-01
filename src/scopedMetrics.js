import {
  normalizeLikePattern,
  resolveFilterScope,
} from './querySemantics.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FILTER_OPERATORS = new Set([
  'IN',
  'NOT_IN',
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'LIKE',
  'BETWEEN',
  'IS_NULL',
  'IS_NOT_NULL',
]);

function compact(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s，,。；;：:！!？?、"'“”‘’（）()【】[\]{}]/g, '');
}

export function normalizeDerivedOperand(operand) {
  const reference = operand && typeof operand === 'object'
    ? String(operand.field ?? operand.metric ?? '').trim()
    : String(operand ?? '').trim();
  const field = reference.includes('.')
    ? reference.slice(reference.lastIndexOf('.') + 1).trim()
    : reference;
  if (operand && typeof operand === 'object') {
    return {
      field,
      aggregator: String(operand.aggregator ?? 'SUM').toUpperCase(),
    };
  }
  return {
    field,
    aggregator: 'SUM',
  };
}

export function collectExpressionOperandFields(expression, output = []) {
  if (!expression || typeof expression !== 'object') {
    return output;
  }
  if (expression.field) {
    output.push(String(expression.field));
    return output;
  }
  if (expression.value) {
    collectExpressionOperandFields(expression.value, output);
  }
  if (expression.left) {
    collectExpressionOperandFields(expression.left, output);
  }
  if (expression.right) {
    collectExpressionOperandFields(expression.right, output);
  }
  return output;
}

export function applyMetricScopedFilters(metricFields, filterFields) {
  const scopedConditionIds = new Set();
  if (metricFields.length > 1) {
    for (const filter of filterFields) {
      for (const conditionId of filter.conditionIds ?? []) {
        const referencedBy = metricFields.filter((metric) => (
          (metric.conditionIds ?? []).includes(conditionId)
        )).length;
        if (referencedBy > 0 && referencedBy < metricFields.length) {
          scopedConditionIds.add(conditionId);
        }
      }
    }
  }
  return {
    metricFields: metricFields.map((metric) => ({
      ...metric,
      filterConditionIds: (metric.conditionIds ?? [])
        .filter((conditionId) => scopedConditionIds.has(conditionId)),
    })),
    filterFields: filterFields.map((filter) => ({
      ...filter,
      applicationScope: (filter.conditionIds ?? [])
        .some((conditionId) => scopedConditionIds.has(conditionId))
        ? 'METRIC'
        : 'GLOBAL',
    })),
  };
}

export function classifyDerivedInternalMetrics(
  conditions,
  metricFields,
  derivedMetrics,
) {
  const conditionById = new Map(conditions.map((condition) => [condition.id, condition]));
  const rightFields = new Set();
  const leftFields = new Set();
  for (const definition of derivedMetrics) {
    if (definition.right?.field) {
      rightFields.add(String(definition.right.field));
    }
    if (definition.left?.field) {
      leftFields.add(String(definition.left.field));
    }
    if (definition.type === 'EXPRESSION' && definition.expression) {
      for (const field of collectExpressionOperandFields(definition.expression.right)) {
        rightFields.add(field);
      }
      for (const field of collectExpressionOperandFields(definition.expression.left)) {
        leftFields.add(field);
      }
    }
  }
  return metricFields.map((metric) => {
    const metricKey = metric.outputField || metric.field;
    const hasDirectMetricCondition = (metric.conditionIds ?? [])
      .some((conditionId) => conditionById.get(conditionId)?.kind === 'METRIC');
    const isDenominatorOnly = rightFields.has(metricKey)
      && !leftFields.has(metricKey);
    return {
      ...metric,
      internal: metric.internal === true
        || (!hasDirectMetricCondition && isDenominatorOnly),
    };
  });
}

export function quoteIdentifier(value) {
  const text = String(value ?? '');
  if (!IDENTIFIER.test(text)) {
    throw new Error(`invalid SQL identifier: ${text}`);
  }
  return `\`${text}\``;
}

export function normalizeDatasetFilters(filters, fieldsByName) {
  return (filters ?? []).map((filter) => {
    const field = fieldsByName.get(String(filter.field ?? filter.bizName ?? ''));
    if (!field) {
      throw new Error(`dataset filter field not found: ${filter.field ?? filter.bizName}`);
    }
    const operator = String(filter.operator ?? 'IN').toUpperCase();
    if (!FILTER_OPERATORS.has(operator)) {
      throw new Error(`unsupported dataset filter operator: ${operator}`);
    }
    if (
      field.allowedOperators.length > 0
      && !field.allowedOperators.includes(operator)
    ) {
      throw new Error(`operator ${operator} is not allowed for field ${field.fieldName}`);
    }
    const scope = resolveFilterScope({
      field,
      operator,
      sourceText: filter.sourceText,
    });
    return {
      field,
      operator,
      value: operator === 'LIKE'
        ? normalizeLikePattern(filter.value, filter.sourceText)
        : filter.value,
      scope: filter.scope === 'AGGREGATE' ? 'AGGREGATE' : scope,
    };
  });
}

export function metricOutputField(metric, fallback) {
  const value = String(metric?.outputField ?? fallback ?? '').trim();
  if (!IDENTIFIER.test(value)) {
    throw new Error(`invalid metric output field: ${value}`);
  }
  return value;
}

export function appendPredicateFilter(filter, parts, values, quote = quoteIdentifier) {
  const expression = quote(filter.field.fieldName);
  if (filter.operator === 'IS_NULL' || filter.operator === 'IS_NOT_NULL') {
    parts.push(`${expression} ${filter.operator.replaceAll('_', ' ')}`);
    return;
  }
  if (filter.operator === 'IN' || filter.operator === 'NOT_IN') {
    const list = Array.isArray(filter.value) ? filter.value : [filter.value];
    if (list.length === 0) {
      parts.push(filter.operator === 'NOT_IN' ? '1 = 1' : '1 = 0');
      return;
    }
    parts.push(`${expression} ${filter.operator.replaceAll('_', ' ')} (${list.map(() => '?').join(', ')})`);
    values.push(...list);
    return;
  }
  if (filter.operator === 'BETWEEN') {
    const list = Array.isArray(filter.value) ? filter.value : [];
    if (list.length !== 2) {
      throw new Error(`BETWEEN requires two values for ${filter.field.fieldName}`);
    }
    parts.push(`${expression} BETWEEN ? AND ?`);
    values.push(list[0], list[1]);
    return;
  }
  parts.push(`${expression} ${filter.operator} ?`);
  values.push(filter.value);
}

export function normalizeMetricSpecs(metricSpecs) {
  return (metricSpecs ?? []).map((metric) => ({
    field: String(metric?.field ?? '').trim(),
    outputField: String(metric?.outputField ?? metric?.field ?? '').trim(),
    aggregator: String(metric?.aggregator ?? 'SUM').toUpperCase(),
    predicateFilters: (metric?.predicateFilters ?? []).map((filter) => ({
      field: String(filter?.field ?? '').trim(),
      operator: String(filter?.operator ?? 'IN').toUpperCase(),
      value: filter?.value,
    })),
    internal: metric?.internal === true,
  })).filter((metric) => metric.field && metric.outputField);
}

export function prepareBoundDatasetExecution(boundContract) {
  const filterByConditionId = new Map();
  for (const filter of boundContract?.filterFields ?? []) {
    for (const conditionId of filter.conditionIds ?? []) {
      const existing = filterByConditionId.get(conditionId) ?? [];
      existing.push(filter);
      filterByConditionId.set(conditionId, existing);
    }
  }
  const predicateFilters = (metric) => {
    const seen = new Set();
    const filters = [];
    for (const filter of (metric.filterConditionIds ?? [])
      .flatMap((conditionId) => filterByConditionId.get(conditionId) ?? [])) {
      const key = [
        filter.field,
        filter.operator,
        JSON.stringify(filter.value),
      ].join('|');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      filters.push({
        field: filter.field,
        operator: filter.operator,
        value: filter.value,
        sourceText: filter.sourceText,
        scope: filter.scope ?? 'ROW',
      });
    }
    return filters;
  };
  return {
    requestedMetrics: (boundContract?.metricFields ?? []).map((metric) => ({
      field: metric.field,
      aggregator: metric.aggregator,
      outputField: metric.outputField ?? metric.field,
      predicateFilters: predicateFilters(metric),
      internal: metric.internal,
    })),
    executionFilterFields: (boundContract?.filterFields ?? [])
      .filter((filter) => filter.applicationScope !== 'METRIC'),
  };
}

export function metricIdentity(metric) {
  return {
    field: String(metric?.field ?? ''),
    outputField: String(metric?.outputField ?? metric?.field ?? ''),
    aggregator: String(metric?.aggregator ?? 'SUM').toUpperCase(),
  };
}

export { compact };
