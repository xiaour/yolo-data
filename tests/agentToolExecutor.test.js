import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentToolExecutor } from '../src/agentToolExecutor.js';

function createExecutor({ executeRawTool, artifacts = async () => null }) {
  const processSteps = [];
  const events = [];
  return {
    processSteps,
    events,
    execute: createAgentToolExecutor({
      skillRegistry: { resolveToolSkill: () => null },
      skills: [],
      processSteps,
      appendProcessStep: (step) => processSteps.push(step),
      emit: (event) => events.push(event),
      executeRawTool,
      describeToolStep: () => ({ title: '查询', detail: '已处理' }),
      buildToolReview: () => ({ facts: [] }),
      recordProcessArtifact: async (input) => artifacts(input),
      toolStageCode: () => 'EXECUTE',
    }),
  };
}

test('tool executor records success, artifacts and result events', async () => {
  const tool = createExecutor({
    executeRawTool: async () => ({ rowCount: 2 }),
    artifacts: async () => ({ id: 'process-1', title: '查询记录' }),
  });
  const result = await tool.execute('query_business_dataset', { datasetId: 1 });
  assert.equal(result.rowCount, 2);
  assert.equal(tool.processSteps[0].status, 'success');
  assert.equal(tool.processSteps[0].artifactId, 'process-1');
  assert.ok(tool.events.some((event) => event.type === 'tool_result'));
});

test('tool executor records a failure and rethrows the original error', async () => {
  const expected = new Error('contract rejected');
  const tool = createExecutor({ executeRawTool: async () => { throw expected; } });
  await assert.rejects(tool.execute('execute_query_contract', {}), (error) => error === expected);
  assert.equal(tool.processSteps[0].status, 'error');
  assert.ok(tool.events.some((event) => event.type === 'tool_error'));
});
