import assert from 'node:assert/strict';
import test from 'node:test';
import { responsesText } from './fixtures/responsesApi.js';

import { resolveConversationContext } from '../src/queryIntent.js';
import { refineTurnContextWithHarness } from '../src/turnRouter.js';
import { TURN_TYPES } from '../src/turnContext.js';

const history = [
  { role: 'user', content: '查询本月含税销售金额' },
  {
    role: 'assistant',
    content: '本月含税销售额为 100 万元。',
    result: {
      taskState: {
        taskId: 'task-sales',
        turnId: 'turn-sales',
        rootTaskId: 'task-sales',
        turnType: 'NEW_TASK',
        question: '查询本月含税销售金额',
        resolvedQuestion: '查询本月含税销售金额',
        slots: {
          metric: [{ value: '含税销售金额', sourceText: '含税销售金额', source: 'explicit' }],
          time: [{ value: '本月', sourceText: '本月', source: 'explicit' }],
        },
        explicitSlots: {
          metric: [{ value: '含税销售金额', sourceText: '含税销售金额', source: 'explicit' }],
          time: [{ value: '本月', sourceText: '本月', source: 'explicit' }],
        },
        inheritedSlots: {},
        memorySlots: {},
        status: 'COMPLETED',
      },
    },
  },
];

test('low-confidence context uses the model only as a structured router', async () => {
  const initial = resolveConversationContext('订单量', history);
  assert.equal(initial.needsClassifier, true);
  const calls = [];
  const context = await refineTurnContextWithHarness({
    context: initial,
    history,
    harness: {
      mode: 'test-model',
      chat: async (messages, tools, metadata) => {
        calls.push({ messages, tools, metadata });
        return responsesText(JSON.stringify({
          turnType: 'CONTINUATION',
          confidence: 0.93,
          referencedTask: true,
          reason: '用户省略了时间，继续当前任务',
          metric: '模型不应生成指标',
        }));
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].metadata.callType, 'CONTEXT_ROUTER');
  assert.equal(context.turnType, TURN_TYPES.CONTINUATION);
  assert.equal(context.source, 'model');
  assert.equal(context.needsClassifier, false);
  assert.equal(context.inheritedSlots.time[0].sourceText, '本月');
  assert.equal(context.taskState.explicitSlots.metric, undefined);
  assert.doesNotMatch(context.question, /模型不应生成指标/);
});

test('a rule-only runtime requires confirmation instead of inventing a route', async () => {
  const initial = resolveConversationContext('订单量', history);
  const context = await refineTurnContextWithHarness({
    context: initial,
    history,
    harness: { mode: 'local-rule' },
  });
  assert.equal(context.turnType, initial.turnType);
  assert.equal(context.needsConfirmation, true);
  assert.equal(context.source, 'rule-fallback');
});

test('a failed router degrades to confirmation without business output', async () => {
  const initial = resolveConversationContext('订单量', history);
  const context = await refineTurnContextWithHarness({
    context: initial,
    history,
    harness: {
      mode: 'test-model',
      chat: async () => { throw new Error('offline'); },
    },
  });
  assert.equal(context.needsConfirmation, true);
  assert.match(context.reason, /model_router_failed/);
});

test('the model router preserves the configured inheritance budget', async () => {
  const initial = resolveConversationContext('订单量', history, {
    maxInheritTurns: 2,
    maxInheritedSlots: 1,
  });
  const context = await refineTurnContextWithHarness({
    context: initial,
    history,
    harness: {
      mode: 'test-model',
      chat: async () => responsesText(JSON.stringify({
        turnType: 'CONTINUATION',
        confidence: 0.9,
        reason: '继续上一任务',
      })),
    },
  });

  assert.equal(context.inheritBudget.maxTurns, 2);
  assert.equal(context.inheritBudget.maxSlots, 1);
  assert.equal(Object.keys(context.inheritedSlots).length, 1);
});

test('model-classified output instructions never fall back to result processing', async () => {
  const initial = resolveConversationContext('只保留标题', history);
  const context = await refineTurnContextWithHarness({
    context: initial,
    history,
    harness: {
      mode: 'test-model',
      chat: async () => responsesText(JSON.stringify({
        turnType: 'INSTRUCTION',
        confidence: 0.94,
        reason: '这是输出格式要求，不执行问数',
      })),
    },
  });

  assert.equal(context.turnType, TURN_TYPES.INSTRUCTION);
  assert.equal(context.conversationDirective, null);
  assert.deepEqual(context.inheritedSlots, {});
  assert.deepEqual(context.slots, {});
});
