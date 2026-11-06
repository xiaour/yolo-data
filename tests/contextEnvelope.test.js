import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTEXT_ENVELOPE_SCHEMA_VERSION,
  createCapabilityVersion,
  createContextEnvelope,
  requiresCodexThreadReset,
} from '../src/contextEnvelope.js';

function envelope(overrides = {}) {
  return createContextEnvelope({
    session: { id: 7, themeId: 3, modelId: 11 },
    theme: { id: 3, name: '经营总览' },
    question: '按省区分组呢',
    resolvedQuestion: '上个月各省区的含税销售额',
    conversationContext: {
      turnType: 'FOLLOW_UP',
      mode: 'FOLLOW_UP',
      reason: 'inherits_previous_metric_and_time',
      inheritQueryContext: true,
      taskId: 'task-2',
      rootTaskId: 'task-1',
      taskState: { metric: '含税销售额', time: '上个月', dimensions: ['省区'] },
    },
    executionContext: { sourceContext: '{"metric":"含税销售额"}' },
    runtimeDecision: { requested: 'auto', resolved: 'deep', reason: 'analysis_task' },
    capabilityVersion: 'cap-test',
    historyTurns: [
      { id: 1, role: 'user', content: '上个月业绩是多少', runtimeMode: null },
      { id: 2, role: 'assistant', content: '100 万元', runtimeMode: 'codex', computeMode: 'deep' },
      { id: 3, role: 'user', content: '这个月呢', runtimeMode: null },
      { id: 4, role: 'assistant', content: '120 万元', runtimeMode: 'responses', computeMode: 'fast' },
    ],
    ...overrides,
  });
}

test('ContextEnvelope makes YOLO authoritative and includes intervening Fast turns', () => {
  const result = envelope();
  assert.equal(result.schemaVersion, CONTEXT_ENVELOPE_SCHEMA_VERSION);
  assert.equal(result.authority, 'YOLO_SESSION');
  assert.equal(result.turn.resolvedQuestion, '上个月各省区的含税销售额');
  assert.equal(result.turn.inheritQueryContext, true);
  assert.deepEqual(
    result.fastTurnsSinceLastCodex.map((turn) => [turn.role, turn.content, turn.computeMode]),
    [
      ['user', '这个月呢', null],
      ['assistant', '120 万元', 'fast'],
    ],
  );
});

test('ContextEnvelope revision and capability version change only with authoritative inputs', () => {
  const first = envelope();
  const same = envelope();
  const changed = envelope({ resolvedQuestion: '今年各省区的含税销售额' });
  assert.equal(first.revision, same.revision);
  assert.notEqual(first.revision, changed.revision);
  assert.equal(
    createCapabilityVersion({ prompt: 'v1', model: 'model-a' }),
    createCapabilityVersion({ prompt: 'v1', model: 'model-a' }),
  );
  assert.notEqual(
    createCapabilityVersion({ prompt: 'v1', model: 'model-a' }),
    createCapabilityVersion({ prompt: 'v2', model: 'model-a' }),
  );
});

test('Codex thread mapping is reset when the YOLO capability version changes', () => {
  assert.equal(requiresCodexThreadReset({ codexThreadId: null }, 'cap-v2'), false);
  assert.equal(requiresCodexThreadReset({
    codexThreadId: 'thread-1', codexContextVersion: 'cap-v2',
  }, 'cap-v2'), false);
  assert.equal(requiresCodexThreadReset({
    codexThreadId: 'thread-1', codexContextVersion: 'cap-v1',
  }, 'cap-v2'), true);
});
