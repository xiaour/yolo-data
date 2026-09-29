import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDerivedMetricFilters,
  applyDerivedMetrics,
  normalizeDerivedMetrics,
} from '../src/derivedMetrics.js';

test('derived metric compiler resolves structured ratio and growth formulas', () => {
  const definitions = normalizeDerivedMetrics([
    {
      name: '未税毛利率',
      type: 'RATIO',
      numerator: '未税毛利额',
      denominator: '未税销售额',
      outputField: 'untaxed_gross_margin',
      outputFormat: 'PERCENT',
      precision: 6,
    },
    {
      name: '收入同比增长率',
      type: 'GROWTH_RATE',
      left: { field: '含税销售额', aggregator: 'SUM' },
      right: { field: '去年同期销售额', aggregator: 'SUM' },
      outputField: 'revenue_yoy',
      outputFormat: 'PERCENT',
    },
  ], (field) => ({
    未税毛利额: 'profit_no_tax',
    未税销售额: 'sale_amt_no_tax',
    含税销售额: 'sale_amt',
    去年同期销售额: 'sale_amt_previous',
  })[field] ?? null);

  assert.equal(definitions.length, 2);
  assert.equal(definitions[0].left.field, 'profit_no_tax');
  assert.equal(definitions[0].right.field, 'sale_amt_no_tax');
  assert.equal(definitions[1].type, 'GROWTH_RATE');
});

test('derived metric renderer computes columns without changing raw values', () => {
  const definitions = normalizeDerivedMetrics([
    {
      name: '未税毛利率',
      type: 'RATIO',
      numerator: 'profit_no_tax',
      denominator: 'sale_amt_no_tax',
      outputField: 'untaxed_gross_margin',
      outputFormat: 'PERCENT',
      precision: 6,
    },
  ], (field) => field);
  const originalRows = [{
    region: '华东',
    profit_no_tax: 8.4,
    sale_amt_no_tax: 100,
  }];
  const result = applyDerivedMetrics({
    columns: [
      { name: '区域', bizName: 'region', showType: 'CATEGORY' },
      { name: '未税毛利额', bizName: 'profit_no_tax', showType: 'NUMBER' },
      { name: '未税销售额', bizName: 'sale_amt_no_tax', showType: 'NUMBER' },
    ],
    rows: originalRows,
    definitions,
  });

  assert.equal(result.rows[0].untaxed_gross_margin, 0.084);
  assert.equal(originalRows[0].untaxed_gross_margin, undefined);
  assert.equal(result.columns.at(-1).name, '未税毛利率');
  assert.equal(result.columns.at(-1).dataFormatType, 'percent');
});

test('derived metric filters run after derived values are calculated', () => {
  const rows = applyDerivedMetricFilters({
    rows: [
      { customer_code: 'A', gross_margin: 0.08 },
      { customer_code: 'B', gross_margin: 0.03 },
    ],
    filters: [{
      field: 'gross_margin',
      operator: '<',
      value: 0.05,
    }],
    derivedFields: ['gross_margin'],
  });

  assert.deepEqual(rows, [
    { customer_code: 'B', gross_margin: 0.03 },
  ]);
});

test('expression derived metrics support generic arithmetic trees', () => {
  const definitions = normalizeDerivedMetrics([
    {
      name: '毛利率',
      type: 'EXPRESSION',
      outputField: 'gross_margin',
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
  ], (field) => field);
  const result = applyDerivedMetrics({
    columns: [
      { name: '含税销售额', bizName: 'sale_amt', showType: 'NUMBER' },
      { name: '含税销售成本', bizName: 'sale_cost', showType: 'NUMBER' },
    ],
    rows: [{ sale_amt: 100, sale_cost: 80 }],
    definitions,
  });

  assert.equal(result.rows[0].gross_margin, 0.2);
  assert.deepEqual(
    definitions[0].operands.map((operand) => operand.field).sort(),
    ['sale_amt', 'sale_amt', 'sale_cost'],
  );
});
