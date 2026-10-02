import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeProfileSelection,
  profileDataset,
} from '../src/datasetProfiler.js';

const FIELDS = [
  { fieldName: 'order_date', semanticType: 'DATE', dataType: 'date', role: 'DIMENSION', aggregator: 'NONE' },
  { fieldName: 'region', semanticType: 'STRING', dataType: 'varchar(20)', role: 'DIMENSION', aggregator: 'NONE' },
  { fieldName: 'sale_amt', semanticType: 'NUMBER', dataType: 'decimal(12,2)', role: 'DIMENSION', aggregator: 'NONE' },
  { fieldName: 'refund_rate', semanticType: 'NUMBER', dataType: 'decimal(6,4)', role: 'DIMENSION', aggregator: 'NONE' },
  { fieldName: 'order_count', semanticType: 'NUMBER', dataType: 'int', role: 'DIMENSION', aggregator: 'NONE' },
  { fieldName: 'product_id', semanticType: 'STRING', dataType: 'varchar(32)', role: 'DIMENSION', aggregator: 'NONE' },
  { fieldName: 'is_new_customer', semanticType: 'NUMBER', dataType: 'tinyint', role: 'METRIC', aggregator: 'SUM' },
];

const ROWS = [
  { order_date: '2026-09-01', region: '华东', sale_amt: 1200.5, refund_rate: 0.01, order_count: 12, product_id: 'P-1001', is_new_customer: 1 },
  { order_date: '2026-09-02', region: '华南', sale_amt: 980.25, refund_rate: 0.02, order_count: 9, product_id: 'P-1002', is_new_customer: 0 },
  { order_date: '2026-09-03', region: '华东', sale_amt: 1530.75, refund_rate: 0.015, order_count: 15, product_id: 'P-1003', is_new_customer: 1 },
  { order_date: '2026-09-04', region: '华北', sale_amt: 720.4, refund_rate: 0.008, order_count: 7, product_id: 'P-1004', is_new_customer: 0 },
  { order_date: '2026-09-05', region: '西南', sale_amt: 1880.9, refund_rate: 0.021, order_count: 18, product_id: 'P-1005', is_new_customer: 1 },
  { order_date: '2026-09-06', region: '华东', sale_amt: 640.1, refund_rate: 0.011, order_count: 6, product_id: 'P-1006', is_new_customer: 0 },
  { order_date: '2026-09-07', region: '华南', sale_amt: 1120.0, refund_rate: 0.018, order_count: 11, product_id: 'P-1007', is_new_customer: 1 },
  { order_date: '2026-09-08', region: '华北', sale_amt: 2050.6, refund_rate: 0.024, order_count: 21, product_id: 'P-1008', is_new_customer: 0 },
];

function proposalFor(profile, fieldName) {
  return profile.fields.find((item) => item.fieldName === fieldName);
}

test('dataset profiler detects the time field and data-driven roles', () => {
  const profile = profileDataset({ datasetId: 7, fields: FIELDS, rows: ROWS });
  assert.equal(profile.datasetId, 7);
  assert.equal(profile.sampleSize, ROWS.length);

  assert.equal(proposalFor(profile, 'order_date').suggestedRole, 'TIME');
  assert.equal(proposalFor(profile, 'region').suggestedRole, 'DIMENSION');
  assert.equal(proposalFor(profile, 'sale_amt').suggestedRole, 'METRIC');
  assert.equal(proposalFor(profile, 'refund_rate').suggestedRole, 'METRIC');
  assert.equal(proposalFor(profile, 'order_count').suggestedRole, 'METRIC');
  assert.equal(proposalFor(profile, 'product_id').suggestedRole, 'IDENTIFIER');
  // 0/1 标志位不应被当成可加度量。
  assert.equal(proposalFor(profile, 'is_new_customer').suggestedRole, 'DIMENSION');

  assert.equal(profile.summary.timeFieldCount, 1);
  assert.equal(profile.summary.metricCount, 3);
  // 名称型启发式默认会把 metric 判成 DIMENSION，这里应被数据特征纠正。
  assert.ok(profile.summary.changedCount >= 4);
});

test('dataset profiler suggests aggregators that match the metric shape', () => {
  const profile = profileDataset({ datasetId: 7, fields: FIELDS, rows: ROWS });
  assert.equal(proposalFor(profile, 'sale_amt').suggestedAggregator, 'SUM');
  assert.equal(proposalFor(profile, 'refund_rate').suggestedAggregator, 'AVG');
  assert.equal(proposalFor(profile, 'order_count').suggestedAggregator, 'SUM');
  assert.equal(proposalFor(profile, 'is_new_customer').suggestedAggregator, 'NONE');
  assert.equal(proposalFor(profile, 'region').suggestedAggregator, 'NONE');
});

test('dataset profiler derives the default time window from real MIN/MAX ranges', () => {
  const longSpan = profileDataset({
    datasetId: 7,
    fields: FIELDS,
    rows: ROWS,
    ranges: { order_date: { min: '2022-01-01', max: '2026-09-08' } },
  });
  assert.equal(longSpan.timeCondition.field, 'order_date');
  assert.equal(longSpan.timeCondition.autoLatestDateRange, true);
  assert.equal(longSpan.timeCondition.autoRangeDays, 90);
  assert.equal(longSpan.timeCondition.spanDays, 1712);

  const shortSpan = profileDataset({
    datasetId: 7,
    fields: FIELDS,
    rows: ROWS,
    ranges: { order_date: { min: '2026-09-01', max: '2026-09-08' } },
  });
  assert.equal(shortSpan.timeCondition.autoRangeDays, 8);

  const noRange = profileDataset({ datasetId: 7, fields: FIELDS, rows: ROWS });
  assert.equal(noRange.timeCondition.autoRangeDays, 30);
});

test('dataset profiler reports null when no time field can be found', () => {
  const profile = profileDataset({
    datasetId: 9,
    fields: [
      { fieldName: 'region', semanticType: 'STRING', role: 'DIMENSION' },
      { fieldName: 'sale_amt', semanticType: 'NUMBER', role: 'METRIC', aggregator: 'SUM' },
    ],
    rows: [{ region: '华东', sale_amt: 10 }, { region: '华南', sale_amt: 20 }],
  });
  assert.equal(profile.timeCondition, null);
  assert.equal(profile.summary.timeFieldCount, 0);
});

test('dataset profiler degrades to field name and type without a sample', () => {
  const profile = profileDataset({
    datasetId: 11,
    fields: [
      { fieldName: 'biz_date', semanticType: 'DATE', dataType: 'date', role: 'DIMENSION', aggregator: 'NONE' },
      { fieldName: 'sale_amt', semanticType: 'NUMBER', dataType: 'decimal(12,2)', role: 'DIMENSION', aggregator: 'NONE' },
      { fieldName: 'order_count', semanticType: 'NUMBER', dataType: 'int', role: 'DIMENSION', aggregator: 'NONE' },
      { fieldName: 'region', semanticType: 'STRING', dataType: 'varchar(20)', role: 'DIMENSION', aggregator: 'NONE' },
    ],
    rows: [],
    options: { degraded: '未能读取样本数据' },
  });
  assert.equal(profile.degraded, true);
  assert.equal(profile.degradedReason, '未能读取样本数据');
  assert.equal(profile.sampleSize, 0);
  assert.equal(proposalFor(profile, 'biz_date').suggestedRole, 'TIME');
  assert.equal(proposalFor(profile, 'sale_amt').suggestedRole, 'METRIC');
  assert.equal(proposalFor(profile, 'order_count').suggestedRole, 'METRIC');
  assert.equal(proposalFor(profile, 'region').suggestedRole, 'DIMENSION');
  // With no MIN/MAX range the window falls back to the conservative default.
  assert.equal(profile.timeCondition.field, 'biz_date');
  assert.equal(profile.timeCondition.autoRangeDays, 30);
});

test('a non-degraded profile reports degraded=false', () => {
  const profile = profileDataset({ datasetId: 12, fields: FIELDS, rows: ROWS });
  assert.equal(profile.degraded, false);
  assert.equal(profile.degradedReason, null);
});

test('profile selection is validated before it is persisted', () => {
  const ok = normalizeProfileSelection({
    fields: [
      { fieldName: 'sale_amt', role: 'metric', aggregator: 'sum' },
      { fieldName: 'region', role: 'DIMENSION' },
    ],
    config: { autoLatestDateRange: true, autoRangeDays: 14 },
  });
  assert.deepEqual(ok.fields, [
    { fieldName: 'sale_amt', role: 'METRIC', aggregator: 'SUM' },
    { fieldName: 'region', role: 'DIMENSION', aggregator: 'NONE' },
  ]);
  assert.deepEqual(ok.config, { autoLatestDateRange: true, autoRangeDays: 14 });

  assert.throws(
    () => normalizeProfileSelection({ fields: [{ fieldName: 'x', role: 'NOPE', aggregator: 'SUM' }] }),
    /unsupported field role/,
  );
  assert.throws(
    () => normalizeProfileSelection({ fields: [{ fieldName: 'x', role: 'DIMENSION', aggregator: 'SUM' }] }),
    /only METRIC fields can have an aggregator/,
  );
  assert.throws(
    () => normalizeProfileSelection({ fields: [], config: { autoRangeDays: 0 } }),
    /autoRangeDays must be between/,
  );
});
