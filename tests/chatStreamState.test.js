import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyChatStreamEvent,
  createChatStreamState,
} from '../public/js/components/chatStreamState.js';

test('chat stream state upserts progress updates instead of duplicating stages', () => {
  let stream = createChatStreamState();
  stream = applyChatStreamEvent(stream, {
    type: 'assistant_progress',
    id: 'stage-EXECUTE',
    status: 'running',
    text: '正在执行查询',
  });
  stream = applyChatStreamEvent(stream, {
    type: 'assistant_progress',
    id: 'stage-EXECUTE',
    status: 'done',
    text: '已完成执行查询',
  });
  assert.equal(stream.progress.length, 1);
  assert.equal(stream.progress[0].status, 'done');
  assert.equal(stream.progress[0].text, '已完成执行查询');
});

test('chat stream state switches from platform stages to Codex dynamic timeline', () => {
  let stream = createChatStreamState();
  stream = applyChatStreamEvent(stream, {
    type: 'execution_progress', id: 'platform-understand', status: 'done', title: '理解问题',
  });
  stream = applyChatStreamEvent(stream, { type: 'execution_reset', source: 'codex' });
  stream = applyChatStreamEvent(stream, {
    type: 'execution_progress', id: 'codex-plan-1', source: 'codex', status: 'running', title: '规划查询',
  });
  assert.equal(stream.executionTimeline.length, 1);
  assert.equal(stream.executionTimeline[0].id, 'codex-plan-1');
  assert.equal(stream.progress, stream.executionTimeline);
});

test('chat stream state accumulates answer deltas and marks completion', () => {
  let stream = createChatStreamState();
  stream = applyChatStreamEvent(stream, { type: 'assistant_answer_start' });
  stream = applyChatStreamEvent(stream, { type: 'assistant_delta', text: '第一段' });
  stream = applyChatStreamEvent(stream, { type: 'assistant_delta', text: '第二段' });
  stream = applyChatStreamEvent(stream, { type: 'assistant_answer_done' });
  assert.equal(stream.answerText, '第一段第二段');
  assert.equal(stream.answerStarted, true);
  assert.equal(stream.answerDone, true);
});

test('provisional streamed text is replaced by the final authoritative answer', () => {
  let stream = createChatStreamState();
  stream = applyChatStreamEvent(stream, { type: 'assistant_answer_start', preliminary: true });
  stream = applyChatStreamEvent(stream, { type: 'assistant_delta', text: '初步结论', preliminary: true });
  stream = applyChatStreamEvent(stream, { type: 'assistant_answer_replace', text: '最终结论' });
  stream = applyChatStreamEvent(stream, { type: 'assistant_answer_done' });
  assert.equal(stream.answerText, '最终结论');
  assert.equal(stream.answerDone, true);
});

test('chat stream state keeps the structured context decision for live UI', () => {
  let stream = createChatStreamState();
  stream = applyChatStreamEvent(stream, {
    type: 'context_resolved',
    context: {
      turnType: 'REVISION',
      inheritedSlots: [{ key: 'metric', label: '指标', sourceText: '销售额' }],
    },
  });
  assert.equal(stream.contextDecision.turnType, 'REVISION');
  assert.equal(stream.contextDecision.inheritedSlots[0].sourceText, '销售额');
});
