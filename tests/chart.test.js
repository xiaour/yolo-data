import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestChart, toEChartsOption } from '../src/chart.js';

const columns = [
  { name: '日期', bizName: 'date', showType: 'CATEGORY', type: 'STRING' },
  { name: '销售额', bizName: 'sales_amount', showType: 'NUMBER', type: 'DECIMAL' },
];

test('time dimensions are rendered as a line chart', () => {
  const rows = [
    { date: '2026-09-18', sales_amount: 100 },
    { date: '2026-09-19', sales_amount: 120 },
    { date: '2026-09-20', sales_amount: 140 },
  ];
  const chart = suggestChart({ columns, rows, question: '近7天销售额趋势' });
  assert.equal(chart.type, 'line');
  const option = toEChartsOption(chart, columns, rows);
  assert.equal(option.series[0].type, 'line');
  assert.deepEqual(option.xAxis.data, ['2026-09-18', '2026-09-19', '2026-09-20']);
});

test('composition questions use pie charts for a small category count', () => {
  const chart = suggestChart({
    columns: [
      { name: '渠道', bizName: 'channel', showType: 'CATEGORY', type: 'STRING' },
      columns[1],
    ],
    rows: [
      { channel: '线上', sales_amount: 100 },
      { channel: '门店', sales_amount: 80 },
    ],
    question: '线上和门店销售额占比',
  });
  assert.equal(chart.type, 'pie');
});

test('time plus channel dimensions become one series per channel', () => {
  const multiColumns = [
    { name: '日期', bizName: 'date', showType: 'CATEGORY', type: 'STRING' },
    { name: '渠道', bizName: 'channel', showType: 'CATEGORY', type: 'STRING' },
    { name: '销售额', bizName: 'sales_amount', showType: 'NUMBER', type: 'DECIMAL' },
  ];
  const rows = [
    { date: '2026-09-19', channel: '线上', sales_amount: 100 },
    { date: '2026-09-19', channel: '门店', sales_amount: 80 },
    { date: '2026-09-20', channel: '线上', sales_amount: 120 },
    { date: '2026-09-20', channel: '门店', sales_amount: 90 },
  ];
  const chart = suggestChart({
    columns: multiColumns,
    rows,
    question: '近7天华东销售额趋势，那按渠道拆开呢',
  });
  assert.equal(chart.type, 'line');
  assert.equal(chart.seriesField, 'channel');
  const option = toEChartsOption(chart, multiColumns, rows);
  assert.deepEqual(option.series.map((item) => item.name), ['线上', '门店']);
  assert.deepEqual(option.xAxis.data, ['2026-09-19', '2026-09-20']);
});
