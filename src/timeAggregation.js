const GRAIN_LABELS = {
  WEEK: '周起始日',
  MONTH: '月份',
  QUARTER: '季度起始日',
  YEAR: '年份',
};

function columnKey(column) {
  return String(column?.bizName ?? column?.nameEn ?? column?.name ?? '').trim();
}

function isNumericColumn(column) {
  return String(column?.showType ?? column?.type ?? '').toUpperCase() === 'NUMBER'
    || String(column?.type ?? '').toUpperCase() === 'DECIMAL';
}

function parseDate(value) {
  const text = String(value ?? '').slice(0, 10);
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function startOfWeek(value) {
  const date = parseDate(value);
  if (!date) {
    return String(value ?? '');
  }
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - weekday + 1);
  return formatDate(date);
}

function startOfMonth(value) {
  const date = parseDate(value);
  return date
    ? formatDate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)))
    : String(value ?? '');
}

function startOfQuarter(value) {
  const date = parseDate(value);
  if (!date) {
    return String(value ?? '');
  }
  const month = Math.floor(date.getUTCMonth() / 3) * 3;
  return formatDate(new Date(Date.UTC(date.getUTCFullYear(), month, 1)));
}

function startOfYear(value) {
  const date = parseDate(value);
  return date
    ? `${date.getUTCFullYear()}-01-01`
    : String(value ?? '');
}

function bucketValue(value, grain) {
  if (grain === 'WEEK') {
    return startOfWeek(value);
  }
  if (grain === 'MONTH') {
    return startOfMonth(value);
  }
  if (grain === 'QUARTER') {
    return startOfQuarter(value);
  }
  if (grain === 'YEAR') {
    return startOfYear(value);
  }
  return String(value ?? '').slice(0, 10);
}

function isAverageMetric(column) {
  return /率|占比|比例|单价|均价|均值/.test(String(column?.name ?? ''));
}

export function aggregateRowsByTimeGrain({
  columns,
  rows,
  dateKey,
  grain,
}) {
  const normalizedGrain = String(grain ?? '').toUpperCase();
  if (
    !['WEEK', 'MONTH', 'QUARTER', 'YEAR'].includes(normalizedGrain)
    || !dateKey
  ) {
    return { columns, rows, grain: normalizedGrain || null };
  }
  const dimensionColumns = (columns ?? []).filter((column) => (
    !isNumericColumn(column)
    && columnKey(column) !== dateKey
  ));
  const metricColumns = (columns ?? []).filter(isNumericColumn);
  const groups = new Map();

  for (const row of rows ?? []) {
    const bucket = bucketValue(row?.[dateKey], normalizedGrain);
    const dimensionValues = dimensionColumns.map((column) => [
      columnKey(column),
      row?.[columnKey(column)],
    ]);
    const key = JSON.stringify([bucket, ...dimensionValues]);
    if (!groups.has(key)) {
      groups.set(key, {
        bucket,
        dimensionValues,
        metrics: new Map(),
      });
    }
    const group = groups.get(key);
    for (const metric of metricColumns) {
      const keyName = columnKey(metric);
      const value = Number(row?.[keyName]);
      if (!Number.isFinite(value)) {
        continue;
      }
      const current = group.metrics.get(keyName) ?? {
        total: 0,
        count: 0,
        average: isAverageMetric(metric),
      };
      current.total += value;
      current.count += 1;
      group.metrics.set(keyName, current);
    }
  }

  const aggregatedRows = [...groups.values()]
    .map((group) => {
      const row = Object.fromEntries(group.dimensionValues);
      row[dateKey] = group.bucket;
      for (const [key, metric] of group.metrics.entries()) {
        row[key] = metric.average && metric.count > 0
          ? metric.total / metric.count
          : metric.total;
      }
      return row;
    })
    .sort((left, right) => String(left[dateKey]).localeCompare(String(right[dateKey])));

  return {
    columns: (columns ?? []).map((column) => (
      columnKey(column) === dateKey
        ? { ...column, name: GRAIN_LABELS[normalizedGrain], nameEn: dateKey }
        : column
    )),
    rows: aggregatedRows,
    grain: normalizedGrain,
  };
}

export { GRAIN_LABELS };
