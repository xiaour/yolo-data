import assert from 'node:assert/strict';
import test from 'node:test';
import { applyResultPostProcessing } from '../src/resultProcessing.js';

test('result post-processing groups values, compares periods and pivots totals', () => {
  const columns = [
    {
      name: 'sales_region_name',
      bizName: 'performance_province_name',
      showType: 'CATEGORY',
      type: 'STRING',
    },
    {
      name: 'industry_name',
      bizName: 'first_category_name',
      showType: 'CATEGORY',
      type: 'STRING',
    },
    {
      name: '含税销售额',
      bizName: 'sale_amt',
      showType: 'NUMBER',
      type: 'DECIMAL',
    },
    {
      name: '对比期间',
      bizName: '__period',
      showType: 'CATEGORY',
      type: 'STRING',
    },
  ];
  const result = applyResultPostProcessing({
    columns,
    periodOrder: ['2026年8月', '2025年8月'],
    postProcessing: {
      groupValues: {
        field: 'first_category_name',
        outputField: 'industry_group',
        groups: [
          { name: 'Government', values: ['Government'] },
          { name: 'UtilitiesFinance', values: ['Utilities', 'Finance'] },
          { name: 'IndustrialTransport', values: ['Manufacturing', 'RealEstate', 'Logistics'] },
        ],
        defaultValue: '其他',
      },
      periodComparison: {
        metric: 'sale_amt',
        outputField: 'sale_amt_yoy',
        type: 'RATE',
      },
      pivot: {
        rowFields: ['performance_province_name'],
        columnField: 'industry_group',
        valueFields: [
          { field: 'sale_amt', label: '含税销售额' },
          { field: 'sale_amt_yoy', label: '同比' },
        ],
        includeTotal: true,
        totalLabel: '合计',
      },
    },
    rows: [
      {
        performance_province_name: '上海',
        first_category_name: 'Government',
        sale_amt: 100,
        __period: '2026年8月',
      },
      {
        performance_province_name: '上海',
        first_category_name: 'Government',
        sale_amt: 80,
        __period: '2025年8月',
      },
      {
        performance_province_name: '上海',
        first_category_name: 'Finance',
        sale_amt: 50,
        __period: '2026年8月',
      },
      {
        performance_province_name: '上海',
        first_category_name: 'Finance',
        sale_amt: 100,
        __period: '2025年8月',
      },
      {
        performance_province_name: '上海',
        first_category_name: 'Education',
        sale_amt: 30,
        __period: '2026年8月',
      },
      {
        performance_province_name: '上海',
        first_category_name: 'Education',
        sale_amt: 20,
        __period: '2025年8月',
      },
    ],
  });

  const row = result.rows[0];
  assert.equal(row['Government__sale_amt'], 100);
  assert.equal(row['Government__sale_amt_yoy'], 0.25);
  assert.equal(row['UtilitiesFinance__sale_amt'], 50);
  assert.equal(row['UtilitiesFinance__sale_amt_yoy'], -0.5);
  assert.equal(row['其他__sale_amt'], 30);
  assert.equal(row['合计__sale_amt'], 180);
  assert.equal(row['合计__sale_amt_yoy'], -0.1);
  assert.equal(result.columns.find((item) => item.bizName === 'Government__sale_amt').parentName, 'Government');
  assert.equal(result.columns.find((item) => item.bizName === '合计__sale_amt').childName, '含税销售额');
});
