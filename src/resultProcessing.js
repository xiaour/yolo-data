function text(value) {
  return String(value ?? '').trim();
}

function compact(value) {
  return text(value)
    .toLowerCase()
    .replace(/[\s,，.。;；:：!！?？、"'“”‘’()[\]{}_\-/\\]+/g, '');
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function columnKey(column) {
  return text(column?.bizName ?? column?.nameEn ?? column?.name);
}

function isNumericColumn(column) {
  return String(column?.showType ?? column?.type ?? '').toUpperCase() === 'NUMBER'
    || String(column?.type ?? '').toUpperCase() === 'DECIMAL';
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).map(text).filter(Boolean))];
}

function requireColumn(columns, field) {
  const column = (columns ?? []).find((item) => columnKey(item) === text(field));
  if (!column) {
    throw new Error(`post-processing column not found: ${field}`);
  }
  return column;
}

export function applyValueGrouping({ columns, rows, config = {} }) {
  const field = text(config.field);
  const outputField = text(config.outputField);
  if (!field || !outputField) {
    throw new Error('group_values requires field and outputField');
  }
  const sourceColumn = requireColumn(columns, field);
  const groups = (config.groups ?? []).map((group) => ({
    name: text(group?.name),
    values: uniqueStrings(group?.values),
  })).filter((group) => group.name && group.values.length > 0);
  if (groups.length === 0) {
    throw new Error('group_values requires at least one value group');
  }
  const mapping = new Map();
  for (const group of groups) {
    for (const value of group.values) {
      mapping.set(compact(value), group.name);
    }
  }
  const defaultValue = text(config.defaultValue) || '其他';
  const groupedRows = (rows ?? []).map((row) => ({
    ...row,
    [outputField]: mapping.get(compact(row?.[field])) ?? defaultValue,
  }));
  const outputColumn = {
    name: text(config.displayName) || outputField,
    bizName: outputField,
    showType: 'CATEGORY',
    type: 'STRING',
  };
  const sourceIndex = columns.findIndex((column) => column === sourceColumn);
  const nextColumns = [...columns];
  nextColumns.splice(sourceIndex + 1, 0, outputColumn);
  return {
    columns: nextColumns,
    rows: groupedRows,
    groupOrder: uniqueStrings([
      ...groups.map((group) => group.name),
      defaultValue,
    ]),
  };
}

export function applyPeriodComparison({
  columns,
  rows,
  config = {},
  periodOrder = [],
}) {
  const metric = text(config.metric);
  const outputField = text(config.outputField);
  const periodField = text(config.periodField) || '__period';
  if (!metric || !outputField) {
    throw new Error('period_comparison requires metric and outputField');
  }
  const metricColumn = requireColumn(columns, metric);
  requireColumn(columns, periodField);
  const comparisonType = String(config.type ?? 'RATE').toUpperCase();
  const explicitRowFields = uniqueStrings(config.rowFields);
  const rowFields = explicitRowFields.length > 0
    ? explicitRowFields
    : columns
      .map(columnKey)
      .filter((key) => (
        key
        && key !== metric
        && key !== periodField
        && key !== outputField
        && !isNumericColumn(columns.find((column) => columnKey(column) === key))
      ));
  const rowColumns = rowFields.map((field) => requireColumn(columns, field));
  const periods = uniqueStrings(
    (periodOrder ?? []).length > 0
      ? periodOrder
      : rows.map((row) => row?.[periodField]),
  );
  const basePeriod = text(config.basePeriod) || periods[0];
  const comparePeriod = text(config.comparePeriod) || periods[1];
  if (!basePeriod || !comparePeriod) {
    throw new Error('period_comparison requires two periods');
  }

  const grouped = new Map();
  for (const row of rows ?? []) {
    const period = text(row?.[periodField]);
    if (period !== basePeriod && period !== comparePeriod) {
      continue;
    }
    const key = rowFields.map((field) => text(row?.[field])).join('\u001f');
    const record = grouped.get(key) ?? {
      values: Object.fromEntries(
        rowFields.map((field) => [field, row?.[field]]),
      ),
      base: 0,
      compare: 0,
      hasBase: false,
      hasCompare: false,
    };
    const value = asNumber(row?.[metric]);
    if (value !== null) {
      if (period === basePeriod) {
        record.base += value;
        record.hasBase = true;
      } else {
        record.compare += value;
        record.hasCompare = true;
      }
    }
    grouped.set(key, record);
  }

  const comparisonColumn = {
    name: text(config.displayName) || outputField,
    bizName: outputField,
    showType: 'NUMBER',
    type: 'DECIMAL',
    unit: comparisonType === 'RATE' ? '%' : metricColumn.unit,
    numberFormat: comparisonType === 'RATE' ? '0.00%' : '#,##0.00',
  };
  const outputRows = [...grouped.values()].map((record) => {
    const base = record.hasBase ? record.base : null;
    const compare = record.hasCompare ? record.compare : null;
    let value = null;
    if (base !== null && compare !== null) {
      if (comparisonType === 'RATE') {
        value = compare === 0 ? null : (base - compare) / Math.abs(compare);
      } else {
        value = base - compare;
      }
    }
    return {
      ...record.values,
      [metric]: base,
      [outputField]: value,
      [`__base_${metric}`]: base,
      [`__compare_${metric}`]: compare,
    };
  });
  return {
    columns: [
      ...rowColumns,
      metricColumn,
      comparisonColumn,
    ],
    rows: outputRows,
  };
}

function valueFieldDefinition(columns, valueField) {
  const field = typeof valueField === 'string' ? valueField : valueField?.field;
  const column = requireColumn(columns, field);
  return {
    field: columnKey(column),
    label: text(
      typeof valueField === 'object' ? valueField?.label : null,
    ) || text(column.name) || columnKey(column),
    unit: column.unit ?? '',
    numberFormat: column.numberFormat
      ?? (String(column?.unit ?? '').includes('%') ? '0.00%' : '#,##0.00'),
  };
}

export function applyPivot({
  columns,
  rows,
  config = {},
  groupOrder = [],
  comparison = {},
}) {
  const rowFields = uniqueStrings(config.rowFields);
  const columnField = text(config.columnField);
  if (rowFields.length === 0 || !columnField) {
    throw new Error('pivot requires rowFields and columnField');
  }
  const rowColumns = rowFields.map((field) => requireColumn(columns, field));
  requireColumn(columns, columnField);
  const valueFields = (config.valueFields ?? []).map((field) => (
    valueFieldDefinition(columns, field)
  ));
  if (valueFields.length === 0) {
    throw new Error('pivot requires valueFields');
  }
  const categoryOrder = uniqueStrings([
    ...groupOrder,
    ...(rows ?? []).map((row) => row?.[columnField]),
  ]);
  const comparisonMetric = text(comparison.metric);
  const comparisonField = text(comparison.outputField);
  const rowMap = new Map();
  for (const row of rows ?? []) {
    const rowKey = rowFields.map((field) => text(row?.[field])).join('\u001f');
    const record = rowMap.get(rowKey) ?? {
      values: Object.fromEntries(
        rowFields.map((field) => [field, row?.[field]]),
      ),
      categories: {},
    };
    const category = text(row?.[columnField]);
    const categoryValues = record.categories[category] ?? {};
    for (const valueField of valueFields) {
      categoryValues[valueField.field] = row?.[valueField.field] ?? null;
    }
    if (comparisonMetric) {
      categoryValues[`__base_${comparisonMetric}`] = row?.[`__base_${comparisonMetric}`]
        ?? null;
      categoryValues[`__compare_${comparisonMetric}`] = row?.[`__compare_${comparisonMetric}`]
        ?? null;
    }
    record.categories[category] = categoryValues;
    rowMap.set(rowKey, record);
  }

  const totalLabel = text(config.totalLabel) || '合计';
  const includeTotal = config.includeTotal !== false;
  const outputColumns = [...rowColumns];
  for (const category of categoryOrder) {
    for (const valueField of valueFields) {
      outputColumns.push({
        name: `${category}·${valueField.label}`,
        bizName: `${category}__${valueField.field}`,
        parentName: category,
        childName: valueField.label,
        showType: 'NUMBER',
        type: 'DECIMAL',
        unit: valueField.unit,
        numberFormat: valueField.numberFormat,
      });
    }
  }
  if (includeTotal) {
    for (const valueField of valueFields) {
      outputColumns.push({
        name: `${totalLabel}·${valueField.label}`,
        bizName: `${totalLabel}__${valueField.field}`,
        parentName: totalLabel,
        childName: valueField.label,
        showType: 'NUMBER',
        type: 'DECIMAL',
        unit: valueField.unit,
        numberFormat: valueField.numberFormat,
      });
    }
  }

  const outputRows = [...rowMap.values()].map((record) => {
    const output = { ...record.values };
    let amountTotal = 0;
    let hasAmount = false;
    let baseTotal = 0;
    let compareTotal = 0;
    let hasBase = false;
    let hasCompare = false;
    for (const category of categoryOrder) {
      const values = record.categories[category] ?? {};
      for (const valueField of valueFields) {
        output[`${category}__${valueField.field}`] = values[valueField.field] ?? null;
      }
      if (comparisonMetric && comparisonField) {
        const base = asNumber(values[`__base_${comparisonMetric}`])
          ?? asNumber(values[comparisonMetric]);
        const compare = asNumber(values[`__compare_${comparisonMetric}`]);
        if (base !== null) {
          baseTotal += base;
          hasBase = true;
        }
        if (compare !== null) {
          compareTotal += compare;
          hasCompare = true;
        }
      }
      const amount = comparisonMetric
        ? asNumber(values[comparisonMetric])
        : null;
      if (amount !== null) {
        amountTotal += amount;
        hasAmount = true;
      }
    }
    if (includeTotal) {
      for (const valueField of valueFields) {
        let totalValue = null;
        if (valueField.field === comparisonMetric) {
          totalValue = hasAmount ? amountTotal : null;
        } else if (valueField.field === comparisonField) {
          if (hasBase && hasCompare) {
            const type = String(comparison.type ?? 'RATE').toUpperCase();
            totalValue = type === 'RATE'
              ? (compareTotal === 0 ? null : (baseTotal - compareTotal) / Math.abs(compareTotal))
              : baseTotal - compareTotal;
          }
        }
        output[`${totalLabel}__${valueField.field}`] = totalValue;
      }
    }
    return output;
  }).sort((left, right) => rowFields
    .map((field) => text(left?.[field]).localeCompare(
      text(right?.[field]),
      'zh-CN',
      { numeric: true },
    ))
    .find((result) => result !== 0) ?? 0);

  return {
    columns: outputColumns,
    rows: outputRows,
  };
}

export function applyResultPostProcessing({
  columns = [],
  rows = [],
  postProcessing = null,
  periodOrder = [],
}) {
  if (!postProcessing || typeof postProcessing !== 'object') {
    return { columns, rows };
  }
  let state = { columns, rows, groupOrder: [] };
  if (postProcessing.groupValues) {
    state = {
      ...state,
      ...applyValueGrouping({
        columns: state.columns,
        rows: state.rows,
        config: postProcessing.groupValues,
      }),
    };
  }
  if (postProcessing.periodComparison) {
    state = {
      ...state,
      ...applyPeriodComparison({
        columns: state.columns,
        rows: state.rows,
        config: postProcessing.periodComparison,
        periodOrder,
      }),
    };
  }
  if (postProcessing.pivot) {
    state = {
      ...state,
      ...applyPivot({
        columns: state.columns,
        rows: state.rows,
        config: postProcessing.pivot,
        groupOrder: state.groupOrder,
        comparison: postProcessing.periodComparison ?? {},
      }),
    };
  }
  return {
    columns: state.columns,
    rows: state.rows,
  };
}
