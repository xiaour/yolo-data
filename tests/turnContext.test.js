import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  TURN_TYPES,
  completeTaskState,
  createTurnContext,
  extractExplicitSlots,
  previousTaskFromHistory,
} from '../src/turnContext.js';
import { resolveConversationContext } from '../src/conversationResolver.js';

function slot(value, source = 'explicit') {
  return { value, sourceText: value, source };
}

function completedHistory(context, content = '查询已完成') {
  return [
    { role: 'user', content: context.originalQuestion },
    {
      role: 'assistant',
      content,
      result: {
        taskState: completeTaskState({
          contextTask: context.taskState,
          answer: { resolvedQuestion: context.question },
          artifactId: `artifact-${context.turnId}`,
        }),
      },
    },
  ];
}

test('fixed query-context evaluation cases preserve task boundaries', () => {
  const cases = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), 'eval/query-context-cases.json'),
    'utf8',
  ));
  assert.deepEqual(cases.map((item) => item.kind).sort(), [
    'clarification', 'follow_up', 'new_question', 'result_operation',
  ]);
  for (const item of cases) {
    const previous = createTurnContext({ question: item.previousQuestion });
    const history = completedHistory(previous);
    if (item.expectedArtifactId) {
      history[1].result.taskState.result = { artifactId: item.expectedArtifactId };
    }
    const current = createTurnContext({
      question: item.question,
      history,
      turnType: TURN_TYPES[item.turnType],
      referencesResult: Boolean(item.referencesResult),
    });
    assert.equal(current.turnType, item.turnType, item.id);
    for (const key of item.mustNotInherit ?? []) {
      assert.equal(current.inheritedSlots[key], undefined, `${item.id} leaked ${key}`);
    }
    for (const key of item.mustInherit ?? []) {
      assert.ok(current.inheritedSlots[key]?.length, `${item.id} lost ${key}`);
    }
    for (const key of item.mustBeExplicit ?? []) {
      assert.ok(current.explicitSlots[key]?.length, `${item.id} did not capture ${key}`);
    }
    if (item.expectedArtifactId) {
      assert.equal(current.referencedArtifactId, item.expectedArtifactId, item.id);
    }
  }
});

for (const time of [
  '2026年1月1日至2026年3月31日',
  '2026-01-01 至 2026-03-31',
  '2026年1月1日至3月31日',
  '2026年1月1日',
]) {
  test(`explicit time slots preserve the complete date expression: ${time}`, () => {
    assert.deepEqual(extractExplicitSlots(`${time}销售额`).time.map(item => item.sourceText), [time]);
  });
}

test('two distinct explicit date ranges remain separate time slots', () => {
  const question = '对比2026年1月1日至2026年1月31日与2026年3月1日至2026年3月31日销售额';
  assert.deepEqual(extractExplicitSlots(question).time.map(item => item.sourceText), [
    '2026年1月1日至2026年1月31日', '2026年3月1日至2026年3月31日',
  ]);
});

test('an ISO date clarification fills time without replacing the inherited region filter', () => {
  const first = createTurnContext({ question: '销售额，只看华东' });
  const clarified = createTurnContext({ question: '2026-01-01', history: completedHistory(first),
    turnType: TURN_TYPES.CLARIFICATION_ANSWER });
  assert.deepEqual(clarified.slots.time.map(item => item.sourceText), ['2026-01-01']);
  assert.equal(clarified.explicitSlots.filters, undefined);
  assert.deepEqual(clarified.inheritedSlots.filters.map(item => item.sourceText), ['华东']);
  assert.deepEqual(clarified.slots.filters.map(item => item.sourceText), ['华东']);
});

test('followups inherit full date ranges and filters while a time revision replaces only time', () => {
  const first = createTurnContext({ question: '2026年1月1日至2026年3月31日销售额，只看华东' });
  const second = createTurnContext({ question: '按渠道拆开', history: completedHistory(first),
    turnType: TURN_TYPES.CONTINUATION });
  assert.deepEqual(second.inheritedSlots.time.map(item => item.sourceText), ['2026年1月1日至2026年3月31日']);
  assert.deepEqual(second.inheritedSlots.filters.map(item => item.sourceText), ['华东']);
  const revised = createTurnContext({ question: '改查2026年4月1日至2026年4月15日',
    history: completedHistory(second), turnType: TURN_TYPES.REVISION });
  assert.deepEqual(revised.slots.time.map(item => item.sourceText), ['2026年4月1日至2026年4月15日']);
  assert.deepEqual(revised.inheritedSlots.filters.map(item => item.sourceText), ['华东']);
});

test('continuations keep the task id, advance the turn id and inherit field by field', () => {
  const first = createTurnContext({
    question: '查询本月含税销售金额',
    turnType: TURN_TYPES.NEW_TASK,
  });
  const second = createTurnContext({
    question: '那按渠道拆开呢',
    history: completedHistory(first),
    turnType: TURN_TYPES.CONTINUATION,
  });

  assert.equal(second.taskId, first.taskId);
  assert.equal(second.rootTaskId, first.rootTaskId);
  assert.notEqual(second.turnId, first.turnId);
  assert.equal(second.inheritDepth, 1);
  assert.deepEqual(Object.keys(second.inheritedSlots).sort(), ['metric', 'time']);
  assert.deepEqual(Object.keys(second.explicitSlots), ['dimensions']);
});

test('analysis wording is not captured as a dimension', () => {
  const slots = extractExplicitSlots(
    '26年9月份的业绩对比上月有什么变化？按照客户结构、品类等相关维度帮我分析下降或上升的主要因素',
  );

  assert.deepEqual(slots.dimensions.map((item) => item.value), ['客户结构', '品类']);
  assert.equal(
    slots.dimensions.some((item) => /分析|下降|上升|或/.test(item.value)),
    false,
  );
  assert.deepEqual(slots.analysisMode.map((item) => item.value), ['ATTRIBUTION']);
});

test('dimension separators and the adverb 分别 are not captured as fields', () => {
  const slots = extractExplicitSlots(
    '9月业绩环比下降，分别按客户名称和商品分类分析',
  );
  const values = slots.dimensions.map((item) => item.value);

  assert.deepEqual(values, ['客户名称', '商品分类']);
  assert.equal(values.some((value) => /分别|影响|分类分析/.test(value)), false);
});

test('complex analysis questions expose their breakdown dimensions', () => {
  const cases = [
    [
      '9月业绩环比下降，客户结构和品类结构分别影响多少',
      ['客户结构', '品类结构'],
    ],
    [
      '9月销售变化主要来自哪些客户，为什么',
      ['客户'],
    ],
    [
      '分析9月销售业绩变化，要求拆到客户和品类，给出主因',
      ['客户', '品类'],
    ],
    [
      '9月业绩环比怎么样？重点看客户和品类',
      ['客户', '品类'],
    ],
    [
      '9月销售额为什么下降，按品类、客户、省区、渠道拆分并给出影响金额',
      ['品类', '客户', '省区', '渠道'],
    ],
  ];

  for (const [question, expected] of cases) {
    const slots = extractExplicitSlots(question);
    assert.deepEqual(
      slots.dimensions.map((item) => item.value),
      expected,
      question,
    );
  }
});

test('inheritance budget caps both fields and consecutive turns', () => {
  const first = createTurnContext({
    question: '查询本月含税销售金额',
    turnType: TURN_TYPES.NEW_TASK,
  });
  const fieldBudget = createTurnContext({
    question: '按渠道拆开',
    history: completedHistory(first),
    turnType: TURN_TYPES.CONTINUATION,
    maxInheritedSlots: 1,
  });
  assert.deepEqual(Object.keys(fieldBudget.inheritedSlots), ['metric']);
  assert.equal(fieldBudget.inheritBudget.remainingSlots, 0);

  const depthBudget = createTurnContext({
    question: '那按周拆开呢',
    history: completedHistory(first),
    turnType: TURN_TYPES.CONTINUATION,
    maxInheritTurns: 0,
  });
  assert.equal(depthBudget.turnType, TURN_TYPES.NEW_TASK);
  assert.equal(depthBudget.reason, 'task_context_expired');
  assert.deepEqual(depthBudget.inheritedSlots, {});
});

test('forceNewTask ignores structured history even when the previous task is recent', () => {
  const first = createTurnContext({
    question: '查询本月含税销售金额',
    turnType: TURN_TYPES.NEW_TASK,
  });
  const forced = createTurnContext({
    question: '那按渠道拆开呢',
    history: completedHistory(first),
    turnType: TURN_TYPES.CONTINUATION,
    forceNewTask: true,
  });

  assert.equal(forced.turnType, TURN_TYPES.NEW_TASK);
  assert.notEqual(forced.taskId, first.taskId);
  assert.deepEqual(forced.inheritedSlots, {});
  assert.equal(forced.question, '那按渠道拆开呢');
});

test('memory defaults fill only relevant fields and never override explicit conditions', () => {
  const context = createTurnContext({
    question: '查询本月订单量',
    turnType: TURN_TYPES.NEW_TASK,
    memorySlots: {
      metric: [slot('含税销售金额', 'memory')],
      time: [slot('近7天', 'memory')],
      dimensions: [slot('渠道', 'memory')],
      analysisMode: [slot('ATTRIBUTION', 'memory')],
    },
  });

  assert.deepEqual(context.explicitSlots.time.map((item) => item.value), ['本月']);
  assert.equal(context.slots.metric[0].value, '本月订单量');
  assert.equal(context.memorySlots.dimensions, undefined, '未提及的记忆维度不能自动进入执行契约');
  assert.equal(context.memorySlots.analysisMode, undefined, '记忆中的执行模式不能污染普通问数');
  assert.equal(context.slots.time.some((item) => item.value === '近7天'), false);
});

test('explicit dimensions still bind normally when memory also defines them', () => {
  const context = createTurnContext({
    question: '查询本月各渠道订单量',
    turnType: TURN_TYPES.NEW_TASK,
    memorySlots: {
      dimensions: [slot('渠道', 'memory')],
    },
  });

  assert.deepEqual(context.explicitSlots.dimensions.map((item) => item.value), ['渠道']);
});

test('completed task state keeps identifiers and result lineage for the next turn', () => {
  const context = createTurnContext({
    question: '查询本月含税销售金额',
    turnType: TURN_TYPES.NEW_TASK,
  });
  const completed = completeTaskState({
    contextTask: context.taskState,
    answer: {
      resolvedQuestion: context.question,
      semanticParse: {
        metricFields: [{ sourceText: '含税销售金额' }],
        timeWindows: [{ sourceText: '本月' }],
      },
      queryFingerprint: 'fp-1',
      dataHash: 'hash-1',
    },
    artifactId: 'artifact-1',
    messageId: 'message-1',
  });

  assert.equal(completed.taskId, context.taskId);
  assert.equal(completed.turnId, context.turnId);
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.result.artifactId, 'artifact-1');
  assert.equal(completed.result.queryFingerprint, 'fp-1');
  assert.equal(completed.result.messageId, 'message-1');
});

test('a unit preference is an instruction, not a data query', () => {
  const context = resolveConversationContext('默认要带上单位万元', []);

  assert.equal(context.turnType, TURN_TYPES.INSTRUCTION);
  assert.equal(context.mode, 'INSTRUCTION');
  assert.equal(context.conversationDirective.unit, '万元');
  assert.equal(context.conversationDirective.scope, 'SESSION');
  assert.deepEqual(context.inheritedSlots, {});
  assert.deepEqual(context.slots, {});
  assert.deepEqual(context.memorySlots, {});
});

test('a unit phrase inside a real question stays in the query lane', () => {
  const context = resolveConversationContext('2026年9月销售额按万元展示', []);

  assert.equal(context.turnType, TURN_TYPES.NEW_TASK);
  assert.equal(context.conversationDirective, null);
});

test('a decimal precision follow-up is an instruction with no inherited query slots', () => {
  const first = createTurnContext({
    question: '查询2026年9月各省区业绩',
    turnType: TURN_TYPES.NEW_TASK,
  });
  const history = completedHistory(first);
  const context = resolveConversationContext('保留两位小数', history);

  assert.equal(context.turnType, TURN_TYPES.INSTRUCTION);
  assert.equal(context.mode, 'INSTRUCTION');
  assert.equal(context.conversationDirective.kind, 'DISPLAY_DECIMALS');
  assert.equal(context.conversationDirective.decimals, 2);
  assert.deepEqual(context.inheritedSlots, {});
  assert.deepEqual(context.slots, {});
});

test('instructions never inherit slots and are skipped when finding the previous task', () => {
  const first = createTurnContext({
    question: '查询本月含税销售金额',
    turnType: TURN_TYPES.NEW_TASK,
  });
  const history = completedHistory(first);
  const instruction = resolveConversationContext('以后统一按万元展示', history);
  history.push({
    role: 'user',
    content: instruction.originalQuestion,
  });
  history.push({
    role: 'assistant',
    content: '已记住',
    result: {
      taskState: completeTaskState({
        contextTask: instruction.taskState,
        answer: { resolvedQuestion: instruction.question },
      }),
    },
  });

  assert.deepEqual(instruction.inheritedSlots, {});
  assert.equal(previousTaskFromHistory(history).task.taskId, first.taskId);
});
