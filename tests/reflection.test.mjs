import { test } from 'node:test';
import assert from 'node:assert/strict';
import { responsesText } from './fixtures/responsesApi.js';

import {
  reflectOnAnswer,
  createHarnessJudge,
  checkAnswerable,
  checkNumericConsistency,
  checkStrategySound,
  REFLECTION_VERSION,
} from '../src/reflection.js';

const RESULT = {
  columns: [{ name: 'customer_name' }, { name: 'sale_amt' }],
  rows: [
    { customer_name: '客户A', sale_amt: 1234567.89 },
    { customer_name: '客户B', sale_amt: 234567.0 },
  ],
};

test('REFLECTION_VERSION is defined', () => {
  assert.equal(typeof REFLECTION_VERSION, 'string');
});

test('① answerable passes when data present and answer is substantive', () => {
  const r = checkAnswerable({
    question: '本月销售额前10客户',
    answer: '本月销售额最高的客户是客户A，金额约123.45万元。',
    result: RESULT,
  });
  assert.equal(r.pass, true);
  assert.equal(r.refusalWithData, false);
});

test('① answerable fails when model declines despite having data', () => {
  const r = checkAnswerable({
    question: '本月销售额',
    answer: '抱歉，我无法确定您要查询的口径，请补充主题提示词后再试。',
    result: RESULT,
  });
  assert.equal(r.pass, false);
  assert.equal(r.refusalWithData, true);
});

test('① answerable is a no-op (pass) when there is no data', () => {
  const r = checkAnswerable({
    question: '本月销售额',
    answer: '需要进一步澄清。',
    result: { columns: [], rows: [] },
  });
  assert.equal(r.pass, true);
});

test('② numeric passes when headline matches locked result magnitude', () => {
  const r = checkNumericConsistency({
    answer: '客户A本月销售额 123.45 万元，客户B 23.46 万元。',
    result: RESULT,
  });
  assert.equal(r.pass, true);
});

test('② numeric fails when headline is wildly off (fabrication / unit error)', () => {
  const r = checkNumericConsistency({
    answer: '本月总销售额高达 1.23 亿元，远超历史水平。',
    result: RESULT,
  });
  assert.equal(r.pass, false);
});

test('② numeric passes when answer has no significant numbers', () => {
  const r = checkNumericConsistency({
    answer: '已为您查询到相关结果，详见下方表格。',
    result: RESULT,
  });
  assert.equal(r.pass, true);
});

test('② numeric accepts a headline expressed in the display scale', () => {
  const r = checkNumericConsistency({
    answer: '含税销售额（万元）合计 2,116。',
    result: {
      columns: [{
        name: '含税销售额（万元）',
        bizName: 'sale_amt',
        displayScale: 0.0001,
        role: 'METRIC',
      }],
      rows: [
        { sale_amt: 15000000 },
        { sale_amt: 6157903 },
      ],
    },
  });
  assert.equal(r.pass, true);
});

test('③ strategy sound degrades (no replan) when no judge supplied', async () => {
  const r = await checkStrategySound({
    question: '本月销售额',
    answer: '本月销售额为123.45万元。',
    result: RESULT,
    judge: null,
  });
  assert.equal(r.judgeUsed, false);
  assert.equal(r.degraded, true);
  assert.equal(r.needsReplan, false);
  assert.equal(r.pass, true);
});

test('③ strategy sound uses judge verdict (needsReplan triggers hint)', async () => {
  const judge = async () => JSON.stringify({
    answersQuestion: false,
    consistentWithData: false,
    needsReplan: true,
    reason: '回答跑偏',
    hint: '应改按 customer_name 维度拆分而非整体求和',
  });
  const r = await checkStrategySound({
    question: '各客户销售额',
    answer: '整体销售额见上。',
    result: RESULT,
    judge,
  });
  assert.equal(r.judgeUsed, true);
  assert.equal(r.needsReplan, true);
  assert.equal(r.hint, '应改按 customer_name 维度拆分而非整体求和');
});

test('③ strategy sound degrades when the judge exceeds its latency budget', async () => {
  const r = await checkStrategySound({
    question: '本月销售额',
    answer: '本月销售额为123.45万元。',
    result: RESULT,
    judge: () => new Promise(() => {}),
    timeoutMs: 10,
  });

  assert.equal(r.pass, true);
  assert.equal(r.judgeUsed, true);
  assert.equal(r.degraded, true);
  assert.equal(r.needsReplan, false);
  assert.match(r.detail, /超时/);
});

for (const field of ['answersQuestion', 'consistentWithData', 'needsReplan']) {
  for (const [name, value] of [
    ['missing', undefined], ['null', null], ['string true', 'true'],
    ['string false', 'false'], ['number', 1], ['object', {}], ['array', []],
  ]) {
    test(`③ strategy sound degrades without replanning when ${field} is ${name}`, async () => {
      const verdict = { answersQuestion: true, consistentWithData: true, needsReplan: false };
      verdict[field] = value;
      const r = await checkStrategySound({
        question: '本月销售额', answer: '本月销售额为123.45万元。', result: RESULT,
        judge: async () => JSON.stringify(verdict),
      });
      assert.equal(r.degraded, true);
      assert.equal(r.judgeUsed, true);
      assert.equal(r.pass, true);
      assert.equal(r.needsReplan, false);
      assert.equal(r.hint, '');
      assert.equal(r.reason, '');
    });
  }
}

for (const { name, text, pass, needsReplan, reason, hint } of [
  {
    name: 'positive without optional text',
    text: '{"answersQuestion":true,"consistentWithData":true,"needsReplan":false}',
    pass: true, needsReplan: false, reason: '', hint: '',
  },
  {
    name: 'negative without optional text',
    text: '{"answersQuestion":false,"consistentWithData":false,"needsReplan":true}',
    pass: false, needsReplan: true, reason: '', hint: '',
  },
  {
    name: 'fenced JSON with prose, optional text and extra properties',
    text: 'Verdict follows:\n```json\n{"answersQuestion":true,"consistentWithData":false,"needsReplan":true,"reason":"数字不符","hint":"重查销售额","extra":"allowed"}\n```\nDone.',
    pass: false, needsReplan: true, reason: '数字不符', hint: '重查销售额',
  },
  {
    name: 'optional text coercion',
    text: '{"answersQuestion":true,"consistentWithData":true,"needsReplan":false,"reason":123,"hint":null}',
    pass: true, needsReplan: false, reason: '123', hint: '',
  },
]) {
  test(`③ strategy sound accepts a complete boolean verdict: ${name}`, async () => {
    const r = await checkStrategySound({
      question: '本月销售额', answer: '本月销售额为123.45万元。', result: RESULT,
      judge: async () => text,
    });
    assert.equal(r.degraded, false);
    assert.equal(r.judgeUsed, true);
    assert.equal(r.pass, pass);
    assert.equal(r.needsReplan, needsReplan);
    assert.equal(r.reason, reason);
    assert.equal(r.hint, hint);
  });
}

test('reflectOnAnswer: malformed judge retains numeric failure without triggering a strategy replan', async () => {
  const r = await reflectOnAnswer({
    question: '本月销售额', answer: '本月总销售额高达 1.23 亿元。', result: RESULT,
    judge: async () => '{"answersQuestion":true,"consistentWithData":true,"needsReplan":"false"}',
  });
  assert.equal(r.degraded, true);
  assert.equal(r.judgeUsed, true);
  assert.equal(r.passed, false);
  assert.equal(r.checks.find((c) => c.name === 'numeric_consistency').pass, false);
  assert.equal(r.needsReplan, false);
  assert.equal(r.hint, null);
});

test('reflectOnAnswer: malformed judge retains refusal-with-data replanning', async () => {
  const r = await reflectOnAnswer({
    question: '本月销售额', answer: '抱歉，我无法确定您要查询的口径。', result: RESULT,
    judge: async () => '{"answersQuestion":true}',
  });
  assert.equal(r.degraded, true);
  assert.equal(r.judgeUsed, true);
  assert.equal(r.passed, false);
  assert.equal(r.checks.find((c) => c.name === 'answerable').refusalWithData, true);
  assert.equal(r.needsReplan, true);
  assert.ok(r.hint.includes('不要反问或歉意式拒答'));
});

test('reflectOnAnswer: clean answer passes without replan (no judge)', async () => {
  const r = await reflectOnAnswer({
    question: '本月销售额前10客户',
    answer: '本月销售额最高的客户是客户A，金额约123.45万元。',
    result: RESULT,
    judge: null,
  });
  assert.equal(r.passed, true);
  assert.equal(r.needsReplan, false);
  assert.equal(r.hint, null);
  assert.equal(r.checks.length, 3);
});

test('reflectOnAnswer: numeric mismatch is recorded (failed) but does not auto-replan without a judge', async () => {
  const r = await reflectOnAnswer({
    question: '本月销售额',
    answer: '本月总销售额高达 1.23 亿元。',
    result: RESULT,
    judge: null,
  });
  assert.equal(r.passed, false);
  assert.equal(r.needsReplan, false);
  assert.equal(r.hint, null);
  const numeric = r.checks.find((c) => c.name === 'numeric_consistency');
  assert.equal(numeric.pass, false);
});

test('reflectOnAnswer: judge needsReplan drives replan with hint', async () => {
  const judge = async () => JSON.stringify({
    answersQuestion: false,
    consistentWithData: false,
    needsReplan: true,
    reason: '跑偏',
    hint: '改按 customer_name 拆分而非整体求和',
  });
  const r = await reflectOnAnswer({
    question: '各客户销售额',
    answer: '整体销售额见上。',
    result: RESULT,
    judge,
  });
  assert.equal(r.needsReplan, true);
  assert.equal(r.hint, '改按 customer_name 拆分而非整体求和');
});

test('reflectOnAnswer: refusal-with-data triggers replan even without a judge', async () => {
  const r = await reflectOnAnswer({
    question: '本月销售额',
    answer: '抱歉，我无法确定您要查询的口径，请补充主题提示词后再试。',
    result: RESULT,
    judge: null,
  });
  assert.equal(r.needsReplan, true);
  assert.ok(r.hint && r.hint.length > 0);
});

test('reflectOnAnswer: no-data clarification does not trigger replan', async () => {
  const r = await reflectOnAnswer({
    question: '本月销售额',
    answer: '请补充时间范围。',
    result: { columns: [], rows: [] },
    judge: null,
  });
  assert.equal(r.passed, true);
  assert.equal(r.needsReplan, false);
});

test('createHarnessJudge returns null for local-rule harness', () => {
  const fakeRule = { mode: 'local-rule', run: async () => ({}) };
  assert.equal(createHarnessJudge(fakeRule), null);
});

test('createHarnessJudge wraps a real harness via side-effect-free chat', async () => {
  const calls = [];
  const fakeReal = {
    mode: 'responses',
    chat: async (messages, tools, metadata) => {
      calls.push({ messages, tools, metadata });
      return responsesText('{"answersQuestion":true,"consistentWithData":true,"needsReplan":false,"reason":"ok","hint":""}');
    },
  };
  const judge = createHarnessJudge(fakeReal);
  assert.equal(typeof judge, 'function');
  const out = await judge('SYS', 'USR');
  assert.equal(out, '{"answersQuestion":true,"consistentWithData":true,"needsReplan":false,"reason":"ok","hint":""}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tools.length, 0);
  assert.equal(calls[0].messages[0].role, 'system');
});
