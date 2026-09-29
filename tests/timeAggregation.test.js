import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateRowsByTimeGrain } from '../src/timeAggregation.js';
import { inferTimeGrain } from '../src/queryIntent.js';

test('weekly grouping language is parsed as a structured time grain', () => {
  assert.equal(
    inferTimeGrain('本月重点客户组业务的销售额，按照每周分组'),
    'WEEK',
  );
  assert.equal(
    inferTimeGrain('最近90天销售额，按月分组'),
    'MONTH',
  );
  assert.equal(
    inferTimeGrain('最近7天每天的销售额'),
    'DAY',
  );
});

test('daily metric rows are aggregated into Monday-based weekly buckets', () => {
  const result = aggregateRowsByTimeGrain({
    columns: [
      { name: '销售日期', bizName: 'sdt', showType: 'DATE' },
      { name: '含税销售金额', bizName: 'sale_amt', showType: 'NUMBER' },
    ],
    rows: [
      { sdt: '2026-09-01', sale_amt: 10 },
      { sdt: '2026-09-06', sale_amt: 20 },
      { sdt: '2026-09-07', sale_amt: 30 },
      { sdt: '2026-09-08', sale_amt: 40 },
    ],
    dateKey: 'sdt',
    grain: 'WEEK',
  });

  assert.equal(result.columns[0].name, '周起始日');
  assert.deepEqual(result.rows, [
    { sdt: '2026-08-31', sale_amt: 30 },
    { sdt: '2026-09-07', sale_amt: 70 },
  ]);
});
