import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDeterministicSummary,
  buildQueryContract,
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

test('deterministic summary contains the locked range and aggregate result', () => {
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

  assert.match(summary, /含税销售金额合计 30/);
  assert.match(summary, /2026-09-01 至 2026-09-02/);
  assert.match(summary, /大区/);
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
  assert.match(summary, /2026-01：100/);
  assert.match(summary, /2026-09：20/);
  assert.doesNotMatch(summary, /2026-01-01：100/);
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

  assert.match(summary, /华东.*变化 -60.*贡献 120\.0%/);
  assert.match(summary, /华南.*变化 \+10.*贡献 -20\.0%/);
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
  assert.match(summary, /2026-09-15 至 2026-09-21/);
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
