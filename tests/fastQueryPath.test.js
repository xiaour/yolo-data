import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSemanticFastPathDraft,
  resolveSemanticFastPathCandidate,
} from '../src/fastQueryPath.js';

const THEME = {
  semanticPolicy: {
    metrics: [
      {
        id: 'policy.gross_margin',
        concept: '毛利率',
        aliases: ['毛利率', '毛利'],
        priority: 100,
        exclusive: true,
        target: {
          type: 'FORMULA',
          outputField: '毛利率',
          outputFormat: 'PERCENT',
          precision: 2,
          expression: {
            op: 'DIVIDE',
            left: {
              op: 'SUBTRACT',
              left: { op: 'FIELD', field: 'sale_amt', aggregator: 'SUM' },
              right: { op: 'FIELD', field: 'sale_cost', aggregator: 'SUM' },
            },
            right: {
              op: 'ABS',
              value: { op: 'FIELD', field: 'sale_amt', aggregator: 'SUM' },
            },
          },
        },
      },
    ],
    dimensions: [
      {
        id: 'policy.province',
        concept: '省区',
        aliases: ['省区', '省份'],
        field: 'performance_province_name',
        operator: 'IN',
      },
    ],
    filters: [
      {
        id: 'policy.welfare',
        concept: '重点客户组',
        aliases: ['重点客户组'],
        field: 'business_type_name',
        operator: 'IN',
        value: ['企业客户', '零售客户', '大客户'],
      },
    ],
    policies: {
      ambiguity: 'CLARIFY',
      allowFuzzyMapping: false,
    },
  },
};

test('semantic fast path accepts one policy metric and one resolved time window', () => {
  const plan = buildSemanticFastPathDraft({
    question: '8月毛利率是多少',
    theme: THEME,
    now: new Date('2026-09-23T03:00:00Z'),
  });

  assert.equal(plan.eligible, true);
  assert.equal(plan.metricMatches[0].concept, '毛利率');
  assert.equal(plan.metricMatches[0].matchedText, '毛利率');
  assert.equal(plan.timeMentions.length, 1);
  assert.equal(plan.timeMentions[0].dateInfo.startDate, '2026-08-01');
  assert.equal(plan.draft.derivedMetrics[0].outputField, '毛利率');
});

test('semantic fast path preserves configured policy filters', () => {
  const plan = buildSemanticFastPathDraft({
    question: '本月重点客户组毛利率',
    theme: THEME,
    now: new Date('2026-09-23T03:00:00Z'),
  });

  assert.equal(plan.eligible, true);
  assert.equal(
    plan.matches.find((match) => match.category === 'FILTER').concept,
    '重点客户组',
  );
  assert.deepEqual(plan.draft.filterFields[0].value, ['企业客户', '零售客户', '大客户']);
});

test('semantic fast path defers dimension breakdowns to the full workflow', () => {
  const plan = buildSemanticFastPathDraft({
    question: '8月各省区毛利率',
    theme: THEME,
    now: new Date('2026-09-23T03:00:00Z'),
  });

  assert.equal(plan.eligible, false);
  assert.equal(plan.reason, 'dimension_breakdown_requires_full_workflow');
});

test('semantic fast path defers analytical and trend questions', () => {
  const trend = buildSemanticFastPathDraft({
    question: '2026年每月毛利率趋势',
    theme: THEME,
    now: new Date('2026-09-23T03:00:00Z'),
  });
  const attribution = buildSemanticFastPathDraft({
    question: '8月毛利率为什么下降',
    theme: THEME,
    now: new Date('2026-09-23T03:00:00Z'),
  });

  assert.equal(trend.eligible, false);
  assert.match(trend.reason, /unsupported_categories|dimension_breakdown|multiple_time_windows/);
  assert.equal(attribution.eligible, false);
  assert.equal(attribution.reason, 'attribution_requires_full_workflow');
});

test('semantic fast path maps a prompt metric synonym to a unique dataset metric field', () => {
  const plan = buildSemanticFastPathDraft({
    question: '上个月的销售额是多少',
    theme: {
      systemPrompt: '## 固定业务规则\n**税口径**：用户明确含税/未税按用户；未指定默认含税。',
      semanticPolicy: {},
    },
    datasetFields: [
      { fieldName: 'sale_amt', displayName: '含税销售额', role: 'METRIC', aggregator: 'SUM' },
      { fieldName: 'sale_cost', displayName: '含税销售成本', role: 'METRIC', aggregator: 'SUM' },
      { fieldName: 'sales_date', displayName: '销售日期', role: 'TIME', aggregator: 'NONE' },
    ],
    now: new Date('2026-10-23T03:00:00Z'),
  });

  assert.equal(plan.eligible, true);
  assert.equal(plan.draft.metricFields[0].field, 'sale_amt');
  assert.equal(plan.draft.metricFields[0].aggregator, 'SUM');
  assert.equal(plan.timeMentions[0].dateInfo.startDate, '2026-09-01');
  assert.equal(plan.timeMentions[0].dateInfo.endDate, '2026-09-30');
});

test('semantic fast path accepts the public dataset-definition field shape', () => {
  const plan = buildSemanticFastPathDraft({
    question: '上个月的销售额是多少',
    theme: {
      systemPrompt: '## 固定业务规则\n**指标同义词**：销售额=含税销售额；业绩=含税销售额；收入=含税销售额',
      semanticPolicy: {},
    },
    datasetFields: [
      { name: 'sale_amt', displayName: '含税销售额', role: 'METRIC', aggregator: 'SUM' },
      { name: 'sales_date', displayName: '销售日期', role: 'TIME', aggregator: 'NONE' },
    ],
    now: new Date('2026-10-23T03:00:00Z'),
  });

  assert.equal(plan.eligible, true);
  assert.equal(plan.draft.metricFields[0].field, 'sale_amt');
  assert.equal(plan.metricMatches[0].field, 'sale_amt');
});

test('prompt-defined performance synonym resolves across datasets without a primary selection', async () => {
  const theme = {
    systemPrompt: '## 固定业务规则\n**税口径**：未指定默认含税。\n**指标同义词**：业绩=含税销售额；收入=含税销售额',
    semanticPolicy: {},
  };
  const definitions = new Map([
    ['margin', [{ fieldName: 'gross_margin', displayName: '毛利率', role: 'METRIC', aggregator: 'AVG' },
      { fieldName: 'sales_date', displayName: '销售日期', role: 'TIME', aggregator: 'NONE' }]],
    ['sales', [{ fieldName: 'sale_amt', displayName: '含税销售额', role: 'METRIC', aggregator: 'SUM' },
      { fieldName: 'sales_date', displayName: '销售日期', role: 'TIME', aggregator: 'NONE' }]],
  ]);
  const result = await resolveSemanticFastPathCandidate({
    question: '上个月的业绩是多少',
    theme,
    datasets: [{ id: 'margin' }, { id: 'sales' }],
    loadDatasetFields: async (dataset) => definitions.get(dataset.id),
    now: new Date('2026-10-23T03:00:00Z'),
  });

  assert.equal(result.candidate.dataset.id, 'sales');
  assert.equal(result.candidate.fastPath.draft.metricFields[0].field, 'sale_amt');
});

test('prompt metric synonym does not auto-select when multiple datasets match', async () => {
  const result = await resolveSemanticFastPathCandidate({
    question: '上个月的业绩是多少',
    theme: {
      systemPrompt: '**指标同义词**：业绩=含税销售额',
      semanticPolicy: {},
    },
    datasets: [{ id: 'one' }, { id: 'two' }],
    loadDatasetFields: async () => [
      { fieldName: 'sale_amt', displayName: '含税销售额', role: 'METRIC', aggregator: 'SUM' },
      { fieldName: 'sales_date', displayName: '销售日期', role: 'TIME', aggregator: 'NONE' },
    ],
    now: new Date('2026-10-23T03:00:00Z'),
  });

  assert.equal(result.candidate, null);
  assert.equal(result.ambiguous, true);
});
