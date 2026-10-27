import assert from 'node:assert/strict';
import test from 'node:test';
import { buildToolReview, describeToolStep, toolStageCode } from '../src/agentToolPresentation.js';

test('tool events distinguish discovery, confirmation, planning, execution and analysis', () => {
  for (const [name, stage] of [
    ['list_business_datasets', 'SEMANTIC_DISCOVERY'],
    ['get_business_dataset_definition', 'SEMANTIC_CONFIRM'],
    ['compile_query_contract', 'PLAN'],
    ['execute_query_contract', 'EXECUTE'],
    ['execute_analysis_code', 'CODE'],
    ['transform_workspace_artifact', 'ANALYZE'],
    ['extension_tool', 'EXECUTE'],
  ]) assert.equal(toolStageCode(name), stage);
});

test('dataset query review exposes result metadata and fingerprint', () => {
  const review = buildToolReview('query_business_dataset', { datasetId: 'sales' }, {
    rowCount: 2,
    columns: [{ name: 'revenue' }, { bizName: 'region' }],
    queryFingerprint: 'query-1',
  });
  assert.deepEqual(review.details, {
    contractId: null, columns: ['revenue', 'region'], rowCount: 2, queryFingerprint: 'query-1',
  });
  assert.ok(review.facts.some(({ label, value }) => label === '数据源' && value === 'sales'));
  assert.equal(review.code, '');
  assert.equal(review.stdout, '');
  assert.equal(review.stderr, '');
});

test('code review retains code and diagnostics while bounding long fact values', () => {
  const review = buildToolReview('execute_analysis_code', { purpose: 'x'.repeat(900), code: 'print(1)' }, {
    success: false, durationMs: 1234, stdout: '1', stderr: 'error', runId: 'run-1',
    outputs: [{ fileName: 'result.csv' }],
  });
  assert.equal(review.facts.find(({ label }) => label === '目的').value, `${'x'.repeat(800)}…`);
  assert.equal(review.facts.find(({ label }) => label === '耗时').value, '1.23 秒');
  assert.equal(review.code, 'print(1)');
  assert.equal(review.stdout, '1');
  assert.equal(review.stderr, 'error');
  assert.equal(review.details.runId, 'run-1');
});

test('invalid contracts show actionable issues and unknown tools preserve their arguments', () => {
  assert.deepEqual(describeToolStep('compile_query_contract', {}, {
    valid: false, issues: [{ message: 'Missing metric' }, { message: 'Missing range' }],
  }), { title: '查询契约待修正', detail: 'Missing metric；Missing range' });
  assert.deepEqual(describeToolStep('extension_tool', { id: 'a' }, {}), {
    title: 'extension_tool', detail: '{"id":"a"}',
  });
  assert.deepEqual(buildToolReview('extension_tool'), {
    facts: [], details: null, code: '', stdout: '', stderr: '',
  });
});
