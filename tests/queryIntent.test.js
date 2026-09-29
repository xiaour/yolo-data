import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inferAnalysisMode,
  inferDatasetQuerySpec,
  inferIndicatorQuerySpec,
  inferTimeGrain,
  resolveClarificationPolicy,
  resolveArtifactReusePolicy,
  resolveConversationContext,
  resolveConversationQuestion,
} from '../src/queryIntent.js';

const datasetFields = [
  {
    fieldName: 'sales_date',
    displayName: '销售日期',
    role: 'TIME',
  },
  {
    fieldName: 'order_code',
    displayName: '销售单号',
    role: 'IDENTIFIER',
  },
  {
    fieldName: 'performance_region_name',
    displayName: '销售大区名称',
    role: 'DIMENSION',
  },
  {
    fieldName: 'sale_amt',
    displayName: '含税销售额',
    role: 'METRIC',
    aggregator: 'SUM',
  },
];

test('multi-turn slot answers are resolved with recent user context', () => {
  const resolved = resolveConversationQuestion('本月', [
    { role: 'user', content: '各区域订单量对比' },
    { role: 'assistant', content: '请补充订单口径和时间范围' },
    { role: 'user', content: '按订单号进行数量统计' },
    { role: 'assistant', content: '请确认区域字段' },
    { role: 'user', content: '销售大区名称' },
  ]);

  assert.match(resolved, /各区域订单量对比/);
  assert.match(resolved, /按订单号进行数量统计/);
  assert.match(resolved, /销售大区名称/);
  assert.match(resolved, /本月/);
});

test('a self-contained short question does not inherit unrelated prior filters', () => {
  const resolved = resolveConversationQuestion('本月重点客户组业务的销售额', [
    { role: 'user', content: '查询本月含税销售金额' },
    { role: 'user', content: '本月标准配送的销售额' },
  ]);

  assert.equal(resolved, '本月重点客户组业务的销售额');
});

test('a complete unrelated question starts a new topic', () => {
  const context = resolveConversationContext('查询本月含税销售金额', [
    { role: 'user', content: 'Demo Customer8月有几个客户号' },
    {
      role: 'assistant',
      content: '查询完成，共找到8个客户号。',
    },
  ]);

  assert.equal(context.mode, 'INDEPENDENT');
  assert.equal(context.inheritQueryContext, false);
  assert.equal(context.question, '查询本月含税销售金额');
  assert.deepEqual(context.inheritedUserMessages, []);
});

test('result operations explicitly become follow-up context', () => {
  const context = resolveConversationContext('请加入一行汇总数据', [
    { role: 'user', content: '查询本月含税销售金额' },
    {
      role: 'assistant',
      content: '查询完成，结果为 100。',
    },
  ]);

  assert.equal(context.mode, 'FOLLOW_UP');
  assert.equal(context.reason, 'result_operation');
});

test('prompt-owned filters stay out of deterministic compiler defaults', () => {
  const indicatorDimensions = [
    {
      dimensionBizName: 'business_type_name',
      dimensionName: '业务分类',
    },
  ];
  const spec = inferIndicatorQuerySpec({
    question: '2026年8月PrivateLabel销售额，分业务类型展示',
    metrics: [{ metricBizName: 'sale_amt', metricName: '含税销售金额' }],
    dimensions: indicatorDimensions,
    fallbackMetrics: ['sale_amt'],
    fallbackDimensions: [],
    dateField: null,
  });
  assert.deepEqual(spec.dimensions, []);
});

test('dataset intent uses prompt/model metrics and exact field labels', () => {
  const spec = inferDatasetQuerySpec({
    question: '各销售大区名称订单量对比；本月',
    fields: datasetFields,
    fallbackMetrics: [{
      field: 'order_code',
      aggregator: 'COUNT_DISTINCT',
      label: '订单量',
    }],
  });

  assert.deepEqual(spec.metrics, [{
    field: 'order_code',
    aggregator: 'COUNT_DISTINCT',
    label: '订单量',
  }]);
  assert.deepEqual(spec.dimensions, ['performance_region_name']);
  assert.deepEqual(spec.order, [{
    field: 'order_code',
    direction: 'DESC',
  }]);
  assert.equal(spec.aggregationIntent, 'GROUP');
});

test('indicator intent keeps total requests aggregated without a date dimension', () => {
  const metrics = [
    { metricBizName: 'sale_amt', metricName: '含税销售金额' },
  ];
  const dimensions = [
    { dimensionBizName: 'sdt', dimensionName: '销售日期' },
    { dimensionBizName: 'performance_region_name', dimensionName: '业绩大区名称' },
  ];
  const total = inferIndicatorQuerySpec({
    question: '查询本月含税销售金额',
    metrics,
    dimensions,
    fallbackMetrics: ['sale_amt'],
    fallbackDimensions: ['sdt'],
    dateField: 'sdt',
  });
  assert.deepEqual(total.metrics, ['sale_amt']);
  assert.deepEqual(total.dimensions, []);
  assert.equal(total.aggregationIntent, 'SUMMARY');

  const trend = inferIndicatorQuerySpec({
    question: '查询本月含税销售金额，按照每周分组',
    metrics,
    dimensions,
    fallbackMetrics: ['sale_amt'],
    fallbackDimensions: [],
    dateField: 'sdt',
  });
  assert.deepEqual(trend.dimensions, ['sdt']);
  assert.equal(trend.timeGrain, 'WEEK');
  assert.equal(trend.aggregationIntent, 'GROUP');
});

test('time grain recognizes each-month and each-week wording', () => {
  assert.equal(
    inferTimeGrain('2026年标准配送每个月的业绩趋势'),
    'MONTH',
  );
  assert.equal(
    inferTimeGrain('2026年标准配送每个星期的业绩趋势'),
    'WEEK',
  );
  assert.equal(
    inferTimeGrain('2026年标准配送每个季度的业绩趋势'),
    'QUARTER',
  );
});

test('attribution questions are classified separately and clarify at most once', () => {
  const mode = inferAnalysisMode('帮我分析9月份业绩上升还是下滑，然后输出具体原因');
  assert.equal(mode.mode, 'ATTRIBUTION');
  assert.equal(mode.requiresComparison, true);
  assert.equal(mode.requiresBreakdown, true);

  const policy = resolveClarificationPolicy([
    {
      role: 'assistant',
      content: '请确认对比基准和原因拆解维度。',
    },
  ], 'ATTRIBUTION');
  assert.equal(policy.used, 1);
  assert.equal(policy.allowed, false);
  assert.equal(policy.remaining, 0);
});

test('artifact reuse policy blocks fresh queries for result follow-ups', () => {
  const context = { reason: 'result_operation' };
  const followUp = resolveArtifactReusePolicy('把上表按省区排序并导出 Excel', context, 2);
  assert.equal(followUp.reuseArtifactsOnly, true);

  const refresh = resolveArtifactReusePolicy('刷新一下最新数据并重新查询', context, 2);
  assert.equal(refresh.reuseArtifactsOnly, false);
  assert.equal(refresh.explicitRefresh, true);

  const independent = resolveArtifactReusePolicy(
    '查询本月标准配送销售额',
    { reason: 'standalone_question' },
    2,
  );
  assert.equal(independent.reuseArtifactsOnly, false);
});
