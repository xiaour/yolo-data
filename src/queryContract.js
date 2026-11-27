import crypto from 'node:crypto';
import { CONTRACT_COMPILER_VERSION } from './contractVersion.js';
import { normalizeMetricSpecs } from './scopedMetrics.js';
import {
  buildDeterministicSummary,
  buildQueryScopeSummary,
  contractTimeText,
  dateRangeText,
  formatNumber,
  normalizeFilters as normalizeContractFilters,
  normalizeValue as normalizeContractValue,
  stableSerialize as serializeStableValue,
} from './resultSummary.js';
import {
  compareText,
  normalizeCalculation,
  normalizeDateInfo,
  normalizePostProcessing,
  normalizeTimeWindows,
  uniqueSortedStrings,
  uniqueStrings,
} from './queryContractNormalize.js';
const DATE_DIMENSION_PATTERN =
  /(^|_)(date|time|day|week|month|quarter|year)($|_)|sdt|日期|时间|账期/i;
const RANKING_PATTERN = /排名|排行|榜单|对比|top\s*\d*|前\s*\d+|最高|最大|最多/i;
const BOTTOM_RANKING_PATTERN = /最低|最小|最少|倒数|后\s*\d+/i;

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
  return serializeStableValue(columns.map((column) => row?.[columnKey(column)]));
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

export function buildQueryContract({
  indicatorId,
  metrics = [], metricSpecs = [],
  derivedMetrics = [],
  analysisGoals = [],
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
  limitPolicy = null,
} = {}) {
  const normalizedTimeGrain = String(timeGrain ?? '').toUpperCase();
  const normalizedAnalysisMode = String(analysisMode ?? '').toUpperCase();
  const normalizedMetricSpecs = normalizeMetricSpecs(metricSpecs); const contractMetrics = normalizedMetricSpecs.length > 0 ? normalizedMetricSpecs.map((metric) => metric.outputField) : metrics;
  const normalizedLimitPolicy = limitPolicy && typeof limitPolicy === 'object'
    ? { ...limitPolicy }
    : null;
  const limitCeiling = analysisPipeline
    ? 50000
    : normalizedLimitPolicy?.expectedRowDensity === 'HIGH'
      ? 10000
      : 2000;
  return {
    version: 1,
    compilerVersion: CONTRACT_COMPILER_VERSION,
    indicatorId: String(indicatorId ?? ''),
    metrics: uniqueSortedStrings(contractMetrics), metricSpecs: normalizedMetricSpecs,
    internalMetrics: uniqueSortedStrings([...(internalMetrics ?? []), ...normalizedMetricSpecs.filter((metric) => metric.internal).map((metric) => metric.outputField)]),
    derivedMetrics: (derivedMetrics ?? []).map((metric) => ({ ...metric })),
    analysisGoals: (analysisGoals ?? []).map((goal) => ({
      ...goal,
      groupBy: [...(goal.groupBy ?? [])],
      conditionIds: [...(goal.conditionIds ?? [])],
    })),
    dimensions: uniqueSortedStrings(dimensions),
    filters: normalizeContractFilters(filters),
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
        limitCeiling,
      ),
    ),
    limitPolicy: normalizedLimitPolicy,
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
  return hash(serializeStableValue(contract));
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
    dataHash: hash(serializeStableValue({
      columns: stableColumns.map(columnKey),
      rows: stableRows.map((row) => stableColumns.map((column) => (
        normalizeContractValue(row?.[columnKey(column)])
      ))),
    })),
  };
}

export {
  buildDeterministicSummary,
  buildQueryScopeSummary,
  contractTimeText,
  dateRangeText,
  formatNumber,
  normalizeContractFilters as normalizeFilters,
  serializeStableValue as stableSerialize,
};
