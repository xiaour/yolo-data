import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExecutionTimeline } from '../src/executionTimeline.js';

test('fixed workflow is collapsed into business-readable display categories', () => {
  const timeline = buildExecutionTimeline({
    workflow: {
      stages: [
        { code: 'INTENT', status: 'SUCCESS', summary: '已识别问题', durationMs: 4 },
        { code: 'SEMANTIC_RESOLVE', status: 'SUCCESS', summary: '已解析口径', durationMs: 6 },
        { code: 'EXECUTE', status: 'SUCCESS', summary: '返回 12 行', durationMs: 10 },
      ],
    },
  });
  assert.deepEqual(timeline.map((item) => item.title), ['理解问题', '执行计算']);
  assert.equal(timeline[0].durationMs, 10);
});

test('Codex timeline uses dynamic plan and tool events without private content', () => {
  const timeline = buildExecutionTimeline({
    codexEvents: [{
      type: 'codex_plan_updated', timestamp: '2026-11-05T00:00:00.000Z',
      steps: [{ id: '1', status: 'running', title: '对比去年同期客户表现' }],
      privateReasoning: '不应暴露',
    }],
    processSteps: [{
      id: 'step-1', stageCode: 'EXECUTE', status: 'success',
      title: '执行客户聚合查询', detail: '返回 20 行',
    }],
  });
  assert.deepEqual(timeline.map((item) => item.title), [
    '对比去年同期客户表现', '执行客户聚合查询',
  ]);
  assert.doesNotMatch(JSON.stringify(timeline), /不应暴露/);
});
