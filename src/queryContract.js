import crypto from 'node:crypto';
import { formatPresentationCell } from './resultPresentation.js';

const DATE_DIMENSION_PATTERN =
  /(^|_)(date|time|day|week|month|quarter|year)($|_)|sdt|日期|时间|账期/i;
const RANKING_PATTERN = /排名|排行|榜单|对比|top\s*\d*|前\s*\d+|最高|最大|最多/i;
const BOTTOM_RANKING_PATTERN = /最低|最小|最少|倒数|后\s*\d+/i;

function formatTemporalDisplay(value, timeGrain) {
  const text = String(value ?? '');
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (!match) {
    return text;
  }
  const [, year, month] = match;
  switch (String(timeGrain ?? '').toUpperCase()) {
    case 'MONTH':
      return `${year}-${month}`;
    case 'QUARTER':
      return `${year}-Q${Math.floor((Number(month) - 1) / 3) + 1}`;
    case 'YEAR':
      return year;
    default:
      return text;
  }
}

function normalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeValue).sort(compareSerialized);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeValue(value[key])]),
    );
  }
  return value ?? null;
}

function normalizeValuePreservingArrayOrder(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeValuePreservingArrayOrder);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeValuePreservingArrayOrder(value[key])]),
    );
  }
  return value ?? null;
}

function stableSerialize(value) {
  return JSON.stringify(normalizeValue(value));
}

function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), 'zh-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

function compareSerialized(left, right) {
  return compareText(stableSerialize(left), stableSerialize(right));
}

function uniqueSortedStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))]
    .sort(compareText);
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function normalizeFilters(filters) {
  return (filters ?? [])
    .map((filter) => {
      const operator = String(filter?.operator ?? 'IN').trim().toUpperCase();
      return {
        bizName: String(
          filter?.bizName ?? filter?.dimension ?? filter?.field ?? '',
        ).trim(),
        operator,
        value: ['IN', 'NOT_IN'].includes(operator)
          ? normalizeValue(filter?.value)
          : normalizeValuePreservingArrayOrder(filter?.value),
        scope: String(filter?.scope ?? 'ROW').toUpperCase() === 'AGGREGATE'
          ? 'AGGREGATE'
          : 'ROW',
      };
    })
    .filter((filter) => filter.bizName)
    .sort((left, right) => (
      compareText(left.bizName, right.bizName)
      || compareText(left.operator, right.operator)
      || compareSerialized(left.value, right.value)
    ));
}

function normalizeDateInfo(dateInfo) {
  if (!dateInfo) {
    return {
      dateMode: 'ALL',
      startDate: null,
      endDate: null,
      unit: null,
      period: null,
      dateField: null,
    };
  }
  const dateMode = String(dateInfo.dateMode ?? 'ALL').toUpperCase();
  const period = String(dateInfo.period ?? '').toUpperCase();
  return {
    dateMode,
    startDate: dateInfo.startDate ?? null,
    endDate: dateInfo.endDate ?? null,
    unit: dateMode === 'RECENT' ? Number(dateInfo.unit) || null : null,
    period: dateMode === 'RECENT' && period ? period : null,
    dateField: dateInfo.dateField ?? null,
    label: dateInfo.label ?? dateInfo.detectWord ?? dateInfo.expression ?? null,
    expression: dateInfo.expression ?? dateInfo.detectWord ?? null,
  };
}

function normalizeTimeWindows(timeWindows) {
  return (timeWindows ?? []).map((window) => normalizeDateInfo(window));
}

function normalizeCalculation(calculation) {
  return {
    type: String(calculation?.type ?? 'NONE').toUpperCase(),
    baseWindowIndex: Number.isInteger(calculation?.baseWindowIndex)
      ? calculation.baseWindowIndex
      : null,
    compareWindowIndex: Number.isInteger(calculation?.compareWindowIndex)
      ? calculation.compareWindowIndex
      : null,
    description: String(calculation?.description ?? ''),
    timeGrain: ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'].includes(
      String(calculation?.timeGrain ?? '').toUpperCase(),
    )
      ? String(calculation.timeGrain).toUpperCase()
      : null,
  };
}

function normalizePostProcessing(postProcessing) {
  return postProcessing && typeof postProcessing === 'object'
    ? JSON.parse(JSON.stringify(postProcessing))
    : null;
}

function columnKey(column) {
  return String(column?.bizName ?? column?.nameEn ?? column?.name ?? '').trim();
}

function isNumericColumn(column) {
  return String(column?.showType ?? column?.type ?? '').toUpperCase() === 'NUMBER'
    || String(column?.type ?? '').toUpperCase() === 'DECIMAL';
}

function isDateColumn(column) {
  return DATE_DIMENSION_PATTERN.test(columnKey(column));
}

function normalizeColumns(columns, contract) {
  if (contract?.postProcessing?.pivot || contract?.analysisPipeline) {
    return [...(columns ?? [])];
  }
  const requestedOrder = [...(contract?.dimensions ?? []), ...(contract?.metrics ?? [])];
  const order = new Map(requestedOrder.map((key, index) => [key, index]));
  return [...(columns ?? [])].sort((left, right) => {
    const leftKey = columnKey(left);
    const rightKey = columnKey(right);
    const leftOrder = order.has(leftKey) ? order.get(leftKey) : Number.MAX_SAFE_INTEGER;
    const rightOrder = order.has(rightKey) ? order.get(rightKey) : Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || compareText(leftKey, rightKey);
  });
}

function rowSignature(row, columns) {
  return stableSerialize(columns.map((column) => row?.[columnKey(column)]));
}

function compareCellValues(left, right) {
  if (left === null || left === undefined || left === '') {
    return right === null || right === undefined || right === '' ? 0 : 1;
  }
  if (right === null || right === undefined || right === '') {
    return -1;
  }
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return compareText(left, right);
}

function selectSortMetric(columns, contract) {
  const candidates = [
    ...(contract?.metrics ?? []),
    ...(columns ?? []).filter(isNumericColumn).map(columnKey),
  ];
  return candidates.find(Boolean) ?? null;
}

function sortRows({ columns, rows, contract, question }) {
  const dateColumns = (columns ?? [])
    .filter((column) => isDateColumn(column))
    .map(columnKey)
    .filter(Boolean);
  const dimensionColumns = (columns ?? [])
    .filter((column) => !isNumericColumn(column) && !isDateColumn(column))
    .map(columnKey)
    .filter(Boolean);
  const sortMetric = selectSortMetric(columns, contract);
  const periodOrder = new Map(
    (contract?.periodOrder ?? []).map((label, index) => [String(label), index]),
  );
  const ranking = RANKING_PATTERN.test(String(question ?? ''));
  const ascendingRanking = BOTTOM_RANKING_PATTERN.test(String(question ?? ''));

  return [...(rows ?? [])].sort((left, right) => {
    if (periodOrder.size > 0 && columns.some((column) => columnKey(column) === '__period')) {
      const leftPeriod = periodOrder.has(String(left?.__period))
        ? periodOrder.get(String(left.__period))
        : Number.MAX_SAFE_INTEGER;
      const rightPeriod = periodOrder.has(String(right?.__period))
        ? periodOrder.get(String(right.__period))
        : Number.MAX_SAFE_INTEGER;
      if (leftPeriod !== rightPeriod) {
        return leftPeriod - rightPeriod;
      }
    }
    if (ranking && sortMetric) {
      const metricComparison = compareCellValues(left?.[sortMetric], right?.[sortMetric]);
      if (metricComparison !== 0) {
        return ascendingRanking ? metricComparison : -metricComparison;
      }
    }

    for (const key of dateColumns) {
      const comparison = compareCellValues(left?.[key], right?.[key]);
      if (comparison !== 0) {
        return comparison;
      }
    }

    for (const key of dimensionColumns) {
      const comparison = compareCellValues(left?.[key], right?.[key]);
      if (comparison !== 0) {
        return comparison;
      }
    }

    if (!ranking && sortMetric) {
      const metricComparison = compareCellValues(left?.[sortMetric], right?.[sortMetric]);
      if (metricComparison !== 0) {
        return -metricComparison;
      }
    }

    return compareText(
      rowSignature(left, columns),
      rowSignature(right, columns),
    );
  });
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value ?? '');
  }
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 2,
  }).format(number);
}

function formatColumnValue(value, column) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value ?? '');
  }
  return column?.presentationType
    ? formatPresentationCell(value, column)
    : formatNumber(value);
}

function columnLabel(column) {
  return String(column?.name ?? column?.bizName ?? '').trim();
}

function findColumn(columns, key) {
  return (columns ?? []).find((column) => columnKey(column) === key) ?? null;
}

function filterSummary(filters, columns, filterLabels = {}) {
  return normalizeFilters(filters).map((filter) => {
    const label = filterLabels[filter.bizName]
      || columnLabel(findColumn(columns, filter.bizName))
      || filter.bizName;
    const identifier = /(^|_)(id|code)($|_)|编号|编码|代码|客户号|单号|号$/i.test(
      `${filter.bizName} ${label}`,
    );
    const renderValue = (item) => (
      identifier ? String(item ?? '') : formatNumber(item)
    );
    const value = Array.isArray(filter.value)
      ? filter.value.map(renderValue).join('、')
      : renderValue(filter.value);
    return `${label} ${filter.operator} ${value}`;
  });
}

function dateRangeText(dateInfo) {
  if (!dateInfo || dateInfo.dateMode === 'ALL') {
    return '全部时间';
  }
  if (dateInfo.startDate && dateInfo.endDate) {
    return dateInfo.startDate === dateInfo.endDate
      ? dateInfo.startDate
      : `${dateInfo.startDate} 至 ${dateInfo.endDate}`;
  }
  return '全部时间';
}

function contractTimeText(contract) {
  const windows = contract?.timeWindows ?? [];
  if (windows.length > 1) {
    return windows.map((window, index) => (
      window.label || window.expression || `期间${index + 1}`
    )).join(' vs ');
  }
  return dateRangeText(windows[0] ?? contract?.dateInfo);
}

function metricTotals(columns, rows, contract, metricDefinitions = []) {
  const definitions = new Map(
    (metricDefinitions ?? []).map((definition) => [
      String(definition.key ?? definition.field ?? ''),
      definition,
    ]),
  );
  const keys = (contract?.metrics ?? []).length > 0
    ? contract.metrics
    : columns.filter(isNumericColumn).map(columnKey).filter(Boolean);
  const periodKeys = (contract?.timeWindows ?? [])
    .map((window, index) => window.label || window.expression || `期间${index + 1}`)
    .filter(Boolean);
  return keys.map((key) => {
    const column = findColumn(columns, key);
    if (!column) {
      return null;
    }
    const definition = definitions.get(key) ?? {};
    const label = columnLabel(column) || definition.label || key;
    const aggregation = String(
      definition.aggregation ?? definition.aggregator ?? '',
    ).toUpperCase();
    const rate = /率|占比|比例/.test(label);
    const render = (values) => {
      const numeric = values.map(Number).filter(Number.isFinite);
      if (numeric.length === 0) {
        return null;
      }
      const value = rate || aggregation === 'AVG'
        ? numeric.reduce((sum, item) => sum + item, 0) / numeric.length
        : numeric.reduce((sum, item) => sum + item, 0);
      const suffix = rate || aggregation === 'AVG'
        ? '均值'
        : ['COUNT', 'COUNT_DISTINCT'].includes(aggregation)
          ? ''
          : '合计';
      return `${label}${suffix} ${formatColumnValue(value, column)}`;
    };
    if (periodKeys.length > 1 && columns.some((item) => columnKey(item) === '__period')) {
      return periodKeys.map((period) => {
        const periodRows = rows.filter((row) => row.__period === period);
        const rendered = render(periodRows.map((row) => row?.[key]));
        return rendered ? `${period}：${rendered}` : null;
      }).filter(Boolean).join('，');
    }
    return render(rows.map((row) => row?.[key]));
  }).filter(Boolean);
}

function trendFinding(columns, rows, contract) {
  if (contract?.analysisMode === 'ATTRIBUTION' || rows.length < 2) {
    return '';
  }
  const dateKey = (contract?.dimensions ?? []).find((key) => (
    isDateColumn(findColumn(columns, key))
  )) ?? columns.filter(isDateColumn).map(columnKey)[0];
  const metricKey = selectSortMetric(columns, contract);
  if (!dateKey || !metricKey) {
    return '';
  }
  const firstValue = Number(rows[0]?.[metricKey]);
  const lastValue = Number(rows.at(-1)?.[metricKey]);
  if (!Number.isFinite(firstValue) || !Number.isFinite(lastValue)) {
    return '';
  }
  const metricColumn = findColumn(columns, metricKey);
  const metricLabel = columnLabel(metricColumn) || metricKey;
  const base = `${formatTemporalDisplay(rows[0]?.[dateKey], contract?.timeGrain)}：${
    formatColumnValue(firstValue, metricColumn)}，${formatTemporalDisplay(
    rows.at(-1)?.[dateKey],
    contract?.timeGrain,
  )}：${formatColumnValue(lastValue, metricColumn)}`;
  const lastPeriod = String(rows.at(-1)?.[dateKey] ?? '');
  const rangeEnd = String(contract?.dateInfo?.endDate ?? '');
  const incompletePeriod = String(contract?.timeGrain ?? '').toUpperCase() === 'MONTH'
    && lastPeriod.slice(0, 7) === rangeEnd.slice(0, 7)
    && rangeEnd > lastPeriod
    ? `（最后一个月截至 ${rangeEnd}，为未完整月）`
    : '';
  if (firstValue === 0) {
    return `${metricLabel}从 ${base}${incompletePeriod}`;
  }
  const change = ((lastValue - firstValue) / Math.abs(firstValue)) * 100;
  return `${metricLabel}从 ${base}，区间变化 ${change >= 0 ? '+' : ''}${
    change.toFixed(1)}%${incompletePeriod}`;
}

function attributionFindings(columns, rows, contract) {
  if (contract?.analysisMode !== 'ATTRIBUTION' || rows.length < 2) {
    return [];
  }
  const periodKey = '__period';
  if (!columns.some((column) => columnKey(column) === periodKey)) {
    return [];
  }
  const dimensionColumn = (contract?.dimensions ?? [])
    .map((key) => findColumn(columns, key))
    .find((column) => (
      column
      && columnKey(column) !== periodKey
      && !isDateColumn(column)
      && !isNumericColumn(column)
    ));
  const metricKey = selectSortMetric(columns, contract);
  if (!dimensionColumn || !metricKey) {
    return [];
  }
  const dimensionKey = columnKey(dimensionColumn);
  const periods = [...new Set(rows.map((row) => String(row?.[periodKey] ?? '')).filter(Boolean))];
  const periodOrder = contract?.periodOrder ?? [];
  const baseIndex = Number.isInteger(contract?.calculation?.baseWindowIndex)
    ? contract.calculation.baseWindowIndex
    : 0;
  const compareIndex = Number.isInteger(contract?.calculation?.compareWindowIndex)
    ? contract.calculation.compareWindowIndex
    : 1;
  const currentPeriod = periodOrder[baseIndex] ?? periods[0];
  const previousPeriod = periodOrder[compareIndex] ?? periods[1];
  if (!currentPeriod || !previousPeriod) {
    return [];
  }

  const grouped = new Map();
  for (const row of rows) {
    const dimensionValue = String(row?.[dimensionKey] ?? '');
    if (!dimensionValue) {
      continue;
    }
    const current = grouped.get(dimensionValue) ?? {
      current: 0,
      previous: 0,
    };
    const value = Number(row?.[metricKey]);
    if (!Number.isFinite(value)) {
      continue;
    }
    if (String(row?.[periodKey]) === String(currentPeriod)) {
      current.current += value;
    } else if (String(row?.[periodKey]) === String(previousPeriod)) {
      current.previous += value;
    }
    grouped.set(dimensionValue, current);
  }

  const changes = [...grouped.entries()].map(([dimensionValue, values]) => ({
    dimensionValue,
    ...values,
    delta: values.current - values.previous,
  })).filter((item) => item.current !== 0 || item.previous !== 0);
  if (changes.length === 0) {
    return [];
  }
  changes.sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));
  const totalDelta = changes.reduce((sum, item) => sum + item.delta, 0);
  const metricColumn = findColumn(columns, metricKey);
  const metricLabel = columnLabel(metricColumn) || metricKey;
  const dimensionLabel = columnLabel(dimensionColumn) || dimensionKey;
  const rateMetric = /率|比例|占比|影响值/.test(metricLabel);
  return changes.slice(0, 5).map((item) => {
    const contribution = !rateMetric && Math.abs(totalDelta) > Number.EPSILON
      ? `，对整体变化贡献 ${(item.delta / totalDelta * 100).toFixed(1)}%`
      : '';
    return `${dimensionLabel}「${item.dimensionValue}」${metricLabel}变化 ${
      item.delta >= 0 ? '+' : ''
    }${formatColumnValue(item.delta, metricColumn)}${contribution}`;
  });
}

function rankingFinding(question, columns, rows, contract) {
  if (!RANKING_PATTERN.test(String(question ?? '')) || rows.length === 0) {
    return '';
  }
  const metricKey = selectSortMetric(columns, contract);
  if (!metricKey) {
    return '';
  }
  const dimensionKey = (contract?.dimensions ?? [])
    .map((key) => findColumn(columns, key))
    .find((column) => column && !isNumericColumn(column) && !isDateColumn(column));
  const metricColumn = findColumn(columns, metricKey);
  const metricLabel = columnLabel(metricColumn) || metricKey;
  if (!dimensionKey) {
    return `最高/最低值为 ${formatColumnValue(rows[0]?.[metricKey], metricColumn)}`;
  }
  const dimensionLabel = columnLabel(dimensionKey);
  return `${dimensionLabel}首位为 ${formatNumber(rows[0]?.[columnKey(dimensionKey)])}，${
    metricLabel} ${formatColumnValue(rows[0]?.[metricKey], metricColumn)}`;
}

export function buildQueryContract({
  indicatorId,
  metrics = [],
  derivedMetrics = [],
  dimensions = [],
  filters = [],
  dateInfo,
  timeGrain = null,
  limit = 200,
  timeWindows = [],
  calculation = null,
  postProcessing = null,
  periodOrder = [],
  analysisMode = null,
  attribution = null,
  semanticPolicy = null,
  semanticResolutions = [],
  internalMetrics = [],
  analysisPipeline = null,
} = {}) {
  const normalizedTimeGrain = String(timeGrain ?? '').toUpperCase();
  const normalizedAnalysisMode = String(analysisMode ?? '').toUpperCase();
  return {
    version: 1,
    indicatorId: String(indicatorId ?? ''),
    metrics: uniqueSortedStrings(metrics),
    internalMetrics: uniqueSortedStrings(internalMetrics),
    derivedMetrics: (derivedMetrics ?? []).map((metric) => ({ ...metric })),
    dimensions: uniqueSortedStrings(dimensions),
    filters: normalizeFilters(filters),
    dateInfo: normalizeDateInfo(dateInfo),
    timeWindows: normalizeTimeWindows(
      (timeWindows ?? []).length > 0 ? timeWindows : [dateInfo].filter(Boolean),
    ),
    calculation: normalizeCalculation(calculation),
    postProcessing: normalizePostProcessing(postProcessing),
    periodOrder: uniqueStrings(periodOrder),
    timeGrain: ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'].includes(normalizedTimeGrain)
      ? normalizedTimeGrain
      : null,
    limit: Math.max(
      1,
      Math.min(
        Number(limit) || 200,
        analysisPipeline ? 50000 : 2000,
      ),
    ),
    analysisMode: ['METRIC_QUERY', 'TREND', 'ATTRIBUTION'].includes(normalizedAnalysisMode)
      ? normalizedAnalysisMode
      : 'METRIC_QUERY',
    attribution: attribution && typeof attribution === 'object'
      ? { ...attribution }
      : null,
    semanticPolicy: semanticPolicy && typeof semanticPolicy === 'object'
      ? {
        ...semanticPolicy,
        matches: (semanticPolicy.matches ?? []).map((item) => ({ ...item })),
      }
      : null,
    semanticResolutions: (semanticResolutions ?? []).map((resolution) => ({
      ...resolution,
      candidates: (resolution.candidates ?? []).map((candidate) => ({
        ...candidate,
        candidate: { ...candidate.candidate },
      })),
      adjudication: { ...resolution.adjudication },
    })),
    analysisPipeline: analysisPipeline && typeof analysisPipeline === 'object'
      ? JSON.parse(JSON.stringify(analysisPipeline))
      : null,
  };
}

export function selectPublicResult({
  columns = [],
  rows = [],
  internalMetrics = [],
}) {
  const internal = new Set(
    (internalMetrics ?? []).map((field) => String(field ?? '')),
  );
  if (internal.size === 0) {
    return { columns, rows };
  }
  const publicColumns = columns.filter((column) => (
    !internal.has(String(column?.bizName ?? column?.name ?? ''))
  ));
  const publicKeys = new Set(publicColumns.map(columnKey));
  return {
    columns: publicColumns,
    rows: (rows ?? []).map((row) => Object.fromEntries(
      Object.entries(row ?? {}).filter(([key]) => publicKeys.has(key)),
    )),
  };
}

export function queryFingerprint(contract) {
  return hash(stableSerialize(contract));
}

export function stabilizeQueryResult({
  columns,
  rows,
  contract,
  question,
}) {
  const stableColumns = normalizeColumns(columns, contract);
  const stableRows = contract?.postProcessing?.pivot || contract?.analysisPipeline
    ? [...(rows ?? [])]
    : sortRows({
      columns: stableColumns,
      rows: rows ?? [],
      contract,
      question,
    });
  return {
    columns: stableColumns,
    rows: stableRows,
    dataHash: hash(stableSerialize({
      columns: stableColumns.map(columnKey),
      rows: stableRows.map((row) => stableColumns.map((column) => (
        normalizeValue(row?.[columnKey(column)])
      ))),
    })),
  };
}

export function buildDeterministicSummary({
  subjectName,
  columns = [],
  rows = [],
  contract,
  question = '',
  metricDefinitions = [],
  filterLabels = {},
}) {
  const normalizedFilters = normalizeFilters(contract?.filters);
  const dimensions = (contract?.dimensions ?? [])
    .map((key) => columnLabel(findColumn(columns, key)) || key);
  const totals = metricTotals(columns, rows, contract, metricDefinitions);
  const conclusion = rows.length === 0
    ? `在当前查询条件下未返回数据；平台没有自动调整时间范围、指标或维度。`
    : `${totals.length > 0 ? `${totals.join('，')}。` : `本次查询返回 ${rows.length} 行数据。`}`;
  const findings = [
    rankingFinding(question, columns, rows, contract),
    trendFinding(columns, rows, contract),
    ...attributionFindings(columns, rows, contract),
  ].filter(Boolean);
  const filterLines = filterSummary(normalizedFilters, columns, filterLabels);
  const scopeLines = [
    `- 指标：${subjectName || contract?.indicatorId || '-'}`,
    `- 时间：${contractTimeText(contract)}`,
    `- 维度：${dimensions.join('、') || '汇总'}`,
    `- 过滤：${filterLines.join('；') || '无额外过滤条件'}`,
  ];

  return [
    conclusion,
    ...(findings.length > 0 ? ['', '**关键结果**', ...findings.map((item) => `- ${item}`)] : []),
    '',
    '**查询范围**',
    ...scopeLines,
  ].join('\n');
}

export {
  dateRangeText,
  contractTimeText,
  formatNumber,
  normalizeFilters,
  stableSerialize,
};
