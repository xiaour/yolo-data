import assert from 'node:assert/strict';
import test from 'node:test';

import { ComputeModeRouter, normalizeComputeMode } from '../src/computeMode.js';

const fastHarness = { mode: 'fast-runtime' };
const codexHarness = { mode: 'codex', isAvailable: () => true };

test('compute mode normalization defaults to auto', () => {
  assert.equal(normalizeComputeMode('FAST'), 'fast');
  assert.equal(normalizeComputeMode('unknown'), 'auto');
});

test('auto compute mode routes analytical questions to Codex', () => {
  const router = new ComputeModeRouter({ codexHarness });
  const decision = router.select({
    requestedMode: 'auto',
    fastHarness,
    question: '与去年同期相比，哪些客户下降比较多，有什么机会点？',
    analysisRequest: { taskKind: 'ANALYSIS' },
    analysisMode: { mode: 'ATTRIBUTION' },
    conversationContext: { mode: 'NEW_TOPIC' },
  });
  assert.equal(decision.resolved, 'deep');
  assert.equal(decision.harness, codexHarness);
});

test('auto compute mode keeps simple metric queries on fast runtime', () => {
  const router = new ComputeModeRouter({ codexHarness });
  const decision = router.select({
    requestedMode: 'auto',
    fastHarness,
    question: '上个月销售额是多少',
    analysisRequest: { taskKind: 'QUERY' },
    analysisMode: { mode: 'METRIC_QUERY' },
    conversationContext: { mode: 'NEW_TOPIC' },
  });
  assert.equal(decision.resolved, 'fast');
  assert.equal(decision.reason, 'simple_query');
});

test('legacy client mode cannot override automatic routing', () => {
  const router = new ComputeModeRouter({
    codexHarness: { isAvailable: () => false },
  });
  const deepRequest = router.select({ requestedMode: 'deep', fastHarness, question: '销售额是多少' });
  const fastRequest = new ComputeModeRouter({ codexHarness }).select({
    requestedMode: 'fast',
    fastHarness,
    question: '分析销售额下降原因和机会点',
    analysisRequest: { taskKind: 'ANALYSIS' },
  });
  assert.equal(deepRequest.requested, 'auto');
  assert.equal(deepRequest.resolved, 'fast');
  assert.equal(fastRequest.requested, 'auto');
  assert.equal(fastRequest.resolved, 'deep');
});

test('a session with a persisted Codex thread stays on Codex', () => {
  const router = new ComputeModeRouter({ codexHarness });
  const decision = router.select({
    fastHarness,
    question: '现在销售额是多少',
    conversationContext: { mode: 'NEW_TOPIC' },
    codexThreadId: 'thread-persisted',
  });
  assert.equal(decision.resolved, 'deep');
  assert.equal(decision.reason, 'durable_codex_session');
});

