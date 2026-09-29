import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleExecutionStages } from '../public/executionDetails.js';

test('execution details only expose stages that actually ran', () => {
  const stages = visibleExecutionStages([
    { code: 'INTENT', status: 'PENDING' },
    { code: 'SEMANTIC_DISCOVERY', status: 'SUCCESS' },
    { code: 'SEMANTIC_CONFIRM', status: 'SKIPPED' },
    { code: 'PLAN', status: 'FAILED' },
    { code: 'EXECUTE', status: 'RUNNING' },
  ]);

  assert.deepEqual(stages.map((stage) => stage.code), [
    'SEMANTIC_DISCOVERY',
    'PLAN',
    'EXECUTE',
  ]);
});
