function columnKey(column) {
  return String(column?.bizName ?? column?.nameEn ?? column?.name ?? '').trim();
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isNumericColumn(column) {
  const type = String(column?.showType ?? column?.type ?? '').toUpperCase();
  const formatType = String(column?.dataFormatType ?? '').toLowerCase();
  return ['NUMBER', 'DECIMAL', 'FLOAT', 'INT', 'INTEGER'].includes(type)
    || ['number', 'percent', 'currency', 'quantity'].includes(formatType);
}

function isRateColumn(column) {
  const format = String(column?.presentationType ?? column?.dataFormatType ?? '').toLowerCase();
  const unit = String(column?.unit ?? '').toLowerCase();
  return format === 'percent'
    || unit.includes('%')
    || /rate|ratio/.test(format);
}

function isTimeLikeColumn(column) {
  const name = String(column?.name ?? column?.bizName ?? '').toLowerCase();
  return ['date', 'time', 'month', 'quarter', 'year', 'week', 'day', '日期', '时间', '月份', '季度', '年份'].some(
    (token) => name.includes(token),
  );
}

function round(value, precision = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  const factor = 10 ** precision;
  return Math.round(number * factor) / factor;
}

function sortRows(rows, dimensionKey, metricKey) {
  return [...(rows ?? [])].sort((left, right) => {
    const leftMetric = numericValue(left?.[metricKey]);
    const rightMetric = numericValue(right?.[metricKey]);
    if (leftMetric === null && rightMetric === null) {
      return 0;
    }
    if (leftMetric === null) {
      return 1;
    }
    if (rightMetric === null) {
      return -1;
    }
    if (leftMetric !== rightMetric) {
      return rightMetric - leftMetric;
    }
    return String(left?.[dimensionKey] ?? '').localeCompare(
      String(right?.[dimensionKey] ?? ''),
      'zh-CN',
      { numeric: true },
    );
  });
}

function topBottom(rows, dimension, metric, limit = 3) {
  const dimensionKey = columnKey(dimension);
  const metricKey = columnKey(metric);
  const sorted = sortRows(rows, dimensionKey, metricKey);
  return {
    top: sorted.slice(0, limit).map((row) => ({
      label: String(row?.[dimensionKey] ?? ''),
      value: numericValue(row?.[metricKey]),
    })),
    bottom: [...sorted].reverse().slice(0, limit).map((row) => ({
      label: String(row?.[dimensionKey] ?? ''),
      value: numericValue(row?.[metricKey]),
    })),
  };
}

function trend(rows, dimension, metric) {
  const dimensionKey = columnKey(dimension);
  const metricKey = columnKey(metric);
  const ordered = [...(rows ?? [])].sort((left, right) => (
    String(left?.[dimensionKey] ?? '').localeCompare(
      String(right?.[dimensionKey] ?? ''),
      'zh-CN',
      { numeric: true },
    )
  ));
  const first = ordered[0];
  const last = ordered.at(-1);
  const firstValue = first ? numericValue(first?.[metricKey]) : null;
  const lastValue = last ? numericValue(last?.[metricKey]) : null;
  if (!first || !last || firstValue === null || lastValue === null) {
    return null;
  }
  const change = round(lastValue - firstValue, 4);
  const changeRate = firstValue !== 0
    ? round((lastValue - firstValue) / Math.abs(firstValue), 6)
    : null;
  return {
    dimension: dimension?.name ?? dimensionKey,
    metric: metric?.name ?? metricKey,
    firstLabel: String(first?.[dimensionKey] ?? ''),
    lastLabel: String(last?.[dimensionKey] ?? ''),
    firstValue: round(firstValue),
    lastValue: round(lastValue),
    change: round(change),
    changeRate,
  };
}

function anomalies(rows, metric) {
  const metricKey = columnKey(metric);
  const values = rows
    .map((row, index) => ({
      index,
      row,
      value: numericValue(row?.[metricKey]),
    }))
    .filter((item) => item.value !== null);
  if (values.length < 4) {
    return [];
  }
  const mean = values.reduce((sum, item) => sum + item.value, 0) / values.length;
  const deviation = Math.sqrt(
    values.reduce((sum, item) => sum + ((item.value - mean) ** 2), 0) / values.length,
  );
  if (!Number.isFinite(deviation) || deviation === 0) {
    return [];
  }
  return values
    .filter((item) => Math.abs((item.value - mean) / deviation) >= 1.5)
    .map((item) => ({
      rowIndex: item.index,
      value: round(item.value),
      zScore: round((item.value - mean) / deviation, 3),
    }));
}

export function analyzeResultFacts({
  columns = [],
  rows = [],
  topLimit = 3,
}) {
  const metricColumns = columns.filter(isNumericColumn);
  const dimensionColumns = columns.filter((column) => !isNumericColumn(column));
  const facts = {
    rowCount: rows.length,
    columnCount: columns.length,
    metricTotals: metricColumns.filter((column) => !isRateColumn(column)).map((column) => ({
      column: columnKey(column),
      name: column.name ?? columnKey(column),
      total: round(rows.reduce((sum, row) => (
        sum + (numericValue(row?.[columnKey(column)]) ?? 0)
      ), 0)),
    })),
    primaryValues: metricColumns.map((column) => ({
      column: columnKey(column),
      name: column.name ?? columnKey(column),
      value: rows.length === 1 ? numericValue(rows[0]?.[columnKey(column)]) : null,
      isRate: isRateColumn(column),
    })),
    nullCounts: metricColumns.map((column) => ({
      column: columnKey(column),
      count: rows.filter((row) => numericValue(row?.[columnKey(column)]) === null).length,
    })),
    zeroCounts: metricColumns.map((column) => ({
      column: columnKey(column),
      count: rows.filter((row) => numericValue(row?.[columnKey(column)]) === 0).length,
    })),
    topBottom: [],
    trends: [],
    anomalies: [],
    categoryCounts: dimensionColumns.map((column) => ({
      column: columnKey(column),
      name: column.name ?? columnKey(column),
      distinct: new Set(rows.map((row) => String(row?.[columnKey(column)] ?? ''))).size,
    })),
  };
  const primaryDimension = dimensionColumns.find(isTimeLikeColumn)
    ?? dimensionColumns.find((column) => (
      columnKey(column) !== '__period'
    ));
  for (const metric of metricColumns) {
    if (primaryDimension && rows.length > 1) {
      facts.topBottom.push({
        metric: columnKey(metric),
        name: metric.name ?? columnKey(metric),
        dimension: primaryDimension.name ?? columnKey(primaryDimension),
        ...topBottom(rows, primaryDimension, metric, topLimit),
      });
      if (isTimeLikeColumn(primaryDimension)) {
        const trendResult = trend(rows, primaryDimension, metric);
        if (trendResult) {
          facts.trends.push(trendResult);
        }
      }
    }
    facts.anomalies.push({
      metric: columnKey(metric),
      name: metric.name ?? columnKey(metric),
      points: anomalies(rows, metric),
    });
  }
  return facts;
}

export function buildResultAnalysisText(facts, {
  topLimit = 3,
} = {}) {
  const lines = [];
  if (facts.rowCount === 0) {
    return '**结果分析**\n- 当前条件下未返回数据。';
  }
  lines.push(`共 ${facts.rowCount} 行，${facts.columnCount} 列。`);
  for (const total of facts.metricTotals ?? []) {
    lines.push(`${total.name}合计 ${total.total}`);
  }
  for (const item of facts.primaryValues ?? []) {
    if (item.value !== null && item.value !== undefined) {
      lines.push(
        item.isRate
          ? `${item.name} ${(item.value * 100).toFixed(2)}%`
          : `${item.name} ${item.value}`,
      );
    }
  }
  for (const item of facts.topBottom ?? []) {
    const topText = item.top
      .slice(0, topLimit)
      .map((row) => `${row.label} ${row.value}`)
      .join('、');
    if (topText) {
      lines.push(`${item.name} TOP${Math.min(topLimit, item.top.length)}：${topText}`);
    }
  }
  for (const trend of facts.trends ?? []) {
    const direction = (trend.change ?? 0) > 0
      ? '上升'
      : (trend.change ?? 0) < 0
        ? '下降'
        : '持平';
    const rateText = trend.changeRate === null
      ? ''
      : `，变化率 ${(trend.changeRate * 100).toFixed(2)}%`;
    lines.push(`${trend.metric}趋势：${trend.firstLabel} ${trend.firstValue} -> ${trend.lastLabel} ${trend.lastValue}，${direction}${rateText}`);
  }
  for (const anomaly of facts.anomalies ?? []) {
    if (anomaly.points.length > 0) {
      lines.push(`${anomaly.name}异常点：${anomaly.points.map((point) => point.value).join('、')}`);
    }
  }
  return `**结果分析**\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

export function buildResultAnalysisPrompt(facts) {
  return [
    '请基于以下确定性结果事实生成简洁业务解读。不得编造事实之外的数字；每个判断必须引用行、字段、合计、趋势或异常点。',
    JSON.stringify(facts, null, 2),
  ].join('\n');
}
