import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adjudicateMetricResolution,
  resolveMetricCandidates,
} from '../src/metricResolver.js';

test('metric resolver prioritizes semantic policy aliases', () => {
  const result = resolveMetricCandidates({
    concept: 'margin',
    candidates: [
      { id: 'pricing', name: 'pricing_margin' },
      { id: 'front', name: 'frontend_margin' },
    ],
    policyRules: [
      {
        id: 'gross_margin',
        concept: 'margin',
        aliases: ['margin'],
        target: {
          type: 'FIELD',
          field: 'front',
        },
      },
    ],
  });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].mode, 'POLICY_EXACT');
  assert.equal(adjudicateMetricResolution(result).status, 'RESOLVED');
});

test('metric resolver blocks similar candidates instead of guessing', () => {
  const result = resolveMetricCandidates({
    concept: 'margin',
    candidates: [
      { id: 'a', name: 'frontend_margin' },
      { id: 'b', name: 'pricing_margin' },
    ],
    threshold: 0.78,
  });
  assert.equal(adjudicateMetricResolution(result).status, 'AMBIGUOUS');
});
