import assert from 'node:assert/strict';
import test from 'node:test';
import { compileAnalysisGoals } from '../src/analysisGoals.js';

test('composition goals lower to a share-of-total operator without reading question text', () => {
  const issues = [];
  const result = compileAnalysisGoals({
    goals: [{
      id: 'composition',
      type: 'COMPOSITION',
      measure: 'sale_amt',
      groupBy: ['business_type_name'],
      outputField: 'sale_amt_share',
    }],
    metricFields: [{ field: 'sale_amt', outputField: 'sale_amt' }],
    dimensionFields: [{ field: 'business_type_name', isTime: false }],
    issues,
  });

  assert.deepEqual(issues, []);
  assert.equal(result.goals[0].type, 'COMPOSITION');
  assert.equal(result.derivedMetrics[0].type, 'SHARE_OF_TOTAL');
  assert.equal(result.derivedMetrics[0].left.field, 'sale_amt');
});

test('identical ratio operands are rejected instead of silently rewritten', () => {
  const issues = [];
  compileAnalysisGoals({
    metricFields: [{ field: 'sale_amt', outputField: 'sale_amt' }],
    dimensionFields: [{ field: 'business_type_name', isTime: false }],
    derivedMetrics: [{
      type: 'RATIO',
      outputField: 'bad_ratio',
      left: { field: 'sale_amt' },
      right: { field: 'sale_amt' },
    }],
    issues,
  });

  assert.ok(issues.some((issue) => issue.code === 'RATIO_IDENTICAL_OPERANDS'));
});
