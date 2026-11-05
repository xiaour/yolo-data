import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assistantTextChunks,
  createChatStreamPresenter,
} from '../src/chatStreamPresenter.js';

test('chat stream presenter turns workflow stages into readable progress', () => {
  const present = createChatStreamPresenter();
  const [started] = present({ type: 'run_started' });
  assert.equal(started.type, 'execution_progress');
  assert.equal(started.status, 'running');
  assert.equal(started.title, '理解问题');

  const [running] = present({
    type: 'workflow_stage',
    stage: { code: 'EXECUTE', name: '执行查询', status: 'RUNNING', summary: '' },
  });
  assert.equal(running.id, 'platform-execute');
  assert.equal(running.status, 'running');
  assert.equal(running.title, '执行计算');

  const [done] = present({
    type: 'workflow_stage',
    stage: { code: 'EXECUTE', name: '执行查询', status: 'SUCCESS', summary: '返回 42 行' },
  });
  assert.equal(done.id, 'platform-execute');
  assert.equal(done.status, 'done');
  assert.equal(done.detail, '返回 42 行');
});

test('chat stream presenter exposes tool activity without private reasoning', () => {
  const present = createChatStreamPresenter();
  const [step] = present({
    type: 'process_step',
    step: {
      id: 'step-3',
      stageCode: 'EXECUTE',
      status: 'success',
      title: '执行数据集查询',
      detail: '42 行',
    },
  });
  assert.equal(step.id, 'platform-execute');
  assert.equal(step.status, 'done');
  assert.equal(step.title, '执行计算');
});

test('Codex plan replaces fixed workflow progress with dynamic readable steps', () => {
  const present = createChatStreamPresenter();
  present({ type: 'run_started' });
  present({ type: 'workflow_stage', stage: { code: 'PLAN', status: 'RUNNING' } });
  const events = present({
    type: 'codex_plan_updated',
    steps: [
      { id: '1', status: 'completed', title: '确认时间和指标' },
      { id: '2', status: 'in_progress', title: '查询销售明细' },
    ],
  });
  assert.equal(events[0].type, 'execution_reset');
  assert.deepEqual(events.slice(1).map((event) => event.title), [
    '确认时间和指标', '查询销售明细',
  ]);
  assert.deepEqual(present({
    type: 'workflow_stage', stage: { code: 'EXECUTE', status: 'RUNNING' },
  }), []);
});

test('assistant text chunks preserve the complete answer', () => {
  const message = '第一段业务结论。\n\n第二段包含 **重点指标** 与明细说明。';
  const chunks = assistantTextChunks(message, { targetChunks: 8, minChunkSize: 3 });
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), message);
  assert.ok(chunks.every((chunk) => chunk.length <= Math.ceil(message.length / 8) + 1));
});
