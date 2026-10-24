import { getPlatformLexicon, profileHintPattern } from './businessLexicon.js';

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function columnKey(column) {
  return String(column?.bizName ?? column?.nameEn ?? column?.name ?? '').trim();
}

function isNumericColumn(column) {
  return String(column?.showType ?? column?.type ?? '').toUpperCase() === 'NUMBER'
    || String(column?.type ?? '').toUpperCase() === 'DECIMAL';
}

function clonePayload(payload) { return JSON.parse(JSON.stringify(payload ?? {})); }

function addSummaryRow(payload, params = {}) {
  const columns = payload.data?.columns ?? [];
  const rows = payload.data?.rows ?? [];
  const summary = {};
  let labelKey = String(
    params.labelColumn
    ?? columnKey(columns.find((column) => !isNumericColumn(column)) ?? {}),
  );
  if (!labelKey) {
    labelKey = '__row_label';
    payload.data.columns = [
      {
        name: String(params.labelColumnName ?? '汇总项'),
        bizName: labelKey,
        showType: 'CATEGORY',
        type: 'STRING',
      },
      ...columns,
    ];
  }
  if (labelKey) {
    summary[labelKey] = String(params.label ?? '汇总');
  }
  for (const column of columns) {
    const key = columnKey(column);
    if (!key || key === labelKey || !isNumericColumn(column)) {
      continue;
    }
    const values = rows.map((row) => asNumber(row?.[key])).filter((value) => value !== null);
    if (values.length === 0) {
      continue;
    }
    const label = String(column.name ?? '');
    const isAverage = ['rate', 'average'].some((hint) => profileHintPattern(getPlatformLexicon(), hint)?.test(label))
      || String(params.averageColumns ?? '').split(',').includes(key);
    summary[key] = isAverage
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : values.reduce((sum, value) => sum + value, 0);
  }
  const position = String(params.position ?? 'top');
  payload.data.rows = position === 'bottom'
    ? [...rows, summary]
    : [summary, ...rows];
  return payload;
}

function sortRows(payload, params = {}) {
  const field = String(params.field ?? '');
  if (!field) {
    throw new Error('sort requires field');
  }
  const direction = String(params.direction ?? 'DESC').toUpperCase() === 'ASC' ? 1 : -1;
  payload.data.rows = [...(payload.data?.rows ?? [])].sort((left, right) => {
    const leftNumber = asNumber(left?.[field]);
    const rightNumber = asNumber(right?.[field]);
    if (leftNumber !== null && rightNumber !== null) {
      return (leftNumber - rightNumber) * direction;
    }
    return String(left?.[field] ?? '').localeCompare(
      String(right?.[field] ?? ''),
      'zh-CN',
      { numeric: true },
    ) * direction;
  });
  return payload;
}

function renameColumn(payload, params = {}) {
  const field = String(params.field ?? params.bizName ?? '');
  const name = String(params.name ?? '').trim();
  if (!field || !name) {
    throw new Error('rename_column requires field and name');
  }
  const column = (payload.data?.columns ?? []).find((item) => columnKey(item) === field);
  if (!column) {
    throw new Error(`column not found: ${field}`);
  }
  column.name = name;
  return payload;
}

function formatColumn(payload, params = {}) {
  const field = String(params.field ?? params.bizName ?? '');
  const column = (payload.data?.columns ?? []).find((item) => columnKey(item) === field);
  if (!column) {
    throw new Error(`column not found: ${field}`);
  }
  column.decimals = Number.isFinite(Number(params.decimals))
    ? Number(params.decimals)
    : column.decimals;
  column.unit = params.unit ?? column.unit;
  return payload;
}

function addRatioColumn(payload, params = {}) {
  const numerator = String(params.numerator ?? '');
  const denominator = String(params.denominator ?? '');
  const field = String(params.field ?? 'ratio');
  if (!numerator || !denominator) {
    throw new Error('add_ratio_column requires numerator and denominator');
  }
  payload.data.columns = [
    ...(payload.data?.columns ?? []),
    {
      name: String(params.name ?? '比例'),
      bizName: field,
      showType: 'NUMBER',
      type: 'DECIMAL',
      unit: params.unit ?? '%',
    },
  ];
  payload.data.rows = (payload.data?.rows ?? []).map((row) => {
    const top = asNumber(row?.[numerator]);
    const bottom = asNumber(row?.[denominator]);
    return {
      ...row,
      [field]: top === null || bottom === null || bottom === 0
        ? null
        : Number(params.percent ?? true) ? (top / bottom) * 100 : top / bottom,
    };
  });
  return payload;
}

function filterRows(payload, params = {}) {
  const field = String(params.field ?? '');
  if (!field) {
    throw new Error('filter_rows requires field');
  }
  const operator = String(params.operator ?? '=').toUpperCase();
  const expected = params.value;
  payload.data.rows = (payload.data?.rows ?? []).filter((row) => {
    const actual = row?.[field];
    if (operator === '!=') {
      return String(actual) !== String(expected);
    }
    if (operator === '>') {
      return Number(actual) > Number(expected);
    }
    if (operator === '>=') {
      return Number(actual) >= Number(expected);
    }
    if (operator === '<') {
      return Number(actual) < Number(expected);
    }
    if (operator === '<=') {
      return Number(actual) <= Number(expected);
    }
    return String(actual) === String(expected);
  });
  return payload;
}

function limitRows(payload, params = {}) {
  const limit = Math.max(1, Math.min(Number(params.limit) || 200, 5000));
  payload.data.rows = (payload.data?.rows ?? []).slice(0, limit);
  return payload;
}

const OPERATIONS = {
  add_summary_row: addSummaryRow,
  sort: sortRows,
  rename_column: renameColumn,
  format_column: formatColumn,
  add_ratio_column: addRatioColumn,
  filter_rows: filterRows,
  limit_rows: limitRows,
};

export { clonePayload, columnKey, OPERATIONS };
