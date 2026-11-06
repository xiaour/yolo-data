import assert from 'node:assert/strict';
import test from 'node:test';

import { composeAnswerMessage } from '../src/answerComposer.js';

test('answer composer gives clarification precedence over narrative and warnings', () => {
  const result = composeAnswerMessage({
    deterministicMessage: '可信结果',
    analysisText: '分析补充',
    validationWarnings: ['校验提示'],
    clarification: { prompt: '请选择华东或华南' },
  });
  assert.equal(result.finalMessage, '请选择华东或华南');
});

test('answer composer combines grounded summary and validation warnings', () => {
  const result = composeAnswerMessage({
    deterministicMessage: '销售额为 10 万元。',
    analysisText: '较上期增长。',
    validationWarnings: ['时间范围完整'],
  });
  assert.equal(result.baseMessage, '销售额为 10 万元。');
  assert.match(result.finalMessage, /时间范围完整/);
});

test('empty semantic fast path errors do not hide the model error message', () => {
  const result = composeAnswerMessage({
    semanticFastPathError: new Error(''),
    harnessContent: '指标平台模块已停用，请使用业务数据集。',
  });
  assert.equal(result.finalMessage, '指标平台模块已停用，请使用业务数据集。');
});
