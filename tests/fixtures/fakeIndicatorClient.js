const DIMENSION_VALUES = {
  region: ['华东', '华南', '华北', '西南'],
  channel: ['线上', '门店', '分销', '团购'],
  category: ['饮料', '食品', '日化', '生鲜'],
  warehouse: ['上海仓', '广州仓', '北京仓', '成都仓'],
  carrier: ['顺丰', '京东物流', '德邦', '中通'],
};

const DATE_VALUES = [
  '2026-09-14',
  '2026-09-15',
  '2026-09-16',
  '2026-09-17',
  '2026-09-18',
  '2026-09-19',
  '2026-09-20',
];

const METRIC_DEFINITIONS = {
  sales_amount: {
    name: '销售额',
    base: 1_860_000,
    spread: 0.28,
    unit: '元',
    type: 'NUMBER',
  },
  order_count: {
    name: '订单量',
    base: 42_600,
    spread: 0.3,
    unit: '单',
    type: 'NUMBER',
  },
  gross_profit: {
    name: '毛利额',
    base: 524_000,
    spread: 0.24,
    unit: '元',
    type: 'NUMBER',
  },
  gross_margin_rate: {
    name: '毛利率',
    base: 28.4,
    spread: 0.18,
    unit: '%',
    type: 'NUMBER',
  },
  fulfillment_rate: {
    name: '履约及时率',
    base: 94.6,
    spread: 0.05,
    unit: '%',
    type: 'NUMBER',
  },
  abnormal_order_count: {
    name: '异常订单量',
    base: 780,
    spread: 0.35,
    unit: '单',
    type: 'NUMBER',
  },
};

function dimension(name) {
  return {
    dimensionId: Math.abs(hash(name)),
    dimensionName: name,
    dimensionBizName: name,
    metricId: 1,
    metricName: '经营指标',
    modelId: 1,
    modelName: '经营分析模型',
    description: `${name}维度`,
  };
}

function metric(name) {
  const definition = METRIC_DEFINITIONS[name];
  return {
    metricId: Math.abs(hash(name)),
    metricName: definition.name,
    metricBizName: name,
    modelId: 1,
    modelName: '经营分析模型',
    modelBizName: 'business_model',
    description: definition.name,
  };
}

function createIndicator(id, name, typeName, description, metricNames, dimensionNames) {
  return {
    id,
    name,
    bizName: id,
    typeId: typeName === '经营指标' ? '1' : '2',
    typeName,
    indicatorLevel: '一级',
    businessCaliber: `${metricNames.map((item) => METRIC_DEFINITIONS[item].name).join('、')}按统计周期汇总`,
    description,
    owner: '数据运营组',
    department: '数据中心',
    status: 1,
    metrics: metricNames.map(metric),
    dimensions: dimensionNames.map(dimension),
    models: [{
      modelId: 1,
      modelName: '经营分析模型',
      modelBizName: 'business_model',
      modelDatabase: 'test',
      modelTable: 'dws_business_daily',
      description: '测试指标模型',
    }],
    raw: { test: true },
  };
}

const TEST_INDICATORS = [
  createIndicator(
    'sales_amount',
    '销售额',
    '经营指标',
    '统计周期内已完成订单的含税销售金额。',
    ['sales_amount'],
    ['date', 'region', 'channel', 'category', 'customer_type'],
  ),
  createIndicator(
    'order_count',
    '订单量',
    '经营指标',
    '统计周期内创建并支付的有效订单数量。',
    ['order_count'],
    ['date', 'region', 'channel', 'category', 'warehouse', 'carrier'],
  ),
  createIndicator(
    'gross_profit',
    '毛利额',
    '财务指标',
    '销售额扣除商品成本后的金额。',
    ['gross_profit'],
    ['date', 'region', 'channel', 'category', 'customer_type'],
  ),
  createIndicator(
    'gross_margin_rate',
    '毛利率',
    '财务指标',
    '毛利额占销售额的比例。',
    ['gross_margin_rate'],
    ['date', 'region', 'channel', 'category', 'customer_type'],
  ),
  createIndicator(
    'fulfillment_rate',
    '履约及时率',
    '履约指标',
    '承诺时效内完成签收的订单占比。',
    ['fulfillment_rate'],
    ['date', 'region', 'warehouse', 'carrier'],
  ),
  createIndicator(
    'abnormal_order_count',
    '异常订单量',
    '履约指标',
    '运输、签收或售后环节标记异常的订单量。',
    ['abnormal_order_count'],
    ['date', 'region', 'warehouse', 'carrier'],
  ),
];

function hash(value) {
  let result = 2166136261;
  for (const char of String(value)) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function normalizedValues(name, filters) {
  const matching = filters.find((filter) => filter.bizName === name || filter.name === name);
  if (!matching) {
    return DIMENSION_VALUES[name] ?? ['全部'];
  }
  const values = Array.isArray(matching.value) ? matching.value : [matching.value];
  if (matching.operator === 'IN') {
    return values.map(String);
  }
  if (matching.operator === 'NOT_IN') {
    return (DIMENSION_VALUES[name] ?? []).filter((value) => !values.includes(value));
  }
  if (matching.operator === '=') {
    return values.slice(0, 1).map(String);
  }
  if (matching.operator === '!=') {
    return (DIMENSION_VALUES[name] ?? []).filter((value) => value !== String(values[0]));
  }
  return DIMENSION_VALUES[name] ?? ['全部'];
}

function combinations(valuesByDimension) {
  return Object.entries(valuesByDimension).reduce(
    (result, [, values]) => result.flatMap((row) => values.map((value) => [...row, value])),
    [[]],
  );
}

function valueFor(metricName, dimensions, row) {
  const definition = METRIC_DEFINITIONS[metricName];
  const seed = hash(`${metricName}:${dimensions.map((name, index) => `${name}=${row[index]}`).join('|')}`);
  const ratio = (seed % 10_000) / 10_000;
  const multiplier = 1 + (ratio - 0.5) * 2 * definition.spread;
  const dateIndex = row.find((value) => DATE_VALUES.includes(value));
  const trend = dateIndex ? 0.9 + DATE_VALUES.indexOf(dateIndex) * 0.025 : 1;
  const raw = definition.base * multiplier * trend;
  if (metricName === 'gross_margin_rate') {
    return Number(Math.max(7, Math.min(52, raw)).toFixed(1));
  }
  if (metricName === 'fulfillment_rate') {
    return Number(Math.max(80, Math.min(99.8, raw)).toFixed(1));
  }
  return Math.round(raw);
}

// Synthetic indicator source used only by automated tests.
export class FakeIndicatorClient {
  constructor() {
    this.mode = 'supersonic';
  }

  async health() {
    return true;
  }

  async listTypes() {
    return [
      { id: 1, typeName: '经营指标', typeCode: 'BUSINESS', parentId: 0, sort: 1, status: 1 },
      { id: 2, typeName: '履约指标', typeCode: 'FULFILLMENT', parentId: 0, sort: 2, status: 1 },
      { id: 3, typeName: '财务指标', typeCode: 'FINANCE', parentId: 0, sort: 3, status: 1 },
    ];
  }

  async listIndicators({ keyword = '', typeId = '', pageSize = 500 } = {}) {
    const normalizedKeyword = String(keyword).trim().toLowerCase();
    const normalizedTypeId = String(typeId ?? '');
    const list = TEST_INDICATORS
      .filter((indicator) => !normalizedTypeId || String(indicator.typeId) === normalizedTypeId)
      .filter((indicator) => !normalizedKeyword || [
        indicator.name,
        indicator.bizName,
        indicator.description,
        indicator.businessCaliber,
        indicator.typeName,
      ].some((value) => String(value).toLowerCase().includes(normalizedKeyword)))
      .slice(0, Number(pageSize) || 500)
      .map((indicator) => ({ ...indicator }));
    return {
      list,
      total: list.length,
      pageNum: 1,
      pageSize: list.length,
      raw: { test: true },
    };
  }

  async listCatalog(options = {}) {
    return this.listIndicators(options);
  }

  async getIndicator(id) {
    const indicator = TEST_INDICATORS.find((item) => String(item.id) === String(id));
    return indicator ? structuredClone(indicator) : null;
  }

  async queryIndicator({
    metricNames = [],
    dimensionNames = [],
    filters = [],
    limit = 200,
  } = {}) {
    const selectedMetrics = metricNames.filter((name) => METRIC_DEFINITIONS[name]);
    const selectedDimensions = dimensionNames
      .map((name) => String(name))
      .filter((name) => name === 'date' || DIMENSION_VALUES[name]);
    const valuesByDimension = {};
    for (const name of selectedDimensions) {
      valuesByDimension[name] = name === 'date'
        ? DATE_VALUES
        : normalizedValues(name, filters);
      if (valuesByDimension[name].length === 0) {
        return { columns: [], resultList: [], totalCount: 0, test: true };
      }
    }

    const rows = combinations(valuesByDimension).map((values) => {
      const row = {};
      selectedDimensions.forEach((name, index) => {
        row[name] = values[index];
      });
      for (const metricName of selectedMetrics) {
        row[metricName] = valueFor(metricName, selectedDimensions, values);
      }
      return row;
    });

    const columns = [
      ...selectedDimensions.map((name) => ({
        name: name === 'date' ? '日期' : name,
        bizName: name,
        nameEn: name,
        showType: 'CATEGORY',
        type: 'STRING',
        authorized: true,
      })),
      ...selectedMetrics.map((name) => ({
        name: METRIC_DEFINITIONS[name].name,
        bizName: name,
        nameEn: name,
        showType: 'NUMBER',
        type: 'DECIMAL',
        dataFormatType: METRIC_DEFINITIONS[name].unit,
        authorized: true,
      })),
    ];

    return {
      columns,
      resultList: rows.slice(0, Math.max(1, Number(limit) || 200)),
      totalCount: rows.length,
      pageNo: 1,
      pageSize: rows.length,
      test: true,
    };
  }

  async queryIndicatorPresentationEvidence(args = {}) {
    return this.queryIndicator(args);
  }

  async queryIndicatorFormatted(args = {}) {
    return this.queryIndicatorPresentationEvidence(args);
  }
}
