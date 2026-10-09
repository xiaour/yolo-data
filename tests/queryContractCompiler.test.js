import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryContractCompiler } from '../src/queryContractCompiler.js';

const now = new Date('2026-09-22T03:00:00Z');
const indicator = {
  id: 'sales',
  name: '含税销售金额',
  businessCaliber: '重点客户组子板块=企业客户+零售客户+大客户',
  metrics: [
    {
      metricBizName: 'sale_amt',
      metricName: '含税销售金额',
    },
  ],
  dimensions: [
    {
      dimensionBizName: 'sdt',
      dimensionName: '销售日期',
    },
    {
      dimensionBizName: 'business_type_name',
      dimensionName: 'segment_name',
    },
    {
      dimensionBizName: 'customer_name',
      dimensionName: 'customer_name',
    },
    {
      dimensionBizName: 'customer_code',
      dimensionName: 'customer_code',
    },
  ],
};

const dataset = {
  id: 3,
  name: 'sales_fact',
};

const datasetFields = [
  {
    fieldName: 'sales_date',
    displayName: '销售日期',
    role: 'TIME',
    semanticType: 'DATE',
    aggregator: 'NONE',
  },
  {
    fieldName: 'customer_code',
    displayName: 'customer_code',
    role: 'DIMENSION',
    semanticType: 'STRING',
    aggregator: 'NONE',
  },
  {
    fieldName: 'business_type_name',
    displayName: 'segment_name',
    role: 'DIMENSION',
    semanticType: 'STRING',
    aggregator: 'NONE',
  },
  {
    fieldName: 'sale_amt',
    displayName: '含税销售额',
    role: 'METRIC',
    semanticType: 'NUMBER',
    aggregator: 'SUM',
  },
  {
    fieldName: 'sale_cost',
    displayName: '含税销售成本',
    role: 'METRIC',
    semanticType: 'NUMBER',
    aggregator: 'SUM',
  },
];

function compile(question, draft) {
  return new QueryContractCompiler().compile({
    question,
    sourceType: 'INDICATOR',
    indicator,
    availableMetrics: indicator.metrics,
    availableDimensions: indicator.dimensions,
    theme: {
      systemPrompt: [
        '重点客户组子板块=企业客户+零售客户+大客户',
        '用户说“全国 / 整体 / 全国整体”时表示全量整体口径，不添加过滤。',
      ].join('\n'),
    },
    draft,
    now,
  });
}

test('contract compiler requires a complete condition ledger', () => {
  const question = '本月重点客户组业务的销售额，按照每周分组，排名前10的客户';
  const result = compile(question, {
    sourceType: 'INDICATOR',
    indicatorId: 'sales',
    conditions: [
      {
        id: 'metric',
        sourceText: '本月重点客户组业务的销售额',
        kind: 'METRIC',
        status: 'RESOLVED',
      },
      {
        id: 'filter',
        sourceText: '本月重点客户组业务的销售额',
        kind: 'FILTER',
        status: 'RESOLVED',
        ruleSource: '第2节：重点客户组子板块=企业客户+零售客户+大客户',
      },
      {
        id: 'week',
        sourceText: '按照每周分组',
        kind: 'DIMENSION',
        status: 'RESOLVED',
      },
      {
        id: 'top',
        sourceText: '排名前10的客户',
        kind: 'LIMIT',
        status: 'RESOLVED',
      },
      {
        id: 'customer',
        sourceText: '排名前10的客户',
        kind: 'DIMENSION',
        status: 'RESOLVED',
      },
    ],
    metricFields: [{
      field: 'sale_amt',
      aggregator: 'SUM',
      sourceText: '销售额',
      conditionIds: ['metric'],
    }],
    dimensionFields: [
      {
        field: 'sdt',
        sourceText: '每周',
        timeGrain: 'WEEK',
        conditionIds: ['week'],
      },
      {
        field: 'customer_name',
        sourceText: '客户',
        conditionIds: ['customer'],
      },
    ],
    filterFields: [{
      field: 'business_type_name',
      operator: 'IN',
      value: ['企业客户', '零售客户', '大客户'],
      sourceText: '本月重点客户组业务的销售额',
      ruleSource: '第2节：重点客户组子板块=企业客户+零售客户+大客户',
      conditionIds: ['filter'],
    }],
    timeWindows: [{
      sourceText: '本月',
      dateMode: 'BETWEEN',
      startDate: '2026-09-01',
      endDate: '2026-09-21',
      conditionIds: ['metric'],
    }],
    timeGrain: 'WEEK',
    limit: 10,
  });

  assert.equal(result.valid, true, result.issues.map((issue) => issue.message).join('\n'));
  assert.equal(result.contract.metricFields[0].field, 'sale_amt');
  assert.equal(result.contract.filterFields[0].field, 'business_type_name');
  assert.equal(result.contract.timeWindows[0].startDate, '2026-09-01');
  assert.equal(result.contract.timeWindows[0].endDate, '2026-09-21');
  assert.equal(result.contract.provenance.mode, 'INDICATOR_LIBRARY');
  assert.equal(result.contract.provenance.label, '指标库口径');
});

test('month-to-date wording binds into the compiled time window', () => {
  const result = compile(
    '月至今的标准配送的业绩是多少',
    {
      sourceType: 'INDICATOR',
      indicatorId: 'sales',
      conditions: [
        {
          id: 'metric',
          sourceText: '月至今的标准配送的业绩是多少',
          kind: 'METRIC',
          status: 'RESOLVED',
        },
        {
          id: 'business',
          sourceText: '标准配送',
          kind: 'FILTER',
          status: 'RESOLVED',
          ruleSource: '标准配送映射到 segment_name = 标准配送',
        },
        {
          id: 'time',
          sourceText: '月至今',
          kind: 'TIME',
          status: 'RESOLVED',
        },
      ],
      metricFields: [{
        field: 'sale_amt',
        sourceText: '业绩',
        aggregator: 'SUM',
        conditionIds: ['metric'],
      }],
      dimensionFields: [],
      filterFields: [{
        field: 'business_type_name',
        operator: '=',
        value: ['标准配送'],
        sourceText: '标准配送',
        ruleSource: '标准配送映射到 segment_name = 标准配送',
        conditionIds: ['business'],
      }],
    },
  );

  assert.equal(result.valid, true, result.issues.map((issue) => issue.message).join('\n'));
  assert.equal(result.contract.timeWindows.length, 1);
  assert.equal(result.contract.timeWindows[0].sourceText, '月至今');
  assert.equal(result.contract.timeWindows[0].startDate, '2026-09-01');
  assert.equal(result.contract.timeWindows[0].endDate, '2026-09-21');
  assert.ok(result.contract.semanticCoverage.some(
    (item) => item.code === 'TIME_WINDOW' && item.status === 'AUTO_COMPLETED',
  ));
});

test('platform completes trend and ranking semantics from the question', () => {
  const result = compile(
    '2026年销售额趋势，排名前10的客户',
    {
      sourceType: 'INDICATOR',
      indicatorId: 'sales',
      conditions: [
        {
          id: 'metric',
          sourceText: '销售额',
          kind: 'METRIC',
          status: 'RESOLVED',
        },
        {
          id: 'time',
          sourceText: '2026年',
          kind: 'TIME',
          status: 'RESOLVED',
        },
        {
          id: 'customer',
          sourceText: '客户',
          kind: 'DIMENSION',
          status: 'RESOLVED',
        },
      ],
      metricFields: [{
        field: 'sale_amt',
        sourceText: '销售额',
        aggregator: 'SUM',
        conditionIds: ['metric'],
      }],
      dimensionFields: [
        {
          field: 'sdt',
          sourceText: '2026年',
          conditionIds: ['time'],
        },
        {
          field: 'customer_name',
          sourceText: '客户',
          conditionIds: ['customer'],
        },
      ],
      filterFields: [],
      timeWindows: [{
        sourceText: '2026年',
        dateMode: 'BETWEEN',
        startDate: '2026-01-01',
        endDate: '2026-09-21',
        conditionIds: ['time'],
      }],
    },
  );

  assert.equal(result.valid, true, result.issues.map((issue) => issue.message).join('\n'));
  assert.equal(result.contract.limit, 10);
  assert.ok(result.contract.conditions.some(
    (condition) => condition.kind === 'LIMIT' && condition.sourceText === '排名前10',
  ));
  assert.ok(result.contract.conditions.some(
    (condition) => condition.kind === 'RESULT_ACTION' && condition.sourceText === '趋势',
  ));
  assert.ok(result.contract.semanticCoverage.some(
    (item) => item.code === 'RANKING' && item.status === 'AUTO_COMPLETED',
  ));
  assert.ok(result.contract.semanticCoverage.some(
    (item) => item.code === 'TREND' && item.status === 'AUTO_COMPLETED',
  ));
});

test('model-owned semantic categories cannot be silently omitted', () => {
  const result = compile(
    '本月销售额按management_category拆分',
    {
      sourceType: 'INDICATOR',
      indicatorId: 'sales',
      conditions: [
        {
          id: 'metric',
          sourceText: '销售额',
          kind: 'METRIC',
          status: 'RESOLVED',
        },
        {
          id: 'time',
          sourceText: '本月',
          kind: 'TIME',
          status: 'RESOLVED',
        },
      ],
      metricFields: [{
        field: 'sale_amt',
        sourceText: '销售额',
        aggregator: 'SUM',
        conditionIds: ['metric'],
      }],
      dimensionFields: [],
      filterFields: [],
      timeWindows: [{
        sourceText: '本月',
        dateMode: 'BETWEEN',
        startDate: '2026-09-01',
        endDate: '2026-09-21',
        conditionIds: ['time'],
      }],
    },
  );

  assert.equal(result.valid, false);
  assert.ok(result.issues.some(
    (issue) => issue.code === 'SEMANTIC_CATEGORY_NOT_BOUND'
      && issue.categoryCode === 'DIMENSION',
  ));
});

test('theme semantic policy injects a domain-configured formula before compilation', () => {
  const datasetFields = [
    {
      fieldName: 'performance_province_name',
      displayName: 'sales_region_name',
      role: 'DIMENSION',
      semanticType: 'STRING',
      dataType: 'varchar',
    },
    {
      fieldName: 'sales_date',
      displayName: '销售日期',
      role: 'TIME',
      semanticType: 'DATE',
      dataType: 'date',
    },
    {
      fieldName: 'sale_amt',
      displayName: '含税销售额',
      role: 'METRIC',
      semanticType: 'NUMBER',
      dataType: 'decimal',
      aggregator: 'SUM',
    },
    {
      fieldName: 'sale_cost',
      displayName: '含税销售成本',
      role: 'METRIC',
      semanticType: 'NUMBER',
      dataType: 'decimal',
      aggregator: 'SUM',
    },
    {
      fieldName: 'profit',
      displayName: 'pricing_gross_profit',
      role: 'METRIC',
      semanticType: 'NUMBER',
      dataType: 'decimal',
      aggregator: 'SUM',
    },
  ];
  const result = new QueryContractCompiler().compile({
    question: '8月各省区毛利率',
    sourceType: 'BUSINESS_DATASET',
    dataset: { id: 9, name: '销售数据集' },
    datasetFields,
    theme: {
      systemPrompt: '',
      semanticPolicy: {
        metrics: [{
          id: 'gross_margin',
          concept: '毛利率',
          aliases: ['毛利率'],
          priority: 100,
          target: {
            type: 'FORMULA',
            outputField: '毛利率',
            outputFormat: 'PERCENT',
            expression: {
              op: 'DIVIDE',
              left: {
                op: 'SUBTRACT',
                left: { field: 'sale_amt', aggregator: 'SUM' },
                right: { field: 'sale_cost', aggregator: 'SUM' },
              },
              right: {
                op: 'ABS',
                value: { field: 'sale_amt', aggregator: 'SUM' },
              },
            },
          },
        }],
      },
    },
    draft: {
      sourceType: 'BUSINESS_DATASET',
      datasetId: 9,
      conditions: [
        { id: 'metric', sourceText: '毛利率', kind: 'METRIC', status: 'RESOLVED' },
        { id: 'time', sourceText: '8月', kind: 'TIME', status: 'RESOLVED' },
        { id: 'province', sourceText: '省区', kind: 'DIMENSION', status: 'RESOLVED' },
      ],
      metricFields: [{
        field: 'profit',
        sourceText: '毛利率',
        aggregator: 'SUM',
        conditionIds: ['metric'],
      }],
      derivedMetrics: [],
      dimensionFields: [{
        field: 'performance_province_name',
        sourceText: '省区',
        conditionIds: ['province'],
      }],
      filterFields: [],
      timeWindows: [{
        sourceText: '8月',
        dateMode: 'BETWEEN',
        startDate: '2026-08-01',
        endDate: '2026-08-31',
        conditionIds: ['time'],
      }],
    },
    now,
  });

  assert.equal(result.valid, true, result.issues.map((issue) => issue.message).join('\n'));
  assert.equal(result.contract.derivedMetrics.length, 1);
  assert.equal(result.contract.derivedMetrics[0].type, 'EXPRESSION');
  assert.equal(result.contract.derivedMetrics[0].outputField, '毛利率');
  assert.deepEqual(
    result.contract.metricFields.map((field) => field.field).sort(),
    ['sale_amt', 'sale_cost'],
  );
  assert.deepEqual(result.contract.internalMetrics, ['sale_amt', 'sale_cost']);
  assert.equal(
    result.contract.metricFields.some((field) => field.field === 'profit'),
    false,
  );
  assert.equal(result.contract.semanticPolicy.matches[0].ruleId, 'gross_margin');
});

test('trend intent binds a monthly time dimension without becoming a calculation', () => {
  const question = '2026年标准配送每个月的业绩趋势';
  const rule = '标准配送/标准配送映射到 segment_name = 标准配送';
  const result = new QueryContractCompiler().compile({
    question,
    sourceType: 'INDICATOR',
    indicator,
    availableMetrics: indicator.metrics,
    availableDimensions: indicator.dimensions,
    theme: {
      systemPrompt: rule,
    },
    draft: {
      sourceType: 'INDICATOR',
      indicatorId: 'sales',
      conditions: [
        {
          id: 'metric',
          sourceText: '业绩',
          kind: 'METRIC',
          status: 'RESOLVED',
        },
        {
          id: 'business',
          sourceText: '标准配送',
          kind: 'FILTER',
          status: 'RESOLVED',
          ruleSource: rule,
        },
        {
          id: 'year',
          sourceText: '2026年',
          kind: 'TIME',
          status: 'RESOLVED',
        },
        {
          id: 'month',
          sourceText: '每个月',
          kind: 'DIMENSION',
          status: 'RESOLVED',
        },
        {
          id: 'trend',
          sourceText: '趋势',
          kind: 'CALCULATION',
          status: 'RESOLVED',
        },
      ],
      metricFields: [{
        field: 'sale_amt',
        sourceText: '业绩',
        aggregator: 'SUM',
        conditionIds: ['metric'],
      }],
      dimensionFields: [],
      filterFields: [{
        field: 'business_type_name',
        operator: '=',
        value: '标准配送',
        sourceText: '标准配送',
        ruleSource: rule,
        conditionIds: ['business'],
      }],
      timeWindows: [{
        sourceText: '2026年',
        dateMode: 'BETWEEN',
        startDate: '2026-01-01',
        endDate: '2026-09-21',
        conditionIds: ['year'],
      }],
      calculation: {
        type: 'NONE',
        description: '按月趋势展示',
      },
    },
    now,
  });

  assert.equal(result.valid, true, result.issues.map((issue) => issue.message).join('\n'));
  assert.equal(result.contract.timeGrain, 'MONTH');
  assert.equal(result.contract.timeWindows[0].endDate, '2026-09-21');
  assert.equal(result.contract.dimensionFields[0].field, 'sdt');
  assert.equal(result.contract.dimensionFields[0].timeGrain, 'MONTH');
  assert.equal(
    result.contract.conditions.find((condition) => condition.id === 'trend').kind,
    'RESULT_ACTION',
  );
});

test('attribution intent derives an aligned comparison and prompt-based breakdown', () => {
  const question = '帮我分析9月份业绩上升还是下滑，然后输出具体原因';
  const result = compile(question, {
    sourceType: 'INDICATOR',
    indicatorId: 'sales',
    conditions: [
      {
        id: 'metric',
        sourceText: '业绩',
        kind: 'METRIC',
        status: 'RESOLVED',
      },
      {
        id: 'time',
        sourceText: '9月份',
        kind: 'TIME',
        status: 'RESOLVED',
      },
      {
        id: 'reason',
        sourceText: '具体原因',
        kind: 'CALCULATION',
        status: 'RESOLVED',
      },
    ],
    metricFields: [{
      field: 'sale_amt',
      sourceText: '业绩',
      aggregator: 'SUM',
      conditionIds: ['metric'],
    }],
    dimensionFields: [{
      field: 'business_type_name',
      sourceText: '具体原因',
      conditionIds: [],
    }],
    filterFields: [],
    timeWindows: [{
      sourceText: '9月份',
      label: '9月份',
      expression: '9月份',
      dateMode: 'BETWEEN',
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      conditionIds: ['time'],
    }, {
      sourceText: '上期',
      label: '上期',
      expression: '上期',
      dateMode: 'BETWEEN',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      conditionIds: ['time'],
    }],
    calculation: {
      type: 'NONE',
    },
  });

  assert.equal(result.valid, true, result.issues.map((issue) => issue.message).join('\n'));
  assert.equal(result.contract.analysisMode, 'ATTRIBUTION');
  assert.equal(result.contract.calculation.type, 'PERIOD_COMPARISON');
  assert.equal(result.contract.timeWindows.length, 2);
  assert.equal(result.contract.timeWindows[0].endDate, '2026-09-21');
  assert.equal(result.contract.timeWindows[1].startDate, '2026-08-01');
  assert.equal(result.contract.timeWindows[1].endDate, '2026-08-21');
  assert.ok(result.contract.dimensionFields.some(
    (dimension) => dimension.field === 'business_type_name' && dimension.isTime === false,
  ));
});

test('contract compiler adds a recognized missing comparison window', () => {
  const question = '26年8月对比25年8月的含税销售金额';
  const result = compile(question, {
    sourceType: 'INDICATOR',
    indicatorId: 'sales',
    conditions: [
      {
        id: 'metric',
        sourceText: '含税销售金额',
        kind: 'METRIC',
        status: 'RESOLVED',
      },
      {
        id: 'time',
        sourceText: '26年8月对比25年8月',
        kind: 'TIME',
        status: 'RESOLVED',
      },
      {
        id: 'comparison',
        sourceText: '对比',
        kind: 'COMPARISON',
        status: 'RESOLVED',
      },
    ],
    metricFields: [{
      field: 'sale_amt',
      sourceText: '含税销售金额',
      conditionIds: ['metric'],
    }],
    dimensionFields: [],
    timeWindows: [{
      sourceText: '26年8月',
      dateMode: 'BETWEEN',
      startDate: '2026-08-01',
      endDate: '2026-08-31',
      conditionIds: ['time'],
    }],
    calculation: {
      type: 'PERIOD_COMPARISON',
    },
  });

  assert.equal(result.valid, true, result.issues.map((issue) => issue.message).join('\n'));
  assert.equal(result.contract.timeWindows.length, 2);
  assert.equal(result.contract.timeWindows[0].startDate, '2026-08-01');
  assert.equal(result.contract.timeWindows[1].startDate, '2025-08-01');
  assert.equal(result.contract.timeWindows[1].endDate, '2025-08-31');
});

test('contract compiler blocks rankings without a business dimension', () => {
  const question = '本月销售额排名前十的客户';
  const result = compile(question, {
    sourceType: 'INDICATOR',
    indicatorId: 'sales',
    conditions: [
      {
        id: 'metric',
        sourceText: question,
        kind: 'METRIC',
        status: 'RESOLVED',
      },
      {
        id: 'limit',
        sourceText: '前十',
        kind: 'LIMIT',
        status: 'RESOLVED',
      },
    ],
    metricFields: [{
      field: 'sale_amt',
      sourceText: '销售额',
      conditionIds: ['metric'],
    }],
    dimensionFields: [],
    timeWindows: [{
      sourceText: '本月',
      dateMode: 'BETWEEN',
      startDate: '2026-09-01',
      endDate: '2026-09-21',
      conditionIds: ['metric'],
    }],
    limit: 10,
  });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === 'RANKING_DIMENSION_REQUIRED'));
});

test('contract compiler blocks business filters without traceable prompt rules', () => {
  const question = '本月重点客户组业务的销售额';
  const result = compile(question, {
    sourceType: 'INDICATOR',
    indicatorId: 'sales',
    conditions: [
      {
        id: 'metric',
        sourceText: question,
        kind: 'METRIC',
        status: 'RESOLVED',
      },
      {
        id: 'filter',
        sourceText: question,
        kind: 'FILTER',
        status: 'RESOLVED',
      },
    ],
    metricFields: [{
      field: 'sale_amt',
      sourceText: '销售额',
      conditionIds: ['metric'],
    }],
    dimensionFields: [],
    filterFields: [{
      field: 'business_type_name',
      operator: 'IN',
      value: ['企业客户', '零售客户', '大客户'],
      conditionIds: ['filter'],
    }],
    timeWindows: [{
      sourceText: '本月',
      dateMode: 'BETWEEN',
      startDate: '2026-09-01',
      endDate: '2026-09-21',
      conditionIds: ['metric'],
    }],
  });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === 'FILTER_RULE_NOT_TRACEABLE'));
});

test('contract compiler does not block a query because of an export request', () => {
  const question = '本月销售额，并帮我输出cel';
  const result = compile(question, {
    sourceType: 'INDICATOR',
    indicatorId: 'sales',
    conditions: [
      {
        id: 'metric',
        sourceText: '本月销售额',
        kind: 'METRIC',
        status: 'RESOLVED',
      },
    ],
    metricFields: [{
      field: 'sale_amt',
      sourceText: '销售额',
      conditionIds: ['metric'],
    }],
    dimensionFields: [],
    filterFields: [],
    timeWindows: [{
      sourceText: '本月',
      dateMode: 'BETWEEN',
      startDate: '2026-09-01',
      endDate: '2026-09-21',
      conditionIds: ['metric'],
    }],
  });

  assert.equal(result.valid, true, result.issues.map((issue) => issue.message).join('\n'));
  assert.equal(result.contract.coverage.at(-1).ratio, 1);
});

test('contract compiler supports prompt-defined no-filter scope modifiers', () => {
  const question = '本月全国的业绩是多少';
  const result = compile(question, {
    sourceType: 'INDICATOR',
    indicatorId: 'sales',
    conditions: [
      {
        id: 'metric',
        sourceText: '业绩',
        kind: 'METRIC',
        status: 'RESOLVED',
      },
      {
        id: 'time',
        sourceText: '本月',
        kind: 'TIME',
        status: 'RESOLVED',
      },
      {
        id: 'scope',
        sourceText: '全国',
        kind: 'SCOPE',
        status: 'RESOLVED',
        ruleSource: '用户说“全国 / 整体 / 全国整体”时表示全量整体口径，不添加过滤。',
      },
    ],
    metricFields: [{
      field: 'sale_amt',
      sourceText: '业绩',
      conditionIds: ['metric'],
    }],
    dimensionFields: [],
    filterFields: [],
    scopeModifiers: [{
      sourceText: '全国',
      action: 'NO_FILTER',
      ruleSource: '用户说“全国 / 整体 / 全国整体”时表示全量整体口径，不添加过滤。',
      conditionIds: ['scope'],
    }],
    timeWindows: [{
      sourceText: '本月',
      dateMode: 'BETWEEN',
      startDate: '2026-09-01',
      endDate: '2026-09-21',
      conditionIds: ['time'],
    }],
  });

  assert.equal(result.valid, true, result.issues.map((issue) => issue.message).join('\n'));
  assert.equal(result.contract.scopeModifiers[0].action, 'NO_FILTER');
  assert.equal(result.contract.dimensionFields.length, 0);
  assert.equal(result.contract.filterFields.length, 0);
});

test('contract compiler requires policy approval for fuzzy dataset field mappings', () => {
  const dataset = {
    id: 9,
    code: 'sales_performance',
    name: '销售经营分析',
    schemaName: 'dev',
    primaryTable: 'sales_detail',
  };
  const fields = [
    {
      fieldName: 'sale_amt',
      displayName: '含税销售金额',
      role: 'METRIC',
      semanticType: 'NUMBER',
      aggregator: 'SUM',
    },
    {
      fieldName: 'sales_date',
      displayName: '销售日期',
      role: 'TIME',
      semanticType: 'DATE',
    },
  ];
  const compileFuzzy = (theme) => new QueryContractCompiler().compile({
    question: '本月销售额',
    sourceType: 'BUSINESS_DATASET',
    dataset,
    datasetFields: fields,
    theme,
    draft: {
      sourceType: 'BUSINESS_DATASET',
      datasetId: 9,
      conditions: [
        {
          id: 'metric',
          sourceText: '本月销售额',
          kind: 'METRIC',
          status: 'RESOLVED',
        },
      ],
      metricFields: [{
        field: '销售金额',
        sourceText: '销售额',
        conditionIds: ['metric'],
      }],
      timeWindows: [{
        sourceText: '本月',
        dateMode: 'BETWEEN',
        conditionIds: ['metric'],
      }],
    },
    now,
  });
  const blocked = compileFuzzy({});
  assert.equal(blocked.valid, false);
  assert.ok(blocked.issues.some((issue) => issue.code === 'SEMANTIC_MAPPING_AMBIGUOUS'));

  const result = compileFuzzy({
    semanticPolicy: {
      policies: {
        allowFuzzyMapping: true,
      },
    },
  });
  assert.equal(result.valid, true, result.issues.map((issue) => issue.message).join('\n'));
  assert.equal(result.contract.metricFields[0].mappingMode, 'FUZZY');
  assert.equal(result.contract.provenance.mode, 'LLM_FUZZY');
  assert.equal(result.contract.provenance.label, '大模型模糊匹配');
  assert.equal(result.contract.provenance.requiresAttention, true);
});

test('contract compiler resolves approximate enum values from the default domain', () => {
  const rule = 'Standard/Std 映射到 segment_name = Standard';
  const enrichedIndicator = {
    ...indicator,
    dimensions: indicator.dimensions.map((dimension) => (
      dimension.dimensionBizName === 'business_type_name'
        ? {
          ...dimension,
          valueDomain: {
            values: ['Standard'],
            aliases: {
              Standard: ['Standard', 'Std'],
            },
            source: ['DESCRIPTION', 'PROMPT'],
          },
        }
        : dimension
    )),
  };
  const result = new QueryContractCompiler().compile({
    question: '本月Std销售额',
    sourceType: 'INDICATOR',
    indicator: enrichedIndicator,
    availableMetrics: enrichedIndicator.metrics,
    availableDimensions: enrichedIndicator.dimensions,
    theme: {
      systemPrompt: rule,
    },
    draft: {
      sourceType: 'INDICATOR',
      indicatorId: 'sales',
      conditions: [
        {
          id: 'metric',
          sourceText: '销售额',
          kind: 'METRIC',
          status: 'RESOLVED',
        },
        {
          id: 'time',
          sourceText: '本月',
          kind: 'TIME',
          status: 'RESOLVED',
        },
        {
          id: 'filter',
          sourceText: 'Std',
          kind: 'FILTER',
          status: 'RESOLVED',
          ruleSource: rule,
        },
      ],
      metricFields: [{
        field: 'sale_amt',
        sourceText: '销售额',
        conditionIds: ['metric'],
      }],
      dimensionFields: [],
      filterFields: [{
        field: 'business_type_name',
        operator: '=',
        value: 'Std',
        sourceText: 'Std',
        ruleSource: rule,
        conditionIds: ['filter'],
      }],
      timeWindows: [{
        sourceText: '本月',
        dateMode: 'BETWEEN',
        startDate: '2026-09-01',
        endDate: '2026-09-21',
        conditionIds: ['time'],
      }],
    },
    now,
  });

  assert.equal(result.valid, true, result.issues.map((issue) => issue.message).join('\n'));
  assert.equal(result.contract.filterFields[0].value, 'Standard');
  assert.equal(result.contract.filterFields[0].valueMapping.mode, 'ALIAS');
  assert.equal(
    result.contract.provenance.valueMappings[0].resolved,
    'Standard',
  );
});

test('contract compiler accepts explicit prompt-defined enum groups outside a partial domain', () => {
  const rule = 'B端子板块 重点客户组 = 企业客户、零售客户、大客户';
  const datasetFields = [
    {
      fieldName: 'sale_amt',
      displayName: '含税销售金额',
      role: 'METRIC',
      semanticType: 'NUMBER',
      dataType: 'decimal',
      aggregator: 'SUM',
    },
    {
      fieldName: 'business_type_name',
      displayName: 'segment_name',
      role: 'DIMENSION',
      semanticType: 'STRING',
      dataType: 'varchar',
      valueDomain: {
        values: ['标准配送'],
        aliases: {},
        source: ['DESCRIPTION'],
      },
    },
    {
      fieldName: 'sales_date',
      displayName: '销售日期',
      role: 'TIME',
      semanticType: 'DATE',
      dataType: 'date',
    },
  ];
  const result = new QueryContractCompiler().compile({
    question: '本月重点客户组的业绩是多少',
    sourceType: 'BUSINESS_DATASET',
    dataset: { id: 3, name: 'sales_fact' },
    datasetFields,
    theme: {
      systemPrompt: rule,
    },
    draft: {
      sourceType: 'BUSINESS_DATASET',
      datasetId: 3,
      conditions: [
        { id: 'metric', sourceText: '业绩', kind: 'METRIC', status: 'RESOLVED' },
        {
          id: 'filter',
          sourceText: '重点客户组',
          kind: 'FILTER',
          status: 'RESOLVED',
          ruleSource: rule,
        },
        { id: 'time', sourceText: '本月', kind: 'TIME', status: 'RESOLVED' },
      ],
      metricFields: [{
        field: 'sale_amt',
        sourceText: '业绩',
        conditionIds: ['metric'],
      }],
      filterFields: [{
        field: 'business_type_name',
        operator: 'IN',
        value: ['企业客户', '零售客户', '大客户'],
        sourceText: '重点客户组',
        ruleSource: rule,
        conditionIds: ['filter'],
      }],
      timeWindows: [{
        sourceText: '本月',
        dateMode: 'BETWEEN',
        startDate: '2026-09-01',
        endDate: '2026-09-21',
        conditionIds: ['time'],
      }],
    },
    now,
  });

  assert.equal(result.valid, true, result.issues.map((issue) => issue.message).join('\n'));
  assert.deepEqual(
    result.contract.filterFields[0].value,
    ['企业客户', '零售客户', '大客户'],
  );
  assert.equal(result.contract.filterFields[0].valueMapping.mode, 'RULE');
});

test('separate wording promotes an enum filter field to a breakdown dimension', () => {
  const datasetFields = [
    {
      fieldName: 'sales_date',
      displayName: '销售日期',
      role: 'TIME',
      semanticType: 'DATE',
      dataType: 'date',
    },
    {
      fieldName: 'business_type_name',
      displayName: 'segment_name',
      role: 'DIMENSION',
      semanticType: 'STRING',
      dataType: 'varchar',
    },
    {
      fieldName: 'rp_management_classify_name',
      displayName: 'management_category',
      role: 'DIMENSION',
      semanticType: 'STRING',
      dataType: 'varchar',
    },
    {
      fieldName: 'sale_amt',
      displayName: '含税销售金额',
      role: 'METRIC',
      semanticType: 'NUMBER',
      dataType: 'decimal',
      aggregator: 'SUM',
    },
  ];
  const result = new QueryContractCompiler().compile({
    question: '本月标准配送，销售组和采购组全国的业绩分别是多少',
    sourceType: 'BUSINESS_DATASET',
    dataset: { id: 3, name: 'sales_fact' },
    datasetFields,
    theme: {
      systemPrompt: [
        '采购组单独出现且业务类型已由上下文限定时 -> management_category = 采购组',
        '用户说“全国、整体、全国整体”时表示全量整体口径，不添加过滤。',
      ].join('\n'),
    },
    draft: {
      sourceType: 'BUSINESS_DATASET',
      datasetId: 3,
      conditions: [
        { id: 'metric', sourceText: '业绩', kind: 'METRIC', status: 'RESOLVED' },
        { id: 'time', sourceText: '本月', kind: 'TIME', status: 'RESOLVED' },
        {
          id: 'businessType',
          sourceText: '标准配送',
          kind: 'FILTER',
          status: 'RESOLVED',
        },
        {
          id: 'separate',
          sourceText: '销售组和采购组',
          kind: 'FILTER',
          status: 'RESOLVED',
        },
        {
          id: 'scope',
          sourceText: '全国',
          kind: 'SCOPE',
          status: 'RESOLVED',
          ruleSource: '用户说“全国、整体、全国整体”时表示全量整体口径，不添加过滤。',
        },
      ],
      metricFields: [{
        field: 'sale_amt',
        sourceText: '业绩',
        conditionIds: ['metric'],
      }],
      dimensionFields: [],
      filterFields: [
        {
          field: 'business_type_name',
          operator: '=',
          value: '标准配送',
          sourceText: '标准配送',
          conditionIds: ['businessType'],
        },
        {
          field: 'rp_management_classify_name',
          operator: 'IN',
          value: ['销售组', '采购组'],
          sourceText: '销售组和采购组',
          conditionIds: ['separate'],
        },
      ],
      scopeModifiers: [{
        sourceText: '全国',
        action: 'NO_FILTER',
        ruleSource: '用户说“全国、整体、全国整体”时表示全量整体口径，不添加过滤。',
        conditionIds: ['scope'],
      }],
      timeWindows: [{
        sourceText: '本月',
        dateMode: 'BETWEEN',
        startDate: '2026-09-01',
        endDate: '2026-09-21',
        conditionIds: ['time'],
      }],
    },
    now,
  });

  assert.equal(result.valid, true, result.issues.map((issue) => issue.message).join('\n'));
  assert.ok(result.contract.dimensionFields.some(
    (dimension) => dimension.field === 'rp_management_classify_name',
  ));
  assert.ok(result.contract.filterFields.some(
    (filter) => filter.field === 'rp_management_classify_name',
  ));
});

test('contract compiler blocks ambiguous enum values instead of guessing', () => {
  const rule = 'segment_name枚举：AlphaOne、AlphaTwo';
  const enrichedIndicator = {
    ...indicator,
    dimensions: indicator.dimensions.map((dimension) => (
      dimension.dimensionBizName === 'business_type_name'
        ? {
          ...dimension,
          valueDomain: {
            values: ['AlphaOne', 'AlphaTwo'],
            aliases: {},
            source: ['PROMPT'],
          },
        }
        : dimension
    )),
  };
  const result = new QueryContractCompiler().compile({
    question: '本月Alpha销售额',
    sourceType: 'INDICATOR',
    indicator: enrichedIndicator,
    availableMetrics: enrichedIndicator.metrics,
    availableDimensions: enrichedIndicator.dimensions,
    theme: {
      systemPrompt: rule,
    },
    draft: {
      sourceType: 'INDICATOR',
      indicatorId: 'sales',
      conditions: [
        { id: 'metric', sourceText: '销售额', kind: 'METRIC', status: 'RESOLVED' },
        { id: 'time', sourceText: '本月', kind: 'TIME', status: 'RESOLVED' },
        {
          id: 'filter',
          sourceText: 'Alpha',
          kind: 'FILTER',
          status: 'RESOLVED',
          ruleSource: rule,
        },
      ],
      metricFields: [{
        field: 'sale_amt',
        sourceText: '销售额',
        conditionIds: ['metric'],
      }],
      filterFields: [{
        field: 'business_type_name',
        operator: '=',
        value: 'Alpha',
        sourceText: 'Alpha',
        ruleSource: rule,
        conditionIds: ['filter'],
      }],
      timeWindows: [{
        sourceText: '本月',
        dateMode: 'BETWEEN',
        startDate: '2026-09-01',
        endDate: '2026-09-21',
        conditionIds: ['time'],
      }],
    },
    now,
  });

  assert.equal(result.valid, false);
  const ambiguous = result.issues.find((issue) => issue.code === 'FILTER_VALUE_AMBIGUOUS');
  assert.ok(ambiguous);
  // 值歧义必须带上机器可读的候选值，上层才能把它变成一次「选哪个值」的澄清。
  assert.equal(ambiguous.field, 'business_type_name');
  assert.equal(ambiguous.requestedValue, 'Alpha');
  assert.deepEqual(ambiguous.candidates, ['AlphaOne', 'AlphaTwo']);
});

test('contract compiler normalizes dataset post-processing fields', () => {
  const datasetFields = [
    {
      fieldName: 'sdt',
      displayName: '销售日期',
      role: 'TIME',
      semanticType: 'DATE',
      dataType: 'date',
    },
    {
      fieldName: 'business_type_name',
      displayName: 'segment_name',
      role: 'DIMENSION',
      semanticType: 'STRING',
      dataType: 'varchar',
    },
    {
      fieldName: 'performance_province_name',
      displayName: 'sales_region_name',
      role: 'DIMENSION',
      semanticType: 'STRING',
      dataType: 'varchar',
    },
    {
      fieldName: 'first_category_name',
      displayName: 'industry_name',
      role: 'DIMENSION',
      semanticType: 'STRING',
      dataType: 'varchar',
    },
    {
      fieldName: 'sale_amt',
      displayName: '含税销售额',
      role: 'METRIC',
      semanticType: 'NUMBER',
      dataType: 'decimal',
      aggregator: 'SUM',
    },
  ];
  const question = [
    '2026年8月分省区标准配送含税销售额及同比',
    '行业Government、Corrections和Education单列，UtilitiesFinance=Utilities+Finance',
    '行展示省区，列行业，含税销售额和同比，右侧增加合计列',
  ].join('；');
  const result = new QueryContractCompiler().compile({
    question,
    sourceType: 'BUSINESS_DATASET',
    dataset: { id: 1, name: '销售经营分析' },
    datasetFields,
    theme: {
      systemPrompt: '标准配送/标准配送映射到 segment_name = 标准配送',
    },
    draft: {
      sourceType: 'BUSINESS_DATASET',
      datasetId: 1,
      conditions: [
        { id: 'time', sourceText: '2026年8月', kind: 'TIME', status: 'RESOLVED' },
        {
          id: 'filter',
          sourceText: '标准配送',
          kind: 'FILTER',
          status: 'RESOLVED',
          ruleSource: '标准配送/标准配送映射到 segment_name = 标准配送',
        },
        { id: 'metric', sourceText: '含税销售额', kind: 'METRIC', status: 'RESOLVED' },
        { id: 'province', sourceText: '省区', kind: 'DIMENSION', status: 'RESOLVED' },
        { id: 'industry', sourceText: '行业', kind: 'DIMENSION', status: 'RESOLVED' },
        { id: 'compare', sourceText: '同比', kind: 'CALCULATION', status: 'RESOLVED' },
        {
          id: 'group',
          sourceText: '行业Government、Corrections和Education单列，UtilitiesFinance=Utilities+Finance',
          kind: 'CALCULATION',
          status: 'RESOLVED',
        },
        {
          id: 'layout',
          sourceText: '行展示省区，列行业，含税销售额和同比，右侧增加合计列',
          kind: 'RESULT_ACTION',
          status: 'RESOLVED',
        },
      ],
      metricFields: [{
        field: '含税销售额',
        sourceText: '含税销售额',
        aggregator: 'SUM',
        conditionIds: ['metric'],
      }],
      dimensionFields: [
        {
          field: 'sales_region_name',
          sourceText: '省区',
          conditionIds: ['province'],
        },
        {
          field: 'industry_name',
          sourceText: '行业',
          conditionIds: ['industry'],
        },
      ],
      filterFields: [{
        field: 'segment_name',
        operator: '=',
        value: '标准配送',
        sourceText: '标准配送',
        ruleSource: '标准配送/标准配送映射到 segment_name = 标准配送',
        conditionIds: ['filter'],
      }],
      timeWindows: [
        {
          sourceText: '2026年8月',
          label: '本期',
          dateMode: 'BETWEEN',
          startDate: '2026-08-01',
          endDate: '2026-08-31',
          conditionIds: ['time'],
        },
        {
          sourceText: '同比',
          label: '去年同期',
          dateMode: 'BETWEEN',
          startDate: '2025-08-01',
          endDate: '2025-08-31',
          conditionIds: ['compare'],
        },
      ],
      calculation: {
        type: 'PERIOD_COMPARISON',
        baseWindowIndex: 1,
        compareWindowIndex: 0,
      },
      postProcessing: {
        groupValues: {
          field: 'industry_name',
          outputField: '行业分组',
          defaultValue: '其他',
          groups: [
            { name: 'Government', values: ['Government'] },
            { name: 'Corrections', values: ['Corrections'] },
            { name: 'Education', values: ['Education'] },
            { name: 'UtilitiesFinance', values: ['Utilities', 'Finance'] },
          ],
        },
        periodComparison: {
          metric: '含税销售额',
          outputField: '同比',
          type: 'RATE',
          rowFields: ['sales_region_name', '行业分组'],
        },
        pivot: {
          rowFields: ['sales_region_name'],
          columnField: '行业分组',
          valueFields: [
            { field: '含税销售额', label: '含税销售额' },
            { field: '同比', label: '同比' },
          ],
          includeTotal: true,
          totalLabel: '合计',
        },
      },
    },
    sourceContext: question,
    now,
  });

  assert.equal(result.valid, true);
  assert.equal(result.contract.calculation.baseWindowIndex, 0);
  assert.equal(result.contract.calculation.compareWindowIndex, 1);
  assert.equal(result.contract.postProcessing.groupValues.field, 'first_category_name');
  assert.equal(result.contract.postProcessing.periodComparison.metric, 'sale_amt');
  assert.deepEqual(
    result.contract.postProcessing.pivot.rowFields,
    ['performance_province_name'],
  );
});

test('dataset trend contracts use the canonical sales date instead of a model-selected timestamp', () => {
  const question = '今年重点客户组每个月的业绩趋势';
  const result = new QueryContractCompiler().compile({
    question,
    sourceType: 'BUSINESS_DATASET',
    dataset: {
      id: 3,
      name: 'sales_fact',
    },
    datasetFields: [
      {
        fieldName: 'sales_date',
        displayName: '销售日期',
        semanticType: 'DATE',
        role: 'TIME',
      },
      {
        fieldName: 'sale_time',
        displayName: '销售时间',
        semanticType: 'DATE',
        role: 'TIME',
      },
      {
        fieldName: 'sale_amt',
        displayName: '含税销售额',
        semanticType: 'NUMBER',
        role: 'METRIC',
        aggregator: 'SUM',
      },
      {
        fieldName: 'business_type_name',
        displayName: 'segment_name',
        semanticType: 'STRING',
        role: 'DIMENSION',
      },
    ],
    theme: {
      systemPrompt: [
        '业绩 -> 含税销售额',
        '重点客户组 = 企业客户、零售客户、大客户',
        '按月趋势使用销售日期',
      ].join('\n'),
    },
    draft: {
      sourceType: 'BUSINESS_DATASET',
      datasetId: 3,
      conditions: [
        {
          id: 'time',
          sourceText: '今年',
          kind: 'TIME',
          status: 'RESOLVED',
          ruleSource: '右边界截止 T-1',
        },
        {
          id: 'filter',
          sourceText: '重点客户组',
          kind: 'FILTER',
          status: 'RESOLVED',
          ruleSource: '重点客户组 = 企业客户、零售客户、大客户',
        },
        {
          id: 'metric',
          sourceText: '业绩',
          kind: 'METRIC',
          status: 'RESOLVED',
          ruleSource: '业绩 -> 含税销售额',
        },
        {
          id: 'grain',
          sourceText: '每个月',
          kind: 'DIMENSION',
          status: 'RESOLVED',
          ruleSource: '按月趋势使用销售日期',
        },
        {
          id: 'trend',
          sourceText: '趋势',
          kind: 'RESULT_ACTION',
          status: 'RESOLVED',
          ruleSource: '趋势按时间维度展示',
        },
      ],
      metricFields: [{
        field: '含税销售额',
        sourceText: '业绩',
        aggregator: 'SUM',
        conditionIds: ['metric'],
      }],
      dimensionFields: [{
        field: '销售时间',
        sourceText: '每个月',
        timeGrain: 'MONTH',
        conditionIds: ['grain'],
      }],
      filterFields: [{
        field: 'segment_name',
        operator: 'IN',
        value: ['企业客户', '零售客户', '大客户'],
        sourceText: '重点客户组',
        ruleSource: '重点客户组 = 企业客户、零售客户、大客户',
        conditionIds: ['filter'],
      }],
      timeWindows: [{
        sourceText: '今年',
        label: '今年',
        dateMode: 'BETWEEN',
        startDate: '2026-01-01',
        endDate: '2026-09-22',
        conditionIds: ['time'],
      }],
      timeGrain: 'MONTH',
    },
    sourceContext: question,
    now,
  });

  assert.equal(
    result.valid,
    true,
    result.issues.map((issue) => issue.message).join('\n'),
  );
  assert.equal(result.contract.dimensionFields.length, 1);
  assert.equal(result.contract.dimensionFields[0].field, 'sales_date');
  assert.equal(result.contract.timeGrain, 'MONTH');
});

test('contract compiler normalizes LIKE patterns and aggregate filter scope', () => {
  const question = '2026年8月销售额不低于50万且名称包含Demo Customer的客户';
  const result = new QueryContractCompiler().compile({
    question,
    sourceType: 'BUSINESS_DATASET',
    dataset: { id: 3, name: 'sales_fact' },
    datasetFields: [
      {
        fieldName: 'sales_date',
        displayName: '销售日期',
        role: 'TIME',
        semanticType: 'DATE',
      },
      {
        fieldName: 'customer_name',
        displayName: 'customer_name',
        role: 'DIMENSION',
        semanticType: 'STRING',
      },
      {
        fieldName: 'sale_amt',
        displayName: '含税销售额',
        role: 'METRIC',
        semanticType: 'NUMBER',
        aggregator: 'SUM',
      },
    ],
    draft: {
      sourceType: 'BUSINESS_DATASET',
      datasetId: 3,
      conditions: [
        {
          id: 'time',
          sourceText: '2026年8月',
          kind: 'TIME',
          status: 'RESOLVED',
        },
        {
          id: 'customer',
          sourceText: '名称包含Demo Customer的客户',
          kind: 'DIMENSION',
          status: 'RESOLVED',
        },
        {
          id: 'metric',
          sourceText: '销售额',
          kind: 'METRIC',
          status: 'RESOLVED',
        },
        {
          id: 'threshold',
          sourceText: '销售额不低于50万',
          kind: 'FILTER',
          status: 'RESOLVED',
        },
      ],
      metricFields: [{
        field: '含税销售额',
        sourceText: '销售额',
        aggregator: 'SUM',
        conditionIds: ['metric'],
      }],
      dimensionFields: [{
        field: 'customer_name',
        sourceText: '客户',
        conditionIds: ['customer'],
      }],
      filterFields: [
        {
          field: 'customer_name',
          operator: 'LIKE',
          value: 'Demo Customer',
          sourceText: '名称包含Demo Customer',
          conditionIds: ['customer'],
        },
        {
          field: '含税销售额',
          operator: '>=',
          value: 500000,
          sourceText: '销售额不低于50万',
          conditionIds: ['threshold'],
        },
      ],
      timeWindows: [{
        sourceText: '2026年8月',
        label: '2026年8月',
        dateMode: 'BETWEEN',
        startDate: '2026-08-01',
        endDate: '2026-08-31',
        conditionIds: ['time'],
      }],
    },
    sourceContext: question,
    now,
  });

  assert.equal(
    result.valid,
    true,
    result.issues.map((issue) => issue.message).join('\n'),
  );
  const customerFilter = result.contract.filterFields.find(
    (filter) => filter.field === 'customer_name',
  );
  const amountFilter = result.contract.filterFields.find(
    (filter) => filter.field === 'sale_amt',
  );
  assert.equal(customerFilter.value, '%Demo Customer%');
  assert.equal(customerFilter.scope, 'ROW');
  assert.equal(amountFilter.scope, 'AGGREGATE');
});

test('contract compiler accepts structured derived metrics and auto-binds base fields', () => {
  const question = '2026年8月未税毛利率';
  const result = new QueryContractCompiler().compile({
    question,
    sourceType: 'BUSINESS_DATASET',
    dataset: { id: 3, name: 'sales_fact' },
    datasetFields: [
      {
        fieldName: 'sales_date',
        displayName: '销售日期',
        role: 'TIME',
        semanticType: 'DATE',
      },
      {
        fieldName: 'profit_no_tax',
        displayName: '未税毛利额',
        role: 'METRIC',
        semanticType: 'NUMBER',
        aggregator: 'SUM',
      },
      {
        fieldName: 'sale_amt_no_tax',
        displayName: '未税销售额',
        role: 'METRIC',
        semanticType: 'NUMBER',
        aggregator: 'SUM',
      },
    ],
    draft: {
      sourceType: 'BUSINESS_DATASET',
      datasetId: 3,
      conditions: [
        {
          id: 'time',
          sourceText: '2026年8月',
          kind: 'TIME',
          status: 'RESOLVED',
        },
        {
          id: 'margin',
          sourceText: '未税毛利率',
          kind: 'CALCULATION',
          status: 'RESOLVED',
          ruleSource: '未税毛利率 = 未税毛利额 / 未税销售额',
        },
      ],
      metricFields: [],
      derivedMetrics: [{
        name: '未税毛利率',
        type: 'RATIO',
        numerator: '未税毛利额',
        denominator: '未税销售额',
        outputField: 'untaxed_gross_margin',
        outputFormat: 'PERCENT',
        conditionIds: ['margin'],
        ruleSource: '未税毛利率 = 未税毛利额 / 未税销售额',
      }],
      timeWindows: [{
        sourceText: '2026年8月',
        label: '2026年8月',
        dateMode: 'BETWEEN',
        startDate: '2026-08-01',
        endDate: '2026-08-31',
        conditionIds: ['time'],
      }],
    },
    theme: {
      systemPrompt: '未税毛利率 = 未税毛利额 / 未税销售额',
    },
    sourceContext: question,
    now,
  });

  assert.equal(
    result.valid,
    true,
    result.issues.map((issue) => issue.message).join('\n'),
  );
  assert.equal(result.contract.derivedMetrics.length, 1);
  assert.deepEqual(
    result.contract.metricFields.map((field) => field.field).sort(),
    ['profit_no_tax', 'sale_amt_no_tax'],
  );
});

test('contract compiler rejects a missing aggregate threshold filter', () => {
  const question = '2026年8月销售额不低于50万的客户';
  const result = new QueryContractCompiler().compile({
    question,
    sourceType: 'BUSINESS_DATASET',
    dataset: { id: 3, name: 'sales_fact' },
    datasetFields: [
      {
        fieldName: 'sales_date',
        displayName: '销售日期',
        role: 'TIME',
        semanticType: 'DATE',
      },
      {
        fieldName: 'customer_name',
        displayName: 'customer_name',
        role: 'DIMENSION',
        semanticType: 'STRING',
      },
      {
        fieldName: 'sale_amt',
        displayName: '含税销售额',
        role: 'METRIC',
        semanticType: 'NUMBER',
        aggregator: 'SUM',
      },
    ],
    draft: {
      sourceType: 'BUSINESS_DATASET',
      datasetId: 3,
      conditions: [
        {
          id: 'time',
          sourceText: '2026年8月',
          kind: 'TIME',
          status: 'RESOLVED',
        },
        {
          id: 'customer',
          sourceText: '客户',
          kind: 'DIMENSION',
          status: 'RESOLVED',
        },
        {
          id: 'metric',
          sourceText: '销售额',
          kind: 'METRIC',
          status: 'RESOLVED',
        },
      ],
      metricFields: [{
        field: '含税销售额',
        sourceText: '销售额',
        aggregator: 'SUM',
        conditionIds: ['metric'],
      }],
      dimensionFields: [{
        field: 'customer_name',
        sourceText: '客户',
        conditionIds: ['customer'],
      }],
      filterFields: [],
      timeWindows: [{
        sourceText: '2026年8月',
        label: '2026年8月',
        dateMode: 'BETWEEN',
        startDate: '2026-08-01',
        endDate: '2026-08-31',
        conditionIds: ['time'],
      }],
    },
    sourceContext: question,
    now,
  });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some(
    (issue) => issue.code === 'FILTER_THRESHOLD_NOT_BOUND',
  ));
});

test('contract compiler accepts a generic multi-stage analysis pipeline', () => {
  const question = '找出2026年5~8月连续4个月，标准配送月销>30万、毛利率均低于5%的客户。按满足条件的月数降序，再按8月销售额降序取TOP10客户';
  const result = new QueryContractCompiler().compile({
    question,
    sourceType: 'BUSINESS_DATASET',
    dataset,
    datasetFields,
    theme: {
      systemPrompt: '标准配送 -> segment_name = 标准配送',
      semanticPolicy: {
        metrics: [],
        dimensions: [],
        filters: [],
        enumGroups: [],
        policies: { allowFuzzyMapping: false },
        plugins: [],
      },
    },
    draft: {
      sourceType: 'BUSINESS_DATASET',
      datasetId: 3,
      conditions: [
        {
          id: 'time',
          sourceText: '2026年5~8月',
          kind: 'TIME',
          status: 'RESOLVED',
        },
        {
          id: 'business',
          sourceText: '标准配送',
          kind: 'FILTER',
          status: 'RESOLVED',
          ruleSource: '标准配送 -> segment_name = 标准配送',
        },
        {
          id: 'metric',
          sourceText: '月销',
          kind: 'METRIC',
          status: 'RESOLVED',
        },
        {
          id: 'margin',
          sourceText: '毛利率',
          kind: 'METRIC',
          status: 'RESOLVED',
        },
        {
          id: 'customer',
          sourceText: '客户',
          kind: 'DIMENSION',
          status: 'RESOLVED',
        },
        {
          id: 'stage',
          sourceText: '按满足条件的月数降序',
          kind: 'ANALYSIS_STAGE',
          status: 'RESOLVED',
        },
        {
          id: 'stage-threshold-sales',
          sourceText: '月销>30万',
          kind: 'ANALYSIS_STAGE',
          status: 'RESOLVED',
        },
        {
          id: 'stage-threshold-margin',
          sourceText: '毛利率均低于5%',
          kind: 'ANALYSIS_STAGE',
          status: 'RESOLVED',
        },
        {
          id: 'top',
          sourceText: 'TOP10客户',
          kind: 'LIMIT',
          status: 'RESOLVED',
        },
      ],
      metricFields: [
        {
          field: 'sale_amt',
          sourceText: '月销',
          aggregator: 'SUM',
          conditionIds: ['metric'],
        },
        {
          field: 'sale_cost',
          sourceText: '毛利率',
          aggregator: 'SUM',
          internal: true,
          conditionIds: ['margin'],
        },
      ],
      dimensionFields: [
        {
          field: 'sales_date',
          sourceText: '2026年5~8月',
          timeGrain: 'MONTH',
          conditionIds: ['time'],
        },
        {
          field: 'customer_code',
          sourceText: '客户',
          conditionIds: ['customer'],
        },
      ],
      filterFields: [{
        field: 'business_type_name',
        operator: 'IN',
        value: ['标准配送'],
        sourceText: '标准配送',
        ruleSource: '标准配送 -> segment_name = 标准配送',
        conditionIds: ['business'],
      }],
      timeWindows: [{
        sourceText: '2026年5~8月',
        dateMode: 'BETWEEN',
        startDate: '2026-05-01',
        endDate: '2026-08-31',
        conditionIds: ['time'],
      }],
      timeGrain: 'MONTH',
      limit: 10,
      analysisPipeline: {
        stages: [
          {
            type: 'DERIVE',
            definitions: [{
              name: '毛利率',
              type: 'EXPRESSION',
              outputField: 'gross_margin',
              expression: {
                op: 'DIVIDE',
                left: {
                  op: 'SUBTRACT',
                  left: { field: 'sale_amt' },
                  right: { field: 'sale_cost' },
                },
                right: { op: 'ABS', value: { field: 'sale_amt' } },
              },
            }],
          },
          {
            type: 'ROLLUP',
            groupBy: ['customer_code'],
            outputs: [
              {
                type: 'COUNT_IF',
                outputField: 'qualified_months',
                predicate: {
                  mode: 'ALL',
                  conditions: [
                    { field: 'sale_amt', operator: '>', value: 300000 },
                    { field: 'gross_margin', operator: '<', value: 0.05 },
                  ],
                },
              },
            ],
          },
          {
            type: 'FILTER',
            predicate: {
              mode: 'ALL',
              conditions: [
                { field: 'qualified_months', operator: '=', value: 4 },
              ],
            },
          },
          {
            type: 'SORT',
            order: [{ field: 'qualified_months', direction: 'DESC' }],
          },
          { type: 'LIMIT', value: 10 },
        ],
      },
    },
    now,
  });

  assert.equal(result.valid, true, result.issues.map((issue) => issue.message).join('\n'));
  assert.equal(result.contract.analysisPipeline.stages.length, 5);
  assert.equal(result.contract.limit, 50000);
  assert.equal(result.contract.timeGrain, 'MONTH');
  assert.equal(result.contract.timeWindows[0].startDate, '2026-05-01');
  assert.equal(result.contract.timeWindows[0].endDate, '2026-08-31');
});
