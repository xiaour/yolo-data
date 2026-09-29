function isTemporalDimension(column, rows) {
  const text = `${column?.name ?? ''} ${column?.bizName ?? ''}`.toLowerCase();
  if (/date|time|day|week|month|quarter|year|日期|时间|日|月|周|季度|年/.test(text)) {
    return true;
  }
  const values = (rows ?? []).slice(0, 20)
    .map((row) => row?.[column?.bizName] ?? row?.[column?.name])
    .filter((value) => value !== null && value !== undefined);
  return values.length > 0 && values.filter((value) => (
    /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?/.test(String(value))
  )).length >= Math.ceil(values.length * 0.6);
}

function isNumericColumn(column) {
  return String(column?.showType ?? '').toUpperCase() === 'NUMBER'
    || String(column?.type ?? '').toLowerCase().match(/int|decimal|double|float|number/) !== null;
}

export function suggestChart({ columns = [], rows = [], question = '', preferred = 'auto' }) {
  const numericColumns = columns.filter(isNumericColumn);
  const dimensionColumns = columns.filter((column) => !numericColumns.includes(column));

  if (preferred && preferred !== 'auto') {
    return {
      type: preferred,
      xField: dimensionColumns[0]?.bizName ?? dimensionColumns[0]?.name ?? null,
      yFields: numericColumns.slice(0, 4).map((column) => column.bizName ?? column.name),
      title: '查询结果',
      reason: '使用主题默认图表',
    };
  }

  if (rows.length === 1 && numericColumns.length >= 1) {
    return {
      type: 'kpi',
      xField: null,
      yFields: numericColumns.slice(0, 4).map((column) => column.bizName ?? column.name),
      title: '核心结果',
      reason: '结果仅一行，适合指标卡展示',
    };
  }

  if (numericColumns.length === 0) {
    return {
      type: 'table',
      xField: null,
      yFields: [],
      title: '明细结果',
      reason: '结果中没有数值指标',
    };
  }

  if (dimensionColumns.length === 0) {
    return {
      type: 'bar',
      xField: null,
      yFields: numericColumns.slice(0, 4).map((column) => column.bizName ?? column.name),
      title: '指标对比',
      reason: '多个指标适合柱状对比',
    };
  }

  const yFields = numericColumns.slice(0, 4).map((column) => column.bizName ?? column.name);
  if (dimensionColumns.length > 1) {
    const temporalIndex = dimensionColumns.findIndex(
      (column) => isTemporalDimension(column, rows),
    );
    if (temporalIndex >= 0) {
      const temporal = dimensionColumns[temporalIndex];
      const seriesDimension = dimensionColumns.find((_, index) => index !== temporalIndex);
      return {
        type: 'line',
        xField: temporal.bizName ?? temporal.name,
        seriesField: seriesDimension.bizName ?? seriesDimension.name,
        yFields,
        title: '趋势对比',
        reason: `时间趋势按${seriesDimension.name ?? seriesDimension.bizName}拆分为多条线`,
      };
    }
    return {
      type: 'bar',
      xField: dimensionColumns[0].bizName ?? dimensionColumns[0].name,
      seriesField: dimensionColumns[1].bizName ?? dimensionColumns[1].name,
      yFields,
      title: '分类对比',
      reason: '两个分类维度使用分组柱状图展示',
    };
  }

  const primaryDimension = dimensionColumns[0];
  const categoryCount = new Set(rows.map((row) => (
    row[primaryDimension.bizName] ?? row[primaryDimension.name]
  ))).size;
  const asksComposition = /占比|构成|结构|分布|份额|比例/.test(question);

  if (asksComposition && categoryCount <= 10 && numericColumns.length === 1) {
    return {
      type: 'pie',
      xField: primaryDimension.bizName ?? primaryDimension.name,
      yFields,
      title: '构成分布',
      reason: '问题关注构成，且分类数量适合饼图',
    };
  }

  if (isTemporalDimension(primaryDimension, rows)) {
    return {
      type: 'line',
      xField: primaryDimension.bizName ?? primaryDimension.name,
      yFields,
      title: '趋势变化',
      reason: '主维度为时间字段，适合趋势折线图',
    };
  }

  return {
    type: 'bar',
    xField: primaryDimension.bizName ?? primaryDimension.name,
    yFields,
    title: '分类对比',
    reason: categoryCount <= 12
      ? '分类数量适中，适合柱状图'
      : '分类较多，仍按柱状图展示并支持滚动查看',
  };
}

export function toEChartsOption(chart, columns, rows) {
  if (!chart || chart.type === 'table' || chart.type === 'kpi') {
    return null;
  }
  const xField = chart.xField;
  const yFields = Array.isArray(chart.yFields) ? chart.yFields : [];
  const seriesField = chart.seriesField;
  const xValues = seriesField
    ? [...new Set(rows.map((row) => row?.[xField]))]
    : rows.map((row) => row?.[xField]);
  const labelByField = new Map();
  for (const column of columns ?? []) {
    labelByField.set(column.bizName ?? column.name, column.name ?? column.bizName);
  }

  if (chart.type === 'pie') {
    const metric = yFields[0];
    return {
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, type: 'scroll' },
      series: [{
        type: 'pie',
        radius: ['38%', '68%'],
        center: ['50%', '46%'],
        data: rows.map((row) => ({
          name: row?.[xField],
          value: Number(row?.[metric] ?? 0),
        })),
        label: { formatter: '{b}\n{d}%' },
      }],
    };
  }

  const series = seriesField
    ? [...new Set(rows.map((row) => row?.[seriesField]))].flatMap((seriesValue) => (
      yFields.map((field) => ({
        name: yFields.length === 1
          ? String(seriesValue)
          : `${seriesValue} · ${labelByField.get(field) ?? field}`,
        type: chart.type,
        smooth: chart.type === 'line',
        showSymbol: chart.type === 'line' && xValues.length <= 20,
        barMaxWidth: 34,
        data: xValues.map((xValue) => {
          const row = rows.find((item) => (
            String(item?.[xField]) === String(xValue)
            && String(item?.[seriesField]) === String(seriesValue)
          ));
          return Number(row?.[field] ?? 0);
        }),
      }))
    ))
    : yFields.map((field) => ({
      name: labelByField.get(field) ?? field,
      type: chart.type,
      smooth: chart.type === 'line',
      showSymbol: chart.type === 'line' && rows.length <= 20,
      areaStyle: chart.type === 'line' && yFields.length === 1 ? { opacity: 0.08 } : undefined,
      data: rows.map((row) => Number(row?.[field] ?? 0)),
    }));

  return {
    color: ['#1677ff', '#13a8a8', '#f5a524', '#eb5757', '#7a5af8', '#4e5ba6'],
    tooltip: { trigger: 'axis' },
    legend: { top: 0, type: 'scroll' },
    grid: { left: 48, right: 24, top: yFields.length > 1 ? 44 : 20, bottom: 42 },
    xAxis: {
      type: 'category',
      data: xValues,
      axisLabel: { rotate: xValues.some((value) => String(value).length > 8) ? 28 : 0 },
    },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#edf1f7' } } },
    series,
  };
}
