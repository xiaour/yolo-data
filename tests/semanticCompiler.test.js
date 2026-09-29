import assert from 'node:assert/strict';
import test from 'node:test';
import { SemanticCompiler } from '../src/semanticCompiler.js';

const indicator = {
  id: 'sales_amount',
  name: '销售额',
  bizName: 'sales_amount',
  metrics: [
    { metricBizName: 'sales_amount', metricName: '销售额' },
  ],
  dimensions: [
    { dimensionBizName: 'date', dimensionName: '日期' },
    { dimensionBizName: 'region', dimensionName: '区域' },
  ],
};

const scope = {
  allowedIndicatorIds: ['sales_amount'],
  allowedDimensions: ['date', 'region'],
  rowPolicies: [
    { id: 9, dimension: 'region', operator: 'IN', values: ['华东'] },
  ],
};

test('semantic compiler validates and binds query plans', () => {
  const compiler = new SemanticCompiler();
  const plan = compiler.compile({
    question: '近7天销售额趋势',
    indicator,
    metrics: ['sales_amount'],
    dimensions: ['date'],
    filters: [{ bizName: 'region', operator: 'IN', value: ['华南'] }],
    dateInfo: { dateMode: 'RECENT', unit: 7, period: 'DAY' },
    limit: 100,
  });
  const validation = compiler.validate(plan, {
    indicator,
    allowedDimensions: ['date', 'region'],
    scope,
  });
  assert.equal(validation.valid, true);

  const effective = compiler.bindPermissions(plan, scope);
  assert.deepEqual(effective.filters, [{
    bizName: 'region',
    operator: 'IN',
    value: ['华东'],
    source: 'POLICY',
    policyId: 9,
  }]);
});

test('semantic compiler rejects fields outside the indicator whitelist', () => {
  const compiler = new SemanticCompiler();
  const plan = compiler.compile({
    question: '按不存在维度查询',
    indicator,
    metrics: ['sales_amount'],
    dimensions: ['unknown_dimension'],
    filters: [],
  });
  const validation = compiler.validate(plan, {
    indicator,
    allowedDimensions: ['date', 'region'],
    scope,
  });
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === 'DIMENSION_NOT_FOUND'));
});

test('semantic compiler allows count distinct on an identifier dataset field', () => {
  const compiler = new SemanticCompiler();
  const plan = compiler.compileDatasetQuery({
    question: '本月各区域订单量',
    dataset: {
      id: 1,
      code: 'sales',
      name: '销售经营分析',
      schemaName: 'dev',
      primaryTable: 'sales',
    },
    metrics: [{ field: 'order_code', aggregator: 'COUNT_DISTINCT' }],
    dimensions: ['performance_region_name'],
    filters: [],
    dateRange: {
      field: 'sales_date',
      startDate: '2026-09-01',
      endDate: '2026-09-21',
    },
    limit: 200,
  });
  const validation = compiler.validateDatasetPlan(plan, {
    fields: [
      {
        fieldName: 'order_code',
        role: 'IDENTIFIER',
        aggregator: 'NONE',
      },
      {
        fieldName: 'performance_region_name',
        role: 'DIMENSION',
        aggregator: 'NONE',
      },
      {
        fieldName: 'sales_date',
        role: 'TIME',
        aggregator: 'NONE',
      },
    ],
    scope: {
      isAdmin: true,
      allowedDatasetIds: ['1'],
    },
  });

  assert.equal(validation.valid, true);
});

test('semantic compiler validates filters by dimension aliases', () => {
  const compiler = new SemanticCompiler();
  const aliasedIndicator = {
    ...indicator,
    dimensions: [
      {
        dimensionBizName: 'business_type_name',
        dimensionName: 'segment_name',
      },
    ],
  };
  const plan = compiler.compile({
    question: '本月重点客户组业绩',
    indicator: aliasedIndicator,
    metrics: ['sales_amount'],
    dimensions: [],
    filters: [{
      bizName: 'segment_name',
      operator: 'IN',
      value: ['企业客户'],
    }],
  });
  const validation = compiler.validate(plan, {
    indicator: aliasedIndicator,
    allowedDimensions: ['business_type_name'],
    scope: {
      unrestrictedIndicators: true,
      allowedIndicatorIds: ['sales_amount'],
      rowPolicies: [],
    },
  });

  assert.equal(validation.valid, true);
});
