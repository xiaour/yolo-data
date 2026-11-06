import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYSIS_PURPOSES,
  TASK_KINDS,
  inferAnalysisRequest,
} from '../src/analysisRequest.js';

test('simple metric lookup remains a query', () => {
  const request = inferAnalysisRequest('上个月的销售额是多少');
  assert.equal(request.taskKind, TASK_KINDS.QUERY);
  assert.equal(request.requiresPostQueryAnalysis, false);
});

test('comparison diagnosis with opportunities becomes an analysis report', () => {
  const request = inferAnalysisRequest('与去年同期对比，哪些客户下降比较多？有什么机会点');
  assert.equal(request.taskKind, TASK_KINDS.ANALYSIS);
  assert.deepEqual(request.purposes, [
    ANALYSIS_PURPOSES.COMPARE,
    ANALYSIS_PURPOSES.DIAGNOSE,
    ANALYSIS_PURPOSES.OPPORTUNITY,
  ]);
  assert.equal(request.requiresCode, true);
  assert.ok(request.stages.includes('PERIOD_COMPARISON'));
  assert.ok(request.stages.includes('SEGMENT_DIAGNOSIS'));
  assert.ok(request.stages.includes('OPPORTUNITY_HYPOTHESES'));
});

test('artifact export is classified separately from analysis', () => {
  const request = inferAnalysisRequest('把结果转换成 Excel', {
    contextReason: 'result_operation',
  });
  assert.equal(request.taskKind, TASK_KINDS.RESULT_OPERATION);
  assert.equal(request.requiresReport, false);
});

test('an analytical follow-up is not downgraded to a result operation', () => {
  const request = inferAnalysisRequest('这些客户为什么下降？有什么机会点', {
    contextReason: 'result_reference',
  });
  assert.equal(request.taskKind, TASK_KINDS.ANALYSIS);
  assert.ok(request.purposes.includes(ANALYSIS_PURPOSES.EXPLAIN));
  assert.ok(request.purposes.includes(ANALYSIS_PURPOSES.OPPORTUNITY));
});
