import { normalizeDerivedOperand } from './scopedMetrics.js';

// 派生指标的规则规整层：校验/解析用户配置的类型、操作数与表达式，
// 输出可供逐行计算的规范化定义。计算执行见 derivedMetrics.js。

const DERIVED_TYPES = new Set([
  'RATIO',
  'SHARE_OF_TOTAL',
  'DIFFERENCE',
  'GROWTH_RATE',
  'PERCENTAGE_POINT',
  'SUM',
  'AVERAGE',
  'EXPRESSION',
]);

const OUTPUT_FORMATS = new Set(['NUMBER', 'PERCENT', 'CURRENCY', 'QUANTITY']);

function collectExpressionOperands(expression, operands = []) {
  if (expression.field) {
    operands.push(expression);
    return operands;
  }
  if (expression.value) {
    collectExpressionOperands(expression.value, operands);
  }
  if (expression.left) {
    collectExpressionOperands(expression.left, operands);
  }
  if (expression.right) {
    collectExpressionOperands(expression.right, operands);
  }
  return operands;
}

export function normalizeDerivedMetricDefinition(
  definition,
  index,
  resolveMetric,
  resolveDerivedMetric = null,
) {
  if (!definition || typeof definition !== 'object') {
    return null;
  }
  const type = String(definition.type ?? '').trim().toUpperCase();
  if (!DERIVED_TYPES.has(type)) {
    return null;
  }
  const left = normalizeDerivedOperand(
    definition.left
      ?? definition.numerator
      ?? definition.metric,
  );
  const right = normalizeDerivedOperand(
    definition.right
      ?? definition.denominator
      ?? (['SUM', 'AVERAGE', 'DIFFERENCE'].includes(type)
        ? definition.secondMetric
        : null),
  );
  const resolveOperand = (operand) => {
    if (!operand.field) {
      return null;
    }
    const baseField = resolveMetric(operand.field);
    if (baseField) {
      return {
        field: baseField,
        aggregator: operand.aggregator,
        source: 'BASE',
      };
    }
    const derivedField = resolveDerivedMetric?.(operand.field);
    if (derivedField) {
      return {
        field: derivedField,
        aggregator: operand.aggregator,
        source: 'DERIVED',
      };
    }
    return null;
  };
  const resolveExpression = (expression) => {
    if (!expression || typeof expression !== 'object') {
      return null;
    }
    const operation = String(
      expression.op
      ?? expression.operator
      ?? expression.type
      ?? '',
    ).trim().toUpperCase();
    if (!operation || operation === 'FIELD' || operation === 'METRIC') {
      const operand = resolveOperand(normalizeDerivedOperand(expression));
      return operand ? { ...operand, op: 'FIELD' } : null;
    }
    if (operation === 'ABS' || operation === 'NEGATE') {
      const value = resolveExpression(
        expression.value
        ?? expression.operand
        ?? expression.field,
      );
      return value ? { op: operation, value } : null;
    }
    if (!['ADD', 'SUM', 'SUBTRACT', 'DIFFERENCE', 'MULTIPLY', 'DIVIDE', 'RATIO'].includes(operation)) {
      return null;
    }
    const leftExpression = resolveExpression(
      expression.left
      ?? expression.numerator
      ?? expression.metric,
    );
    const rightExpression = resolveExpression(
      expression.right
      ?? expression.denominator
      ?? expression.secondMetric,
    );
    return leftExpression && rightExpression
      ? {
        op: operation === 'SUM'
          ? 'ADD'
          : operation === 'DIFFERENCE'
            ? 'SUBTRACT'
            : operation === 'RATIO'
              ? 'DIVIDE'
              : operation,
        left: leftExpression,
        right: rightExpression,
      }
      : null;
  };
  const expression = type === 'EXPRESSION'
    ? resolveExpression(definition.expression)
    : null;
  const resolvedLeft = type === 'EXPRESSION' ? null : resolveOperand(left);
  const resolvedRight = type === 'EXPRESSION' || !right.field
    ? null
    : resolveOperand(right);
  if (
    (type === 'EXPRESSION' && !expression)
    || (type !== 'EXPRESSION' && (
      !resolvedLeft
      || (type !== 'SHARE_OF_TOTAL' && right.field && !resolvedRight)
    ))
  ) {
    return null;
  }
  const outputField = String(
    definition.outputField
    ?? definition.field
    ?? `derived_metric_${index + 1}`,
  ).trim();
  const outputFormat = String(
    definition.outputFormat
    ?? definition.format
    ?? 'NUMBER',
  ).trim().toUpperCase();
  const precision = Number.isInteger(Number(definition.precision))
    ? Math.max(0, Math.min(12, Number(definition.precision)))
    : null;
  return {
    name: String(
      definition.name
      ?? definition.label
      ?? outputField,
    ).trim(),
    type,
    outputField,
    outputFormat: OUTPUT_FORMATS.has(outputFormat)
      ? outputFormat
      : 'NUMBER',
    precision,
    expression,
    operands: expression
      ? collectExpressionOperands(expression)
      : [resolvedLeft, resolvedRight].filter(Boolean),
    left: resolvedLeft,
    right: resolvedRight
      ? resolvedRight
      : null,
    conditionIds: Array.isArray(definition.conditionIds)
      ? definition.conditionIds.map(String)
      : [],
    ruleSource: String(definition.ruleSource ?? '').trim(),
  };
}

export function normalizeDerivedMetrics(
  definitions,
  resolveMetric,
) {
  const pending = (definitions ?? []).map((definition, index) => ({
    definition,
    index,
  }));
  const normalized = [];
  while (pending.length > 0) {
    let resolvedCount = 0;
    for (let cursor = 0; cursor < pending.length;) {
      const item = pending[cursor];
      const definition = normalizeDerivedMetricDefinition(
        item.definition,
        item.index,
        resolveMetric,
        (field) => normalized.find((candidate) => (
          candidate.outputField === field
          || candidate.name === field
        ))?.outputField ?? null,
      );
      if (!definition) {
        cursor += 1;
        continue;
      }
      normalized.push(definition);
      pending.splice(cursor, 1);
      resolvedCount += 1;
    }
    if (resolvedCount === 0) {
      break;
    }
  }
  return normalized;
}
