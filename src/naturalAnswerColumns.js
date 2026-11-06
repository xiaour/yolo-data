import { formatPresentationCell } from './resultPresentation.js';

const DATE_DIMENSION_PATTERN =
  /(^|_)(date|time|day|week|month|quarter|year)($|_)|sdt|日期|时间|账期|月份/i;

export function columnKey(column) {
  return String(column?.bizName ?? column?.nameEn ?? column?.name ?? '').trim();
}

export function columnLabel(column) {
  return String(column?.name ?? column?.bizName ?? '').trim();
}

function isNumericColumn(column) {
  return ['NUMBER', 'DECIMAL'].includes(
    String(column?.showType ?? column?.type ?? '').toUpperCase(),
  );
}

function isDateColumn(column) {
  return DATE_DIMENSION_PATTERN.test(columnKey(column));
}

function findColumn(columns, key) {
  return (columns ?? []).find((column) => columnKey(column) === key) ?? null;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value ?? '');
  }
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(number);
}

export function formatValue(value, column) {
  if (column?.presentationType) {
    return formatPresentationCell(value, column);
  }
  if (String(column?.dataFormatType ?? '').toLowerCase() === 'percent') {
    const number = Number(value);
    const decimals = Number.isInteger(Number(column?.displayDecimals))
      ? Math.max(0, Math.min(6, Number(column.displayDecimals)))
      : 2;
    return Number.isFinite(number)
      ? `${(number * 100).toFixed(decimals)}%`
      : String(value ?? '');
  }
  return formatNumber(value);
}

export function resolveMetric(columns, contract) {
  const goalOutput = (contract?.analysisGoals ?? [])
    .map((goal) => goal.outputField)
    .find((key) => findColumn(columns, key));
  if (goalOutput) {
    return findColumn(columns, goalOutput);
  }
  const derivedOutput = (contract?.derivedMetrics ?? [])
    .filter((metric) => metric.internal !== true)
    .map((metric) => metric.outputField)
    .find((key) => findColumn(columns, key));
  if (derivedOutput) {
    return findColumn(columns, derivedOutput);
  }
  const key = (contract?.metrics ?? []).find((item) => findColumn(columns, item));
  return (key ? findColumn(columns, key) : null)
    ?? (columns ?? []).find(isNumericColumn)
    ?? null;
}

export function resolveBreakdownDimension(columns, contract) {
  const keys = (contract?.dimensions ?? []).length > 0
    ? contract.dimensions
    : columns.map(columnKey);
  return keys
    .map((key) => findColumn(columns, key))
    .find((column) => (
      column
      && columnKey(column) !== '__period'
      && !isNumericColumn(column)
      && !isDateColumn(column)
    )) ?? null;
}

function resolveDateDimension(columns, contract) {
  const keys = (contract?.dimensions ?? []).length > 0
    ? contract.dimensions
    : columns.map(columnKey);
  return keys
    .map((key) => findColumn(columns, key))
    .find(isDateColumn) ?? (columns ?? []).find(isDateColumn) ?? null;
}

export function temporalPeriods(columns, rows, contract) {
  const dimension = resolveDateDimension(columns, contract);
  const key = dimension ? columnKey(dimension) : '';
  if (!key) {
    return [];
  }
  return [...new Set(
    (rows ?? []).map((row) => String(row?.[key] ?? '').trim()).filter(Boolean),
  )].sort((left, right) => left.localeCompare(right));
}

export function formatTemporalPeriod(value, timeGrain) {
  const text = String(value ?? '');
  const match = text.match(/^(\d{4})-(\d{2})/);
  if (!match) {
    return text;
  }
  switch (String(timeGrain ?? '').toUpperCase()) {
    case 'MONTH':
      return `${match[1]}-${match[2]}`;
    case 'QUARTER':
      return `${match[1]}-Q${Math.floor((Number(match[2]) - 1) / 3) + 1}`;
    case 'YEAR':
      return match[1];
    default:
      return text;
  }
}

