import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildContractSourceContext,
  resolveBoundDatasetDimensions,
} from '../src/agent.js';
import { resolveConversationContext } from '../src/queryIntent.js';

test('independent questions do not leak previous time conditions into contract binding', () => {
  const history = [
    { role: 'user', content: '本月重点客户组的业绩是多少' },
    { role: 'assistant', content: '本月重点客户组含税销售额为 10,358.83 万元。' },
  ];
  const question = '今年重点客户组每个月的业绩趋势';
  const context = resolveConversationContext(question, history);
  const sourceContext = buildContractSourceContext({
    inheritQueryContext: context.inheritQueryContext,
    history,
    resolvedQuestion: context.question,
  });

  assert.equal(context.mode, 'INDEPENDENT');
  assert.equal(context.inheritQueryContext, false);
  assert.equal(sourceContext, question);
  assert.equal(sourceContext.includes('本月'), false);
});

test('follow-up questions keep the inherited binding context', () => {
  const history = [
    { role: 'user', content: '本月重点客户组的业绩是多少' },
    { role: 'assistant', content: '本月重点客户组含税销售额为 10,358.83 万元。' },
  ];
  const question = '那按周拆开呢';
  const context = resolveConversationContext(question, history);
  const sourceContext = buildContractSourceContext({
    inheritQueryContext: context.inheritQueryContext,
    history,
    resolvedQuestion: context.question,
  });

  assert.equal(context.mode, 'FOLLOW_UP');
  assert.equal(context.inheritQueryContext, true);
  assert.match(sourceContext, /本月重点客户组的业绩是多少/);
  assert.match(sourceContext, /那按周拆开呢/);
});

test('bound dataset dimensions keep the time field required for trend grouping', () => {
  const dimensions = resolveBoundDatasetDimensions({
    dimensionFields: [
      { field: 'sale_time', isTime: true, timeGrain: 'MONTH' },
      { field: 'performance_region_name', isTime: false },
    ],
  });

  assert.deepEqual(dimensions, [
    'sale_time',
    'performance_region_name',
  ]);
});
