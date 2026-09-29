import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAnalysisPipeline,
  normalizeAnalysisPipeline,
} from '../src/analysisPipeline.js';

const sourceColumns = [
  { name: 'customer_code', bizName: 'customer_code', showType: 'CATEGORY', type: 'STRING' },
  { name: '账期', bizName: 'stat_month', showType: 'CATEGORY', type: 'STRING' },
  { name: '销售额', bizName: 'sale_amt', showType: 'NUMBER', type: 'DECIMAL' },
  { name: '销售成本', bizName: 'sale_cost', showType: 'NUMBER', type: 'DECIMAL' },
];

const sourceRows = [
  { customer_code: 'A', stat_month: '2026-05', sale_amt: 40, sale_cost: 39 },
  { customer_code: 'A', stat_month: '2026-06', sale_amt: 40, sale_cost: 39 },
  { customer_code: 'A', stat_month: '2026-07', sale_amt: 40, sale_cost: 39 },
  { customer_code: 'A', stat_month: '2026-08', sale_amt: 40, sale_cost: 39 },
  { customer_code: 'B', stat_month: '2026-05', sale_amt: 50, sale_cost: 38 },
  { customer_code: 'B', stat_month: '2026-06', sale_amt: 50, sale_cost: 38 },
  { customer_code: 'B', stat_month: '2026-07', sale_amt: 50, sale_cost: 38 },
  { customer_code: 'B', stat_month: '2026-08', sale_amt: 50, sale_cost: 38 },
];

test('analysis pipeline stays inert when no stages are supplied', () => {
  const rows = [{ value: 3 }];
  const result = applyAnalysisPipeline({
    columns: [{ name: '数值', bizName: 'value', showType: 'NUMBER' }],
    rows,
  });

  assert.deepEqual(result.rows, rows);
  assert.equal(result.columns.length, 1);
  assert.equal(normalizeAnalysisPipeline(null), null);
  assert.equal(normalizeAnalysisPipeline({ stages: [] }), null);
});

test('analysis pipeline computes per-row derived values and qualification counts', () => {
  const pipeline = normalizeAnalysisPipeline({
    version: 1,
    stages: [
      {
        id: 'derive-margin',
        type: 'DERIVE',
        definitions: [{
          name: '毛利率',
          type: 'EXPRESSION',
          outputField: 'gross_margin',
          outputFormat: 'PERCENT',
          expression: {
            op: 'DIVIDE',
            left: {
              op: 'SUBTRACT',
              left: { field: 'sale_amt' },
              right: { field: 'sale_cost' },
            },
            right: {
              op: 'ABS',
              value: { field: 'sale_amt' },
            },
          },
        }],
      },
      {
        id: 'qualify',
        type: 'ROLLUP',
        groupBy: ['customer_code'],
        outputs: [
          {
            type: 'COUNT_IF',
            outputField: 'qualified_months',
            predicate: {
              mode: 'ALL',
              conditions: [
                { field: 'sale_amt', operator: '>', value: 30 },
                { field: 'gross_margin', operator: '<', value: 0.05 },
              ],
            },
          },
          {
            type: 'CONDITIONAL_AGGREGATE',
            outputField: 'august_sales',
            metric: 'sale_amt',
            aggregator: 'SUM',
            predicate: {
              mode: 'ALL',
              conditions: [
                { field: 'stat_month', operator: '=', value: '2026-08' },
              ],
            },
          },
        ],
      },
      {
        id: 'require-four-months',
        type: 'FILTER',
        predicate: {
          mode: 'ALL',
          conditions: [
            { field: 'qualified_months', operator: '=', value: 4 },
          ],
        },
      },
      {
        id: 'rank',
        type: 'SORT',
        order: [
          { field: 'qualified_months', direction: 'DESC' },
          { field: 'august_sales', direction: 'DESC' },
        ],
      },
      { id: 'top', type: 'LIMIT', value: 10 },
      {
        id: 'project',
        type: 'SELECT_COLUMNS',
        fields: ['customer_code', 'qualified_months', 'august_sales'],
      },
    ],
  });

  const result = applyAnalysisPipeline({
    columns: sourceColumns,
    rows: sourceRows,
    pipeline,
  });

  assert.deepEqual(
    result.columns.map((column) => column.bizName),
    ['customer_code', 'qualified_months', 'august_sales'],
  );
  assert.deepEqual(result.rows, [{
    customer_code: 'A',
    qualified_months: 4,
    august_sales: 40,
  }]);
});

test('bucket field and multi-key sort are generic deterministic stages', () => {
  const pipeline = normalizeAnalysisPipeline({
    stages: [
      {
        type: 'BUCKET_FIELD',
        sourceField: 'sale_date',
        outputField: 'sale_month',
        period: 'MONTH',
      },
      {
        type: 'SORT',
        order: [
          { field: 'sale_month', direction: 'ASC' },
          { field: 'amount', direction: 'DESC' },
        ],
      },
    ],
  });
  const result = applyAnalysisPipeline({
    columns: [
      { name: '日期', bizName: 'sale_date', showType: 'CATEGORY', type: 'STRING' },
      { name: '金额', bizName: 'amount', showType: 'NUMBER', type: 'DECIMAL' },
    ],
    rows: [
      { sale_date: '2026-05-03', amount: 20 },
      { sale_date: '2026-06-01', amount: 30 },
      { sale_date: '2026-05-04', amount: 40 },
    ],
    pipeline,
  });

  assert.deepEqual(
    result.rows.map((row) => [row.sale_month, row.amount]),
    [['2026-05', 40], ['2026-05', 20], ['2026-06', 30]],
  );
});

test('bucket predicates normalize full-date bounds to the generated grain', () => {
  const pipeline = normalizeAnalysisPipeline({
    stages: [
      {
        type: 'BUCKET_FIELD',
        sourceField: 'sale_date',
        outputField: 'sale_month',
        period: 'MONTH',
      },
      {
        type: 'FILTER',
        predicate: {
          mode: 'ALL',
          conditions: [{
            field: 'sale_month',
            operator: 'BETWEEN',
            value: ['2026-08-01', '2026-08-31'],
          }],
        },
      },
    ],
  });
  const result = applyAnalysisPipeline({
    columns: [{
      name: '日期',
      bizName: 'sale_date',
      showType: 'CATEGORY',
      type: 'STRING',
    }],
    rows: [
      { sale_date: '2026-07-31' },
      { sale_date: '2026-08-15' },
      { sale_date: '2026-09-01' },
    ],
    pipeline,
  });

  assert.deepEqual(result.rows, [{
    sale_date: '2026-08-15',
    sale_month: '2026-08',
  }]);
});
