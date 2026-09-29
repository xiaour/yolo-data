import {
  applyDerivedMetrics,
  normalizeDerivedMetrics,
} from './derivedMetrics.js';

const STAGE_TYPES = new Set([
  'BUCKET_FIELD',
  'DERIVE',
  'FILTER',
  'ROLLUP',
  'SORT',
  'LIMIT',
  'SELECT_COLUMNS',
]);

const PERIODS = new Set(['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR']);
const AGGREGATORS = new Set([
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'COUNT',
  'COUNT_DISTINCT',
]);
const OPERATORS = new Set([
  '=', '!=', '>', '>=', '<', '<=', 'IN', 'NOT_IN', 'BETWEEN', 'IS_NULL', 'IS_NOT_NULL',
]);

function text(value) {
  return String(value ?? '').trim();
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).map(text).filter(Boolean))];
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function columnKey(column) {
  return text(column?.bizName ?? column?.nameEn ?? column?.name);
}

function requireColumn(columns, field, stageId) {
  const column = (columns ?? []).find((item) => columnKey(item) === text(field));
  if (!column) {
    throw new Error(`analysisPipeline stage ${stageId || '-'} references unknown column: ${field}`);
  }
  return column;
}

function normalizePredicate(predicate = {}) {
  const mode = text(predicate.mode).toUpperCase() === 'ANY' ? 'ANY' : 'ALL';
  const conditions = (predicate.conditions ?? predicate.items ?? [])
    .map((condition) => normalizeCondition(condition))
    .filter(Boolean);
  return {
    mode,
    conditions,
  };
}

function normalizeCondition(condition) {
  if (!condition || typeof condition !== 'object') {
    return null;
  }
  const field = text(condition.field);
  const operator = text(condition.operator).toUpperCase();
  if (!field || !OPERATORS.has(operator)) {
    return null;
  }
  const value = operator === 'BETWEEN'
    ? (Array.isArray(condition.value) ? condition.value.slice(0, 2) : [])
    : operator === 'IN' || operator === 'NOT_IN'
      ? (Array.isArray(condition.value) ? condition.value : [condition.value])
      : condition.value;
  return {
    field,
    operator,
    value,
  };
}

function bucketComparisonValue(value, period) {
  const normalizedPeriod = text(period).toUpperCase();
  if (!PERIODS.has(normalizedPeriod)) {
    return value;
  }
  const source = text(value);
  const dateMatch = source.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) {
    return source;
  }
  const year = dateMatch[1];
  const month = dateMatch[2];
  const day = dateMatch[3];
  if (normalizedPeriod === 'YEAR') {
    return year;
  }
  if (normalizedPeriod === 'QUARTER') {
    return `${year}-Q${Math.floor((Number(month) - 1) / 3) + 1}`;
  }
  if (normalizedPeriod === 'MONTH') {
    return `${year}-${month}`;
  }
  if (normalizedPeriod === 'WEEK') {
    const date = new Date(`${source}T00:00:00Z`);
    const weekday = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() - weekday + 1);
    return date.toISOString().slice(0, 10);
  }
  return `${year}-${month}-${day}`;
}

function compareValue(left, right, operator, period = null) {
  const normalizedOperator = text(operator).toUpperCase();
  if (normalizedOperator === 'IS_NULL') {
    return left === null || left === undefined || left === '';
  }
  if (normalizedOperator === 'IS_NOT_NULL') {
    return !(left === null || left === undefined || left === '');
  }
  if (normalizedOperator === 'IN' || normalizedOperator === 'NOT_IN') {
    const list = Array.isArray(right) ? right : [right];
    const matched = list.some((item) => (
      bucketComparisonValue(item, period) === bucketComparisonValue(left, period)
    ));
    return normalizedOperator === 'IN' ? matched : !matched;
  }
  if (normalizedOperator === 'BETWEEN') {
    const list = Array.isArray(right) ? right : [];
    const leftValue = bucketComparisonValue(left, period);
    const startValue = bucketComparisonValue(list[0], period);
    const endValue = bucketComparisonValue(list[1], period);
    return list.length === 2
      && leftValue >= startValue
      && leftValue <= endValue;
  }
  if (normalizedOperator === '=') {
    return bucketComparisonValue(left, period) === bucketComparisonValue(right, period);
  }
  if (normalizedOperator === '!=') {
    return bucketComparisonValue(left, period) !== bucketComparisonValue(right, period);
  }
  const leftNumber = asNumber(left);
  const rightNumber = asNumber(right);
  if (leftNumber === null || rightNumber === null) {
    return false;
  }
  if (normalizedOperator === '>') {
    return leftNumber > rightNumber;
  }
  if (normalizedOperator === '>=') {
    return leftNumber >= rightNumber;
  }
  if (normalizedOperator === '<') {
    return leftNumber < rightNumber;
  }
  if (normalizedOperator === '<=') {
    return leftNumber <= rightNumber;
  }
  return false;
}

function matchesCondition(row, condition, fieldPeriods = new Map()) {
  return compareValue(
    row?.[condition.field],
    condition.value,
    condition.operator,
    fieldPeriods.get(condition.field),
  );
}

function matchesPredicate(row, predicate, fieldPeriods = new Map()) {
  if (predicate.conditions.length === 0) {
    return true;
  }
  const results = predicate.conditions.map((condition) => (
    matchesCondition(row, condition, fieldPeriods)
  ));
  return predicate.mode === 'ANY' ? results.some(Boolean) : results.every(Boolean);
}

function bucketValue(value, period) {
  const dateText = String(value ?? '').slice(0, 10);
  const date = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return dateText;
  }
  if (period === 'YEAR') {
    return `${date.getUTCFullYear()}`;
  }
  if (period === 'QUARTER') {
    return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
  }
  if (period === 'MONTH') {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (period === 'WEEK') {
    const weekday = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() - weekday + 1);
  }
  return date.toISOString().slice(0, 10);
}

function normalizeStage(stage, index) {
  const type = text(stage?.type).toUpperCase();
  if (!STAGE_TYPES.has(type)) {
    return null;
  }
  const id = text(stage.id) || `stage-${index + 1}`;
  if (type === 'BUCKET_FIELD') {
    const sourceField = text(stage.sourceField ?? stage.field);
    const outputField = text(stage.outputField);
    const period = text(stage.period).toUpperCase();
    return sourceField && outputField && PERIODS.has(period)
      ? { id, type, sourceField, outputField, period }
      : null;
  }
  if (type === 'DERIVE') {
    const definitions = Array.isArray(stage.definitions)
      ? stage.definitions
      : stage.derivedMetrics ?? [];
    return definitions.length > 0
      ? { id, type, definitions: JSON.parse(JSON.stringify(definitions)) }
      : null;
  }
  if (type === 'FILTER') {
    const predicate = normalizePredicate(stage.predicate);
    return predicate.conditions.length > 0
      ? { id, type, predicate }
      : null;
  }
  if (type === 'ROLLUP') {
    const groupBy = uniqueStrings(stage.groupBy);
    const outputs = (stage.outputs ?? []).map((output) => {
      const outputType = text(output?.type).toUpperCase();
      const outputField = text(output?.outputField);
      if (outputType === 'COUNT_IF') {
        const predicate = normalizePredicate(output.predicate);
        return outputField
          ? { type: 'COUNT_IF', outputField, predicate }
          : null;
      }
      if (outputType === 'CONDITIONAL_AGGREGATE') {
        const metric = text(output.metric);
        const aggregator = text(output.aggregator).toUpperCase() || 'SUM';
        const predicate = normalizePredicate(output.when ?? output.predicate);
        return outputField && metric && AGGREGATORS.has(aggregator)
          ? {
            type: 'CONDITIONAL_AGGREGATE',
            outputField,
            metric,
            aggregator,
            predicate,
          }
          : null;
      }
      if (outputType === 'AGGREGATE') {
        const metric = text(output.metric);
        const aggregator = text(output.aggregator).toUpperCase() || 'SUM';
        return outputField && metric && AGGREGATORS.has(aggregator)
          ? { type: 'AGGREGATE', outputField, metric, aggregator }
          : null;
      }
      return null;
    }).filter(Boolean);
    return groupBy.length > 0 && outputs.length > 0
      ? { id, type, groupBy, outputs }
      : null;
  }
  if (type === 'SORT') {
    const order = (stage.order ?? []).map((item) => ({
      field: text(item?.field),
      direction: text(item?.direction).toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
    })).filter((item) => item.field);
    return order.length > 0 ? { id, type, order } : null;
  }
  if (type === 'LIMIT') {
    const value = Number(stage.value);
    return Number.isInteger(value) && value > 0
      ? { id, type, value: Math.min(value, 10000) }
      : null;
  }
  if (type === 'SELECT_COLUMNS') {
    const fields = uniqueStrings(stage.fields);
    return fields.length > 0 ? { id, type, fields } : null;
  }
  return null;
}

export function normalizeAnalysisPipeline(pipeline = null) {
  if (!pipeline || typeof pipeline !== 'object') {
    return null;
  }
  const stages = (pipeline.stages ?? [])
    .map(normalizeStage)
    .filter(Boolean);
  return stages.length > 0
    ? {
      version: 1,
      stages,
    }
    : null;
}

export function applyAnalysisPipeline({
  columns = [],
  rows = [],
  pipeline = null,
} = {}) {
  let state = {
    columns: [...columns],
    rows: [...rows],
  };
  const fieldPeriods = new Map();
  for (const stage of pipeline?.stages ?? []) {
    if (stage.type === 'BUCKET_FIELD') {
      const sourceColumn = requireColumn(state.columns, stage.sourceField, stage.id);
      state.columns = [
        ...state.columns,
        {
          name: stage.outputField,
          bizName: stage.outputField,
          showType: 'CATEGORY',
          type: 'STRING',
        },
      ];
      state.rows = state.rows.map((row) => ({
        ...row,
        [stage.outputField]: bucketValue(row?.[columnKey(sourceColumn)], stage.period),
      }));
      fieldPeriods.set(stage.outputField, stage.period);
      continue;
    }
    if (stage.type === 'DERIVE') {
      const definitions = normalizeDerivedMetrics(
        stage.definitions,
        (field) => String(field ?? '').trim(),
      );
      if (definitions.length === 0) {
        throw new Error(`analysisPipeline stage ${stage.id} has no usable derived definitions`);
      }
      state = applyDerivedMetrics({
        columns: state.columns,
        rows: state.rows,
        definitions,
      });
      continue;
    }
    if (stage.type === 'FILTER') {
      state.rows = state.rows.filter((row) => (
        matchesPredicate(row, stage.predicate, fieldPeriods)
      ));
      continue;
    }
    if (stage.type === 'ROLLUP') {
      const groupColumns = stage.groupBy.map((field) => (
        requireColumn(state.columns, field, stage.id)
      ));
      const records = new Map();
      for (const row of state.rows) {
        const key = stage.groupBy.map((field) => text(row?.[field])).join('\u001f');
        const record = records.get(key) ?? {
          values: Object.fromEntries(stage.groupBy.map((field) => [field, row?.[field]])),
          rows: [],
        };
        record.rows.push(row);
        records.set(key, record);
      }
      const outputColumns = stage.outputs.map((output) => ({
        name: output.outputField,
        bizName: output.outputField,
        showType: 'NUMBER',
        type: output.type === 'COUNT_IF' ? 'INTEGER' : 'DECIMAL',
      }));
      state.columns = [...groupColumns, ...outputColumns];
      state.rows = [...records.values()].map((record) => {
        const output = { ...record.values };
        for (const definition of stage.outputs) {
          if (definition.type === 'COUNT_IF') {
            output[definition.outputField] = record.rows.filter(
              (row) => matchesPredicate(row, definition.predicate, fieldPeriods),
            ).length;
          } else if (definition.type === 'AGGREGATE') {
            output[definition.outputField] = aggregateValues(
              record.rows.map((row) => row?.[definition.metric]),
              definition.aggregator,
            );
          } else if (definition.type === 'CONDITIONAL_AGGREGATE') {
            const values = record.rows
              .filter((row) => matchesPredicate(row, definition.predicate, fieldPeriods))
              .map((row) => row?.[definition.metric]);
            output[definition.outputField] = aggregateValues(values, definition.aggregator);
          }
        }
        return output;
      });
      continue;
    }
    if (stage.type === 'SORT') {
      state.rows = [...state.rows].sort((left, right) => {
        for (const order of stage.order) {
          const leftValue = asNumber(left?.[order.field]);
          const rightValue = asNumber(right?.[order.field]);
          const comparison = leftValue !== null && rightValue !== null
            ? leftValue - rightValue
            : text(left?.[order.field]).localeCompare(
              text(right?.[order.field]),
              'zh-CN',
              { numeric: true },
            );
          if (comparison !== 0) {
            return order.direction === 'ASC' ? comparison : -comparison;
          }
        }
        return 0;
      });
      continue;
    }
    if (stage.type === 'LIMIT') {
      state.rows = state.rows.slice(0, stage.value);
      continue;
    }
    if (stage.type === 'SELECT_COLUMNS') {
      const selected = stage.fields.map((field) => (
        requireColumn(state.columns, field, stage.id)
      ));
      state.columns = selected;
      state.rows = state.rows.map((row) => (
        Object.fromEntries(stage.fields.map((field) => [field, row?.[field]]))
      ));
    }
  }
  return state;
}

function aggregateValues(values, aggregator) {
  const numbers = (values ?? []).map(asNumber).filter((value) => value !== null);
  const normalized = text(aggregator).toUpperCase();
  if (normalized === 'COUNT_DISTINCT') {
    return new Set(numbers.map((value) => text(value)).filter(Boolean)).size;
  }
  if (normalized === 'COUNT') {
    return numbers.length;
  }
  if (numbers.length === 0) {
    return null;
  }
  if (normalized === 'AVG') {
    return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  }
  if (normalized === 'MIN') {
    return Math.min(...numbers);
  }
  if (normalized === 'MAX') {
    return Math.max(...numbers);
  }
  return numbers.reduce((sum, value) => sum + value, 0);
}
