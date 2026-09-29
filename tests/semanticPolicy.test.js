import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySemanticPolicy,
  buildSemanticPolicyPrompt,
  normalizeSemanticPolicy,
} from '../src/semanticPolicy.js';

const policy = {
  version: 1,
  metrics: [
    {
      id: 'metric.gross_margin',
      concept: '毛利率',
      aliases: ['毛利率', '毛利'],
      excludeWhen: ['pricing_margin', 'booked_margin'],
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
            left: { field: 'sale_amt', aggregator: 'SUM' },
            right: { field: 'sale_cost', aggregator: 'SUM' },
          },
          right: {
            op: 'ABS',
            value: { field: 'sale_amt', aggregator: 'SUM' },
          },
        },
      },
    },
    {
      id: 'metric.pricing_gross_margin',
      concept: 'pricing_margin',
      aliases: ['pricing_margin', 'booked_margin'],
      priority: 200,
      target: {
        type: 'FORMULA',
        outputField: 'pricing_margin',
        outputFormat: 'PERCENT',
        expression: {
          op: 'DIVIDE',
          left: { field: 'profit', aggregator: 'SUM' },
          right: { field: 'sale_amt', aggregator: 'SUM' },
        },
      },
    },
  ],
};

test('semantic policy overrides conflicting model mappings with configured formulas', () => {
  const application = applySemanticPolicy({
    question: '8月各省区毛利率',
    policy,
    draft: {
      conditions: [
        { id: 'metric', sourceText: '毛利率', kind: 'METRIC', status: 'RESOLVED' },
      ],
      metricFields: [
        { field: 'profit', sourceText: '毛利率', aggregator: 'SUM' },
      ],
      derivedMetrics: [],
      dimensionFields: [],
      filterFields: [],
    },
  });

  assert.equal(application.matches.length, 1);
  assert.equal(application.draft.metricFields.length, 0);
  assert.equal(application.draft.derivedMetrics.length, 1);
  assert.equal(application.draft.derivedMetrics[0].type, 'EXPRESSION');
  assert.equal(application.draft.derivedMetrics[0].outputField, '毛利率');
  assert.equal(application.draft.conditions[0].kind, 'CALCULATION');
});

test('semantic policy excludes more specific business terminology', () => {
  const application = applySemanticPolicy({
    question: '8月各省区pricing_margin',
    policy,
    draft: {
      conditions: [],
      metricFields: [],
      derivedMetrics: [],
      dimensionFields: [],
      filterFields: [],
    },
  });
  assert.equal(application.matches.length, 1);
  assert.equal(application.matches[0].concept, 'pricing_margin');
  assert.equal(application.draft.derivedMetrics[0].outputField, 'pricing_margin');
});

test('semantic policy prompt is generated from configuration only', () => {
  const normalized = normalizeSemanticPolicy(policy);
  assert.equal(normalized.metrics.length, 2);
  const prompt = buildSemanticPolicyPrompt(policy);
  assert.match(prompt, /metric\.gross_margin/);
  assert.match(prompt, /业务语义包/);
});

test('semantic policy does not duplicate equivalent model filters', () => {
  const application = applySemanticPolicy({
    question: '标准配送采购组8月各省区毛利率',
    policy: {
      filters: [
        {
          id: 'filter.daily',
          concept: '标准配送',
          aliases: ['标准配送'],
          field: 'business_type_name',
          operator: 'IN',
          value: ['标准配送'],
        },
      ],
      metrics: policy.metrics,
    },
    draft: {
      conditions: [],
      metricFields: [],
      derivedMetrics: [],
      dimensionFields: [],
      filterFields: [{
        bizName: 'business_type_name',
        operator: 'IN',
        value: ['标准配送'],
        sourceText: '标准配送采购组',
      }],
    },
  });
  assert.equal(application.draft.filterFields.length, 1);
});
