function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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
      displayDecimals: definition.precision,
      derived: true,
      derivedType: definition.type,
    }));
  const shareTotals = new Map(
    definitions
      .filter((definition) => definition.type === 'SHARE_OF_TOTAL')
      .map((definition) => [
        definition.outputField,
        (rows ?? []).reduce((total, row) => {
          const value = numericValue(row?.[definition.left.field]);
          return value === null ? total : total + value;
        }, 0),
      ]),
  );
  const derivedRows = (rows ?? []).map((row) => {
    const next = { ...row };
    for (const definition of definitions) {
      const value = definition.type === 'SHARE_OF_TOTAL'
        ? (() => {
          const numerator = numericValue(next?.[definition.left.field]);
          const denominator = shareTotals.get(definition.outputField);
          return numerator !== null && denominator !== 0
            ? numerator / denominator
            : null;
        })()
        : computeDefinition(definition, next);
      // Precision belongs to presentation. Rounding the stored value here
      // changes later formulas and can turn 36.59% into 40%.
      next[definition.outputField] = value;
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

