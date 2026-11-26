import { getDialect } from './dialects/index.js';
import {
  appendPredicateFilter,
  metricOutputField,
  normalizeDatasetFilters,
} from './scopedMetrics.js';

const TIME_GRAINS = new Set(['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR']);

// 把数据集元数据（字段、角色、聚合）编译成只读 SQL。输入只依赖元数据和请求，
// 不触达连接池与平台库，保持纯函数以便逐段验证生成的语句。
export function buildDatasetQuery(dataset, fields, request, { probeLimit = false } = {}) {
  const dialect = getDialect(dataset.dbType);
  const quoteIdentifier = dialect.quoteIdentifier;
  const fieldsByName = new Map(fields.map((field) => [field.fieldName, field]));
  const dimensions = [...new Set((request.dimensions ?? []).map(String))]
    .map((name) => fieldsByName.get(name))
    .filter(Boolean);
  const requestedTimeGrain = String(request.timeGrain ?? '').toUpperCase();
  const dimensionSelections = dimensions.map((dimension) => ({
    field: dimension,
    expression: dimension.role === 'TIME' && TIME_GRAINS.has(requestedTimeGrain)
      ? dialect.timeGrainExpr(quoteIdentifier(dimension.fieldName), requestedTimeGrain)
      : quoteIdentifier(dimension.fieldName),
  }));
  const metrics = (request.metrics ?? []).map((item) => {
    const fieldName = typeof item === 'string' ? item : item.field;
    const field = fieldsByName.get(String(fieldName));
    if (!field) {
      throw new Error(`dataset metric field not found: ${fieldName}`);
    }
    const aggregator = String(item?.aggregator ?? field.aggregator ?? 'SUM').toUpperCase();
    if (!['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNT_DISTINCT'].includes(aggregator)) {
      throw new Error(`unsupported aggregator: ${aggregator}`);
    }
    return {
      field,
      aggregator,
      outputField: metricOutputField(item, field.fieldName),
      predicateFilters: normalizeDatasetFilters(
        item?.predicateFilters ?? [],
        fieldsByName,
      ),
    };
  });
  if (metrics.length === 0 && dimensions.length === 0) {
    throw new Error('dataset query requires metrics or dimensions');
  }
  const filters = normalizeDatasetFilters(request.filters, fieldsByName);
  const selectValues = [];
  const selectParts = [];
  for (const dimension of dimensionSelections) {
    selectParts.push(
      `${dimension.expression} AS ${quoteIdentifier(dimension.field.fieldName)}`,
    );
  }
  for (const metric of metrics) {
    const column = quoteIdentifier(metric.field.fieldName);
    let expression;
    if (metric.predicateFilters.length === 0) {
      expression = metric.aggregator === 'COUNT_DISTINCT'
        ? dialect.countDistinct(column)
        : `${metric.aggregator}(${column})`;
    } else {
      const predicateParts = [];
      for (const filter of metric.predicateFilters) {
        appendPredicateFilter(filter, predicateParts, selectValues, quoteIdentifier);
      }
      const predicate = predicateParts.join(' AND ');
      if (metric.aggregator === 'COUNT_DISTINCT') {
        expression = dialect.countDistinct(`CASE WHEN ${predicate} THEN ${column} END`);
      } else if (metric.aggregator === 'COUNT') {
        expression = `COUNT(CASE WHEN ${predicate} THEN 1 END)`;
      } else if (metric.aggregator === 'SUM') {
        expression = `SUM(CASE WHEN ${predicate} THEN ${column} ELSE 0 END)`;
      } else {
        expression = `${metric.aggregator}(CASE WHEN ${predicate} THEN ${column} END)`;
      }
    }
    selectParts.push(`${expression} AS ${quoteIdentifier(metric.outputField)}`);
  }
  const whereParts = [];
  const havingParts = [];
  const whereValues = [];
  const havingValues = [];
  const metricSelectionByField = new Map(
    metrics.map((metric) => [metric.field.fieldName, metric]),
  );
  const filterExpression = (filter) => {
    const selectedMetric = metricSelectionByField.get(filter.field.fieldName);
    const aggregateFilter = filter.scope === 'AGGREGATE'
      || filter.field.role === 'METRIC';
    if (!aggregateFilter) {
      return quoteIdentifier(filter.field.fieldName);
    }
    const aggregator = selectedMetric?.aggregator
      ?? String(filter.field.aggregator ?? 'SUM').toUpperCase();
    return aggregator === 'COUNT_DISTINCT'
      ? dialect.countDistinct(quoteIdentifier(filter.field.fieldName))
      : `${aggregator}(${quoteIdentifier(filter.field.fieldName)})`;
  };
  const appendFilter = (filter) => {
    const aggregateFilter = filter.scope === 'AGGREGATE'
      || filter.field.role === 'METRIC';
    const parts = aggregateFilter ? havingParts : whereParts;
    const filterValues = aggregateFilter ? havingValues : whereValues;
    const expression = filterExpression(filter);
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
      filterValues.push(...list);
      return;
    }
    if (filter.operator === 'BETWEEN') {
      const list = Array.isArray(filter.value) ? filter.value : [];
      if (list.length !== 2) {
        throw new Error(`BETWEEN requires two values for ${filter.field.fieldName}`);
      }
      parts.push(`${expression} BETWEEN ? AND ?`);
      filterValues.push(list[0], list[1]);
      return;
    }
    parts.push(`${expression} ${filter.operator} ?`);
    filterValues.push(filter.value);
  };
  for (const filter of filters) {
    appendFilter(filter);
  }
  const dateRange = request.dateRange ?? null;
  if (dateRange) {
    const dateField = dateRange.field
      ? fieldsByName.get(String(dateRange.field))
      : fields.find((field) => field.role === 'TIME');
    if (!dateField || dateField.role !== 'TIME') {
      throw new Error('dataset time field not found');
    }
    const column = quoteIdentifier(dateField.fieldName);
    if (dateRange.startDate) {
      whereParts.push(`${column} >= ?`);
      whereValues.push(dateRange.startDate);
    }
    if (dateRange.endDate) {
      whereParts.push(`${column} <= ?`);
      whereValues.push(dateRange.endDate);
    }
  }
  const groupBy = dimensions.length > 0 && metrics.length > 0
    ? ` GROUP BY ${dimensionSelections.map((dimension) => dimension.expression).join(', ')}`
    : '';
  const orderParts = [];
  const groupedTimeDimension = dimensionSelections.find(
    (dimension) => dimension.field.role === 'TIME',
  );
  for (const order of request.order ?? []) {
    const field = fieldsByName.get(String(order.field));
    if (!field) {
      continue;
    }
    const dimensionSelection = dimensionSelections.find(
      (dimension) => dimension.field.fieldName === field.fieldName,
    );
    const metricSelection = metricSelectionByField.get(field.fieldName);
    const orderExpression = dimensionSelection?.expression
      ?? (field.role === 'TIME' ? groupedTimeDimension?.expression : null)
      ?? (metricSelection ? quoteIdentifier(metricSelection.outputField) : null)
      ?? quoteIdentifier(field.fieldName);
    orderParts.push(
      `${orderExpression} ${String(order.direction).toUpperCase() === 'ASC' ? 'ASC' : 'DESC'}`,
    );
  }
  const orderBy = orderParts.length > 0 ? ` ORDER BY ${orderParts.join(', ')}` : '';
  const having = havingParts.length > 0
    ? ` HAVING ${havingParts.join(' AND ')}`
    : '';
  const maximumLimit = request.analysisPipeline ? 50000 : 10000;
  const probeOffset = probeLimit ? 1 : 0;
  const limit = Math.max(
    1,
    Math.min(
      (Number(request.limit) || 200) + probeOffset,
      maximumLimit + probeOffset,
    ),
  );
  const sql = `SELECT ${selectParts.join(', ')} FROM ${
    quoteIdentifier(dataset.schemaName)
  }.${quoteIdentifier(dataset.primaryTable)}${
    whereParts.length ? ` WHERE ${whereParts.join(' AND ')}` : ''
  }${groupBy}${having}${orderBy} ${dialect.limitClause()}`;
  const values = [...selectValues, ...whereValues, ...havingValues];
  values.push(limit);
  return {
    dataset,
    sql: dialect.prepareSql(sql),
    values,
    dimensions,
    timeGrain: TIME_GRAINS.has(requestedTimeGrain) ? requestedTimeGrain : null,
    metrics,
    filters,
    limit,
  };
}
