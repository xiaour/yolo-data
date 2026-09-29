const DERIVED_TYPES = new Set([
  'RATIO',
  'DIFFERENCE',
  'GROWTH_RATE',
  'PERCENTAGE_POINT',
  'SUM',
  'AVERAGE',
  'EXPRESSION',
]);

const OUTPUT_FORMATS = new Set(['NUMBER', 'PERCENT', 'CURRENCY', 'QUANTITY']);

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeOperand(operand) {
  if (operand && typeof operand === 'object') {
    return {
      field: String(operand.field ?? operand.metric ?? '').trim(),
      aggregator: String(operand.aggregator ?? 'SUM').toUpperCase(),
    };
  }
  return {
    field: String(operand ?? '').trim(),
    aggregator: 'SUM',
  };
}

function computeDefinition(definition, row) {
  if (definition.type === 'EXPRESSION') {
    return computeExpression(definition.expression, row);
  }
  const left = numericValue(row?.[definition.left.field]);
  const right = definition.right
    ? numericValue(row?.[definition.right.field])
    : null;
  switch (definition.type) {
    case 'RATIO':
      return left !== null && right !== null && right !== 0
        ? left / right
        : null;
    case 'DIFFERENCE':
      return left !== null && right !== null ? left - right : null;
    case 'GROWTH_RATE':
      return left !== null && right !== null && right !== 0
        ? (left - right) / Math.abs(right)
        : null;
    case 'PERCENTAGE_POINT':
      return left !== null && right !== null ? left - right : null;
    case 'SUM':
      return left !== null && right !== null ? left + right : null;
    case 'AVERAGE':
      return left !== null && right !== null ? (left + right) / 2 : null;
    default:
      return null;
  }
}

function computeExpression(expression, row) {
  if (!expression) {
    return null;
  }
  if (expression.field) {
    return numericValue(row?.[expression.field]);
  }
  const operation = String(expression.op ?? '').toUpperCase();
  if (operation === 'ABS') {
    const value = computeExpression(expression.value, row);
    return value === null ? null : Math.abs(value);
  }
  if (operation === 'NEGATE') {
    const value = computeExpression(expression.value, row);
    return value === null ? null : -value;
  }
  const left = computeExpression(expression.left, row);
  const right = computeExpression(expression.right, row);
  if (left === null || right === null) {
    return null;
  }
  if (operation === 'ADD' || operation === 'SUM') {
    return left + right;
  }
  if (operation === 'SUBTRACT' || operation === 'DIFFERENCE') {
    return left - right;
  }
  if (operation === 'MULTIPLY') {
    return left * right;
  }
  if (operation === 'DIVIDE' || operation === 'RATIO') {
    return right === 0 ? null : left / right;
  }
  return null;
}

function roundValue(value, precision) {
  if (value === null || value === undefined) {
    return value;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(precision)) {
    return value;
  }
  const factor = 10 ** Math.max(0, Math.min(12, precision));
  return Math.round(number * factor) / factor;
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
  const left = normalizeOperand(
    definition.left
      ?? definition.numerator
      ?? definition.metric,
  );
  const right = normalizeOperand(
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
      const operand = resolveOperand(normalizeOperand(expression));
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
      || (right.field && !resolvedRight)
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

export function applyDerivedMetrics({
  columns = [],
  rows = [],
  definitions = [],
} = {}) {
  const existing = new Set(columns.map((column) => (
    String(column?.bizName ?? column?.name ?? '')
  )));
  const derivedColumns = definitions
    .filter((definition) => !existing.has(definition.outputField))
    .map((definition) => ({
      name: definition.name,
      bizName: definition.outputField,
      showType: 'NUMBER',
      type: 'DECIMAL',
      dataFormatType: definition.outputFormat === 'PERCENT'
        ? 'percent'
        : null,
      derived: true,
      derivedType: definition.type,
    }));
  const derivedRows = (rows ?? []).map((row) => {
    const next = { ...row };
    for (const definition of definitions) {
      next[definition.outputField] = roundValue(
        computeDefinition(definition, next),
        definition.precision,
      );
    }
    return next;
  });
  return {
    columns: [...columns, ...derivedColumns],
    rows: derivedRows,
  };
}

function compareValue(left, right, operator) {
  switch (String(operator ?? '').toUpperCase()) {
    case '=':
      return left === right;
    case '!=':
      return left !== right;
    case '>':
      return Number(left) > Number(right);
    case '>=':
      return Number(left) >= Number(right);
    case '<':
      return Number(left) < Number(right);
    case '<=':
      return Number(left) <= Number(right);
    default:
      return true;
  }
}

export function applyDerivedMetricFilters({
  rows = [],
  filters = [],
  derivedFields = [],
} = {}) {
  const fields = new Set(derivedFields);
  const active = (filters ?? []).filter((filter) => (
    fields.has(String(filter?.field ?? filter?.bizName ?? ''))
  ));
  if (active.length === 0) {
    return rows;
  }
  return (rows ?? []).filter((row) => active.every((filter) => {
    const field = String(filter.field ?? filter.bizName);
    const value = row?.[field];
    if (filter.operator === 'BETWEEN') {
      const list = Array.isArray(filter.value) ? filter.value : [];
      return list.length === 2
        && Number(value) >= Number(list[0])
        && Number(value) <= Number(list[1]);
    }
    if (filter.operator === 'IN' || filter.operator === 'NOT_IN') {
      const list = Array.isArray(filter.value) ? filter.value : [filter.value];
      const matched = list.some((item) => String(item) === String(value));
      return filter.operator === 'IN' ? matched : !matched;
    }
    return compareValue(value, filter.value, filter.operator);
  }));
}

export { DERIVED_TYPES, OUTPUT_FORMATS };
