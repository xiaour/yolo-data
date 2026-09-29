import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DataAgentWorkflow } from '../src/workflow.js';

test('workflow keeps discarded attempts while exposing the adopted stage', () => {
  const workflow = new DataAgentWorkflow({
    question: '查询含税销售金额',
    user: { id: 1, username: 'tester', displayName: '测试用户' },
    theme: { id: 1, name: '经营总览' },
  });

  workflow.complete('PLAN', {
    summary: '第一次计划',
    detail: '按大区',
  });
  workflow.complete('PLAN', {
    summary: '最终计划',
    detail: '按日',
  });

  const stage = workflow.toJSON().stages.find((item) => item.code === 'PLAN');
  assert.equal(stage.summary, '最终计划');
  assert.equal(stage.attempts.length, 2);
  assert.equal(stage.attempts[0].summary, '第一次计划');
  assert.equal(stage.attempts[1].summary, '最终计划');
});

test('workflow stage duration is measured from its explicit start', async () => {
  const workflow = new DataAgentWorkflow({
    question: '查询含税销售金额',
    user: { id: 1, username: 'tester', displayName: '测试用户' },
    theme: { id: 1, name: '经营总览' },
  });

  workflow.start('PLAN', '开始生成计划');
  await delay(15);
  workflow.complete('PLAN', {
    summary: '计划完成',
  });

  const stage = workflow.toJSON().stages.find((item) => item.code === 'PLAN');
  assert.ok(stage.durationMs >= 10);
  assert.ok(new Date(stage.finishedAt).getTime() > new Date(stage.startedAt).getTime());
});
