import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticFastPathDraft } from '../src/fastQueryPath.js';

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
