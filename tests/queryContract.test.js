import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDeterministicSummary,
  buildQueryContract,
  buildQueryScopeSummary,
  queryFingerprint,
  selectPublicResult,
  stabilizeQueryResult,
} from '../src/queryContract.js';

const columns = [
  { name: '销售日期', bizName: 'sdt', showType: 'CATEGORY' },
  { name: '大区', bizName: 'region', showType: 'CATEGORY' },
  { name: '含税销售金额', bizName: 'sale_amt', showType: 'NUMBER' },
];

test('query contract and result hash are independent of input order', () => {
  const firstContract = buildQueryContract({
    indicatorId: '2',
    metrics: ['sale_amt'],
    dimensions: ['region', 'sdt'],
    filters: [{ bizName: 'region', operator: 'in', value: ['华东', '华南'] }],
    dateInfo: {
      dateMode: 'between',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
      dateField: 'sdt',
    },
    limit: 200,
  });
  const secondContract = buildQueryContract({
    indicatorId: '2',
    metrics: ['sale_amt'],
    dimensions: ['sdt', 'region'],
    filters: [{ bizName: 'region', operator: 'IN', value: ['华南', '华东'] }],
    dateInfo: {
      dateMode: 'BETWEEN',
      startDate: '2026-09-01',
      endDate: '2026-09-07',
      dateField: 'sdt',
    },
    limit: 200,
  });
  assert.equal(queryFingerprint(firstContract), queryFingerprint(secondContract));

  const rows = [
    { sdt: '2026-09-02', region: '华东', sale_amt: 20 },
    { sdt: '2026-09-01', region: '华东', sale_amt: 10 },
  ];
  const first = stabilizeQueryResult({
    columns,
    rows,
    contract: firstContract,
    question: '查询每天含税销售金额',
  });
  const second = stabilizeQueryResult({
    columns: [...columns].reverse(),
    rows: [...rows].reverse(),
    contract: secondContract,
    question: '查询每天含税销售金额',
  });

  assert.deepEqual(
    first.rows.map((row) => row.sdt),
    ['2026-09-01', '2026-09-02'],
  );
  assert.equal(first.dataHash, second.dataHash);
  assert.deepEqual(
    first.columns.map((column) => column.bizName),
    ['region', 'sdt', 'sale_amt'],
  );
  assert.deepEqual(first.rows, second.rows);
});

test('ranking results are sorted by the requested metric deterministically', () => {
  const contract = buildQueryContract({
    indicatorId: '2',
    metrics: ['sale_amt'],
    dimensions: ['region'],
    dateInfo: null,
    limit: 200,
  });
  const result = stabilizeQueryResult({
    columns: [
      { name: '大区', bizName: 'region', showType: 'CATEGORY' },
      { name: '含税销售金额', bizName: 'sale_amt', showType: 'NUMBER' },
    ],
    rows: [
      { region: '华南', sale_amt: 20 },
      { region: '华东', sale_amt: 50 },
      { region: '华北', sale_amt: 30 },
    ],
    contract,
    question: '按大区排名含税销售金额',
  });

  assert.deepEqual(
    result.rows.map((row) => row.region),
    ['华东', '华北', '华南'],
  );
});

test('analysis pipeline keeps its projected column and row order', () => {
  const contract = buildQueryContract({
    indicatorId: 'dataset:1',
    metrics: ['sale_amt'],
    dimensions: ['customer_code'],
    limit: 2000,
    analysisPipeline: {
      stages: [{
        type: 'LIMIT',
        value: 2,
      }],
    },
  });
  const result = stabilizeQueryResult({
    columns: [
      { name: '符合月数', bizName: 'qualified_months', showType: 'NUMBER' },
      { name: 'customer_code', bizName: 'customer_code', showType: 'CATEGORY' },
      { name: '销售额', bizName: 'sale_amt', showType: 'NUMBER' },
    ],
    rows: [
      { customer_code: 'B', sale_amt: 50, qualified_months: 4 },
      { customer_code: 'A', sale_amt: 40, qualified_months: 3 },
    ],
    contract,
    question: '按客户取数',
  });

  assert.deepEqual(
    result.columns.map((column) => column.bizName),
    ['qualified_months', 'customer_code', 'sale_amt'],
  );
  assert.deepEqual(
    result.rows.map((row) => row.customer_code),
    ['B', 'A'],
  );
});

test('complete result policies survive contract reconstruction', () => {
  const contract = buildQueryContract({
    indicatorId: 'dataset:1',
    metrics: ['sale_amt'],
    dimensions: ['customer_code', '__period'],
    limit: 5000,
    limitPolicy: {
      reason: 'COMPLETE_RESULT_SET',
      intentionalTopN: null,
      expectedRowDensity: 'HIGH',
    },
  });

  assert.equal(contract.limit, 5000);
  assert.equal(contract.limitPolicy.reason, 'COMPLETE_RESULT_SET');
  assert.equal(contract.limitPolicy.expectedRowDensity, 'HIGH');
});

test('deterministic summary keeps the answer focused on the aggregate result', () => {
  const contract = buildQueryContract({
    indicatorId: '2',
    metrics: ['sale_amt'],
    dimensions: ['sdt'],
    filters: [{ bizName: 'region', operator: 'IN', value: ['华东'] }],
    dateInfo: {
      dateMode: 'BETWEEN',
      startDate: '2026-09-01',
      endDate: '2026-09-02',
      dateField: 'sdt',
    },
    limit: 200,
  });
  const summary = buildDeterministicSummary({
    subjectName: '含税销售金额',
    columns,
    rows: [
      { sdt: '2026-09-01', region: '华东', sale_amt: 10 },
      { sdt: '2026-09-02', region: '华东', sale_amt: 20 },
    ],
    contract,
    question: '查询2026年9月1日到2026年9月2日含税销售金额',
  });

  assert.match(summary, /含税销售金额合计 \*\*30\*\*/);
  assert.doesNotMatch(summary, /查询范围/);
  assert.doesNotMatch(summary, /2026-09-01 至 2026-09-02/);
  assert.equal(
    summary,
    buildDeterministicSummary({
      subjectName: '含税销售金额',
      columns,
      rows: [
        { sdt: '2026-09-01', region: '华东', sale_amt: 10 },
        { sdt: '2026-09-02', region: '华东', sale_amt: 20 },
      ],
      contract,
      question: '查询2026年9月1日到2026年9月2日含税销售金额',
    }),
  );
});

test('grouped answers name the dimension values instead of only repeating a total', () => {
  const contract = buildQueryContract({
    indicatorId: '2',
    metrics: ['sale_amt'],
    dimensions: ['region'],
    dateInfo: {
      dateMode: 'BETWEEN',
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      dateField: 'sdt',
    },
  });
  const summary = buildDeterministicSummary({
    subjectName: '含税销售金额',
    columns: [
      { name: '大区', bizName: 'region', showType: 'CATEGORY' },
      { name: '含税销售金额', bizName: 'sale_amt', showType: 'NUMBER' },
    ],
    rows: [
      { region: '华东', sale_amt: 100 },
      { region: '华南', sale_amt: 80 },
      { region: '华北', sale_amt: 60 },
    ],
    contract,
    question: '9月各大区含税销售金额',
  });

  assert.match(summary, /按大区看/);
  assert.match(summary, /华东\*\* 100/);
  assert.match(summary, /华南\*\* 80/);
  assert.doesNotMatch(summary, /整体来看|以下是|关键结果/);
});

test('small grouped results list every dimension value instead of folding the rest', () => {
  const contract = buildQueryContract({
    indicatorId: '2',
    metrics: ['sale_amt'],
    dimensions: ['region'],
    dateInfo: {
      dateMode: 'BETWEEN',
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      dateField: 'sdt',
    },
  });
  const rows = Array.from({ length: 15 }, (_, index) => ({
    region: `区域${index + 1}`,
    sale_amt: 150 - index * 10,
  }));
  const summary = buildDeterministicSummary({
    subjectName: '含税销售金额',
    columns: [
      { name: '大区', bizName: 'region', showType: 'CATEGORY' },
      { name: '含税销售金额', bizName: 'sale_amt', showType: 'NUMBER' },
    ],
    rows,
    contract,
    question: '9月各大区含税销售金额',
  });

  assert.match(summary, /区域1\*\* 150/);
  assert.match(summary, /区域15\*\* 10/);
  assert.doesNotMatch(summary, /其余/);
});

test('monthly trend summary marks an incomplete final month', () => {
  const contract = buildQueryContract({
    indicatorId: '2',
    metrics: ['sale_amt'],
    dimensions: ['sdt'],
    dateInfo: {
      dateMode: 'BETWEEN',
      startDate: '2026-01-01',
      endDate: '2026-09-21',
      dateField: 'sdt',
    },
    timeGrain: 'MONTH',
    limit: 200,
  });
  const summary = buildDeterministicSummary({
    subjectName: '含税销售金额',
    columns,
    rows: [
      { sdt: '2026-01-01', sale_amt: 100 },
      { sdt: '2026-09-01', sale_amt: 20 },
    ],
    contract,
    question: '2026年标准配送每个月的业绩趋势',
  });

  assert.match(summary, /2026-09-21，为未完整月/);
  assert.match(summary, /2026-01 的 100/);
  assert.match(summary, /2026-09 的 20/);
  assert.doesNotMatch(summary, /2026-01-01：100/);
});

test('a single-month trend request explains the missing cross-month baseline', () => {
  const contract = buildQueryContract({
    indicatorId: 'dataset:1',
    metrics: ['sale_amt'],
    dimensions: ['classify_name', 'sales_date'],
    timeGrain: 'MONTH',
    timeWindows: [{
      label: '2026年9月',
      startDate: '2026-09-01',
      endDate: '2026-09-30',
    }],
  });
  const message = buildDeterministicSummary({
    subjectName: '含税销售额',
    columns: [
      { name: '经营管理分类', bizName: 'classify_name', showType: 'CATEGORY' },
      { name: '销售月份', bizName: 'sales_date', showType: 'CATEGORY' },
      {
        name: '含税销售额（万元）',
        bizName: 'sale_amt',
        showType: 'NUMBER',
        presentationType: 'amount',
        displayScale: 0.0001,
      },
    ],
    rows: [
      { classify_name: '生鲜-蔬菜', sales_date: '2026-09-01', sale_amt: 7176600 },
      { classify_name: '生鲜-水果', sales_date: '2026-09-01', sale_amt: 3994800 },
    ],
    contract,
    question: '2026年9月销售额按品类和月份趋势',
  });

  assert.match(message, /只覆盖 2026-09 一个月，无法形成跨月趋势/);
  assert.match(message, /生鲜-蔬菜/);
});

test('weekly trend aggregates business dimensions and compares an incomplete week by daily average', () => {
  const contract = buildQueryContract({
    indicatorId: '2',
    metrics: ['sale_amt'],
    dimensions: ['sdt', 'region'],
    dateInfo: {
      dateMode: 'BETWEEN',
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      dateField: 'sdt',
    },
    timeGrain: 'WEEK',
    limit: 200,
  });
  const summary = buildDeterministicSummary({
    subjectName: '含税销售金额',
    columns,
    rows: [
      { sdt: '2026-09-01', region: '华东', sale_amt: 100 },
      { sdt: '2026-09-01', region: '华南', sale_amt: 50 },
      { sdt: '2026-09-28', region: '华东', sale_amt: 60 },
      { sdt: '2026-09-28', region: '华南', sale_amt: 30 },
    ],
    contract,
    question: '2026年9月含税销售金额按周趋势',
  });

  assert.match(summary, /从 2026-09-01 的 150 变化到 2026-09-28 的 90/);
  assert.match(summary, /最后一周仅覆盖 2026-09-28 至 2026-09-30，共 3 天/);
  assert.match(summary, /按日均口径看/);
});

test('attribution summary ranks dimension changes for two aligned periods', () => {
  const contract = buildQueryContract({
    indicatorId: '2',
    metrics: ['sale_amt'],
    dimensions: ['region', '__period'],
    dateInfo: {
      dateMode: 'BETWEEN',
      startDate: '2026-09-01',
      endDate: '2026-09-21',
      dateField: 'sdt',
    },
    timeWindows: [
      {
        sourceText: '9月份',
        label: '9月份',
        expression: '9月份',
        startDate: '2026-09-01',
        endDate: '2026-09-21',
        dateField: 'sdt',
      },
      {
        sourceText: '9月份',
        label: '9月份对比期',
        expression: '9月份对比期',
        startDate: '2026-08-01',
        endDate: '2026-08-21',
        dateField: 'sdt',
      },
    ],
    calculation: {
      type: 'PERIOD_COMPARISON',
      baseWindowIndex: 0,
      compareWindowIndex: 1,
    },
    periodOrder: ['9月份', '9月份对比期'],
    analysisMode: 'ATTRIBUTION',
    attribution: {
      comparisonPolicy: 'PROMPT_FIRST_ALIGNED_PREVIOUS_PERIOD',
      requireBreakdown: true,
    },
  });
  const summary = buildDeterministicSummary({
    subjectName: '含税销售金额',
    columns: [
      ...columns,
      { name: '对比期间', bizName: '__period', showType: 'CATEGORY' },
    ],
    rows: [
      { region: '华东', sale_amt: 40, __period: '9月份' },
      { region: '华南', sale_amt: 60, __period: '9月份' },
      { region: '华东', sale_amt: 100, __period: '9月份对比期' },
      { region: '华南', sale_amt: 50, __period: '9月份对比期' },
    ],
    contract,
    question: '帮我分析9月份业绩上升还是下滑，然后输出具体原因',
  });

  assert.match(summary, /大区按含税销售金额的变动拆分/);
  assert.match(summary, /华东（-60，占整体变动 120\.0%）/);
  assert.match(summary, /华南（\+10，占整体变动 -20\.0%）/);
  // 平台不再自己选择归因方法，因此不出现"贡献 / 拉动"这类方法性措辞。
  assert.doesNotMatch(summary, /贡献/);
});

function attributionContract(dimensions) {
  return buildQueryContract({
    indicatorId: '2',
    metrics: ['sale_amt'],
    dimensions,
    calculation: {
      type: 'PERIOD_COMPARISON',
      baseWindowIndex: 0,
      compareWindowIndex: 1,
    },
    periodOrder: ['本期', '上期'],
    analysisMode: 'ATTRIBUTION',
  });
}

test('attribution movement reports every dimension instead of only the first', () => {
  const summary = buildDeterministicSummary({
    subjectName: '含税销售金额',
    columns: [
      { name: '大区', bizName: 'region', showType: 'CATEGORY' },
      { name: '渠道', bizName: 'channel', showType: 'CATEGORY' },
      { name: '含税销售金额', bizName: 'sale_amt', showType: 'NUMBER' },
      { name: '对比期间', bizName: '__period', showType: 'CATEGORY' },
    ],
    rows: [
      { region: '华东', channel: 'BBC', sale_amt: 100, __period: '本期' },
      { region: '华南', channel: '商超', sale_amt: 60, __period: '本期' },
      { region: '华东', channel: 'BBC', sale_amt: 40, __period: '上期' },
      { region: '华南', channel: '商超', sale_amt: 90, __period: '上期' },
    ],
    contract: attributionContract(['region', 'channel', '__period']),
    question: '本期销售额下滑的原因是什么',
  });

  assert.match(summary, /大区按含税销售金额的变动拆分/);
  assert.match(summary, /渠道按含税销售金额的变动拆分/);
});

test('attribution movement closes the share sum with an other bucket', () => {
  const base = [
    ['A', 10], ['B', 20], ['C', 30], ['D', 40], ['E', 55], ['F', 58], ['G', 73],
  ];
  const current = [
    ['A', 100], ['B', 90], ['C', 80], ['D', 70], ['E', 60], ['F', 50], ['G', 40],
  ];
  const summary = buildDeterministicSummary({
    subjectName: '含税销售金额',
    columns: [
      { name: '大区', bizName: 'region', showType: 'CATEGORY' },
      { name: '含税销售金额', bizName: 'sale_amt', showType: 'NUMBER' },
      { name: '对比期间', bizName: '__period', showType: 'CATEGORY' },
    ],
    rows: [
      ...current.map(([region, value]) => ({ region, sale_amt: value, __period: '本期' })),
      ...base.map(([region, value]) => ({ region, sale_amt: value, __period: '上期' })),
    ],
    contract: attributionContract(['region', '__period']),
    question: '本期销售额变化的构成',
  });

  // 前 5 之外的 2 个维度取值合并为"其他"，占比之和才闭合。
  assert.match(summary, /其他 2 个大区（-3，占整体变动 -1\.5%）/);
  assert.match(summary, /A（\+90，占整体变动 44\.1%）/);
});

function attributionAnalysis(overrides = {}) {
  return {
    version: 1,
    kind: 'ATTRIBUTION',
    metric: { label: '含税销售金额', unit: '元', isRate: false },
    periods: { current: '本期', previous: '上期' },
    totals: { base: 150, current: 100, delta: -50 },
    rows: [
      {
        key: '华东', label: '华东', base: 100, current: 40,
        delta: -60, contribution: -60, share: 1.2, direction: 'DECREASE',
      },
      {
        key: '华南', label: '华南', base: 50, current: 60,
        delta: 10, contribution: 10, share: -0.2, direction: 'INCREASE',
      },
    ],
    claims: [{ code: 'ADDITIVE' }, { code: 'SHARE_SUM' }, { code: 'DELTA_CONSISTENT' }],
    ...overrides,
  };
}

test('validated sandbox analysis takes over the platform movement breakdown', () => {
  const summary = buildDeterministicSummary({
    subjectName: '含税销售金额',
    columns: [
      { name: '大区', bizName: 'region', showType: 'CATEGORY' },
      { name: '含税销售金额', bizName: 'sale_amt', showType: 'NUMBER' },
      { name: '对比期间', bizName: '__period', showType: 'CATEGORY' },
    ],
    rows: [
      { region: '华东', sale_amt: 40, __period: '本期' },
      { region: '华南', sale_amt: 60, __period: '本期' },
      { region: '华东', sale_amt: 100, __period: '上期' },
      { region: '华南', sale_amt: 50, __period: '上期' },
    ],
    contract: attributionContract(['region', '__period']),
    question: '本期销售额下滑的原因',
    analysis: attributionAnalysis(),
  });

  assert.match(summary, /分析类型：ATTRIBUTION/);
  assert.match(summary, /华东：变化 -60/);
  // 有可校验的代码产物时，平台不再自己拆一遍。
  assert.doesNotMatch(summary, /变动拆分/);
});

test('invalid sandbox analysis is dropped instead of being replaced by a platform guess', () => {
  const summary = buildDeterministicSummary({
    subjectName: '含税销售金额',
    columns: [
      { name: '大区', bizName: 'region', showType: 'CATEGORY' },
      { name: '含税销售金额', bizName: 'sale_amt', showType: 'NUMBER' },
      { name: '对比期间', bizName: '__period', showType: 'CATEGORY' },
    ],
    rows: [
      { region: '华东', sale_amt: 40, __period: '本期' },
      { region: '华南', sale_amt: 60, __period: '本期' },
      { region: '华东', sale_amt: 100, __period: '上期' },
      { region: '华南', sale_amt: 50, __period: '上期' },
    ],
    contract: attributionContract(['region', '__period']),
    question: '本期销售额下滑的原因',
    analysis: attributionAnalysis({
      rows: [
        {
          key: '华东', label: '华东', base: 100, current: 40,
          delta: -60, contribution: -60, share: 0.5, direction: 'DECREASE',
        },
        {
          key: '华南', label: '华南', base: 50, current: 60,
          delta: 10, contribution: 10, share: 0.2, direction: 'INCREASE',
        },
      ],
    }),
  });

  // 份额不归一 → 契约校验失败 → 平台丢弃该产物，回落到确定性事实。
  assert.doesNotMatch(summary, /分析类型：ATTRIBUTION/);
  assert.match(summary, /大区按含税销售金额的变动拆分/);
});

test('period comparison summary leads with growth rate and top increasing dimensions', () => {
  const contract = buildQueryContract({
    indicatorId: '2',
    metrics: ['sale_amt'],
    dimensions: ['province', '__period'],
    timeWindows: [
      {
        label: '2026年9月',
        expression: '2026年9月',
        startDate: '2026-09-01',
        endDate: '2026-09-30',
      },
      {
        label: '2025年9月',
        expression: '2025年9月',
        startDate: '2025-09-01',
        endDate: '2025-09-30',
      },
    ],
    periodOrder: ['2026年9月', '2025年9月'],
    limit: 200,
  });
  const summary = buildDeterministicSummary({
    subjectName: '含税销售金额',
    columns: [
      { name: '省区', bizName: 'province', showType: 'CATEGORY' },
      { name: '含税销售金额', bizName: 'sale_amt', showType: 'NUMBER' },
      { name: '对比期间', bizName: '__period', showType: 'CATEGORY' },
    ],
    rows: [
      { province: '广东', sale_amt: 300, __period: '2026年9月' },
      { province: '江苏', sale_amt: 200, __period: '2026年9月' },
      { province: '浙江', sale_amt: 100, __period: '2026年9月' },
      { province: '广东', sale_amt: 100, __period: '2025年9月' },
      { province: '江苏', sale_amt: 250, __period: '2025年9月' },
      { province: '浙江', sale_amt: 120, __period: '2025年9月' },
    ],
    contract,
    question: '2026年9月BBC含税销售额对比2025年9月，同比涨了多少，主要是哪些省区增长比较多',
  });

  assert.match(summary, /同比增长 \+27\.7%/);
  assert.match(summary, /增加 130/);
  assert.match(summary, /2026年9月含税销售金额为 600，较2025年9月增加 130/);
  assert.match(summary, /同比增长 \+27\.7%/);
  assert.match(summary, /上期 470/);
  assert.match(summary, /省区里增长最多的是/);
  assert.match(summary, /广东（\+200）/);
  assert.match(summary, /江苏（-50）/);
  assert.match(summary, /浙江（-20）/);
  assert.doesNotMatch(summary, /查询范围/);

  const scope = buildQueryScopeSummary({
    subjectName: '含税销售金额',
    columns: [
      { name: '省区', bizName: 'province', showType: 'CATEGORY' },
      { name: '含税销售金额', bizName: 'sale_amt', showType: 'NUMBER' },
      { name: '对比期间', bizName: '__period', showType: 'CATEGORY' },
    ],
    contract,
  });
  assert.match(scope, /时间：2026年9月 vs 2025年9月/);
  assert.match(scope, /维度：省区/);
});

test('empty results explicitly report that the platform did not move the range', () => {
  const contract = buildQueryContract({
    indicatorId: '2',
    metrics: ['sale_amt'],
    dimensions: ['sdt'],
    dateInfo: {
      dateMode: 'BETWEEN',
      startDate: '2026-09-15',
      endDate: '2026-09-21',
      dateField: 'sdt',
    },
  });
  const summary = buildDeterministicSummary({
    subjectName: '含税销售金额',
    columns,
    rows: [],
    contract,
    question: '查询最近7天含税销售金额',
  });

  assert.match(summary, /未返回数据/);
  assert.match(summary, /没有自动调整时间范围/);
  assert.doesNotMatch(summary, /2026-09-15 至 2026-09-21/);
});

test('composition summaries prefer the derived share instead of repeating base amounts', () => {
  const contract = buildQueryContract({
    indicatorId: 'dataset:2',
    metrics: ['sale_amt'],
    dimensions: ['business_type_name'],
    derivedMetrics: [{
      name: '业绩占比',
      type: 'SHARE_OF_TOTAL',
      outputField: 'sale_amt_share',
      outputFormat: 'PERCENT',
      left: { field: 'sale_amt' },
    }],
    analysisGoals: [{
      id: 'composition',
      type: 'COMPOSITION',
      measure: 'sale_amt',
      groupBy: ['business_type_name'],
      outputField: 'sale_amt_share',
      conditionIds: [],
    }],
  });
  const summary = buildDeterministicSummary({
    subjectName: '销售明细',
    question: '上个月各业务类型的业绩占比是多少',
    contract,
    columns: [
      { name: '业务类型', bizName: 'business_type_name', showType: 'CATEGORY' },
      { name: '含税销售额', bizName: 'sale_amt', showType: 'NUMBER' },
      { name: '业绩占比', bizName: 'sale_amt_share', showType: 'NUMBER', dataFormatType: 'percent' },
    ],
    rows: [
      { business_type_name: '日配到家', sale_amt: 337270.48, sale_amt_share: 0.36593 },
      { business_type_name: '社区团购', sale_amt: 280335.66, sale_amt_share: 0.304157 },
      { business_type_name: '机构直供', sale_amt: 207101.35, sale_amt_share: 0.2247 },
      { business_type_name: '商超直供', sale_amt: 96972.26, sale_amt_share: 0.105213 },
    ],
  });

  assert.match(summary, /日配到家.*36\.59%/);
  assert.match(summary, /社区团购.*30\.42%/);
  assert.match(summary, /机构直供.*22\.47%/);
  assert.match(summary, /商超直供.*10\.52%/);
  assert.doesNotMatch(summary, /337,270/);
});

test('public result projection hides formula dependency fields', () => {
  const result = selectPublicResult({
    columns: [
      { name: '省区', bizName: 'province', showType: 'CATEGORY' },
      { name: '销售额', bizName: 'sale_amt', showType: 'NUMBER' },
      { name: '成本', bizName: 'sale_cost', showType: 'NUMBER' },
      { name: '毛利率', bizName: 'margin', showType: 'NUMBER' },
    ],
    rows: [{
      province: '华东',
      sale_amt: 100,
      sale_cost: 80,
      margin: 0.2,
    }],
    internalMetrics: ['sale_amt', 'sale_cost'],
  });
  assert.deepEqual(
    result.columns.map((column) => column.bizName),
    ['province', 'margin'],
  );
  assert.deepEqual(result.rows[0], { province: '华东', margin: 0.2 });
});
