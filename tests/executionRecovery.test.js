import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReplanCarryForward,
  classifyRecoveryError,
  recoverySignature,
} from '../src/executionRecovery.js';
import { createAgentRecoveryCoordinator } from '../src/agentRecoveryCoordinator.js';

test('recovery classifier separates cancellation, permissions and transient failures', () => {
  assert.equal(classifyRecoveryError(new Error('模型服务请求超时')).retryable, true);
  assert.equal(classifyRecoveryError(new Error('模型服务请求失败（HTTP 429）')).category, 'TRANSIENT_UPSTREAM');
  assert.equal(classifyRecoveryError(Object.assign(new Error('permission denied'), { statusCode: 403 })).retryable, false);
  assert.equal(classifyRecoveryError(Object.assign(new Error('aborted'), { name: 'AbortError' })).category, 'CANCELLED');
  assert.notEqual(
    recoverySignature(new Error('field a failed'), { phase: 'EXECUTE' }),
    recoverySignature(new Error('field b failed'), { phase: 'EXECUTE' }),
  );
});

test('recovery coordinator replans with context then returns the recovered result', async () => {
  const events = [];
  const coordinator = createAgentRecoveryCoordinator({ onEvent: (event) => events.push(event) });
  let calls = 0;
  const result = await coordinator.run(async (hint, _attempt, context) => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('temporary query timeout');
      error.recoveryContext = {
        phase: 'EXECUTE',
        sessionId: 72,
        completedStages: [{ code: 'PLAN', status: 'SUCCESS' }],
        processSteps: [{ title: '执行契约', status: 'error', detail: 'timeout' }],
      };
      throw error;
    }
    assert.equal(context.sessionId, 72);
    assert.match(hint, /PLAN:SUCCESS/);
    assert.match(hint, /timeout/);
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(coordinator.attempts, 1);
  assert.equal(events[0].type, 'recovery_attempt');
});

test('replan carry-forward preserves locked query evidence and result', () => {
  const carry = buildReplanCarryForward({
    message: '9月销售额为 100 万元。',
    data: { columns: [{ name: 'amount' }], rows: [{ amount: 100 }] },
    queryFingerprint: 'query-1',
    dataHash: 'data-1',
    semanticParse: { queryContract: { id: 'contract-1' } },
    chart: { type: 'bar' },
    dataset: { id: 2, name: 'dataset', tableName: 'sales' },
    executionResults: [{
      kind: 'dataset',
      artifactId: 'artifact-1',
      queryFingerprint: 'query-1',
      dataHash: 'data-1',
      rowCount: 1,
      summary: '9月销售额为 100 万元。',
    }],
  });

  assert.equal(carry.data.rows.length, 1);
  assert.equal(carry.semanticParse.queryContract.id, 'contract-1');
  assert.equal(carry.dataset.primaryTable, 'sales');
  assert.equal(carry.lockedExecution.queryArtifactId, 'artifact-1');
  assert.equal(carry.lastSummary, '9月销售额为 100 万元。');
  assert.equal(carry.executions.length, 1);
});

test('replan carry-forward refuses to invent grounding', () => {
  assert.equal(buildReplanCarryForward({
    data: { columns: [], rows: [] },
    queryFingerprint: 'query-1',
    dataHash: 'data-1',
    semanticParse: { queryContract: { id: 'contract-1' } },
  })?.data.rows.length, 0);
  assert.equal(buildReplanCarryForward({
    data: { columns: [{ name: 'amount' }], rows: [{ amount: 1 }] },
    queryFingerprint: 'query-1',
    semanticParse: { queryContract: { id: 'contract-1' } },
  }), null);
});
