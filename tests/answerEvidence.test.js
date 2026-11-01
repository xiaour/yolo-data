import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAnswerEvidence,
  looksLikeDataClaim,
  requiresGroundedAnswer,
} from '../src/answerEvidence.js';

test('answer evidence requires a contract, fingerprint and data hash', () => {
  const complete = buildAnswerEvidence({
    semanticParse: { queryContract: { id: 'contract-1' } },
    data: { columns: [{ name: 'value' }], rows: [{ value: 1 }] },
    queryFingerprint: 'fingerprint',
    dataHash: 'hash',
  });
  assert.equal(complete.grounded, true);
  assert.equal(complete.rowCount, 1);
  assert.equal(complete.columnCount, 1);
  assert.equal(buildAnswerEvidence({ data: { rows: [{ value: 1 }] } }).grounded, false);
  assert.equal(buildAnswerEvidence({
    semanticParse: { queryContract: { id: 'contract-empty' } },
    data: { columns: [{ name: 'value' }], rows: [] },
    queryFingerprint: 'fingerprint-empty',
    dataHash: 'hash-empty',
  }).grounded, true);
});

test('grounding only applies to data analysis turns with no clarification', () => {
  assert.equal(requiresGroundedAnswer({ analysisMode: { mode: 'ATTRIBUTION' } }), true);
  assert.equal(requiresGroundedAnswer({
    analysisMode: { mode: 'ATTRIBUTION' },
    hasClarification: true,
  }), false);
  assert.equal(requiresGroundedAnswer({
    analysisMode: { mode: 'METRIC_QUERY' },
    contextReason: 'result_reference',
  }), false);
});

test('data-claim detection keeps explanations and clarifications intact', () => {
  assert.equal(looksLikeDataClaim('指标平台尚未配置，无法执行真实指标查询。'), false);
  assert.equal(looksLikeDataClaim('请继续补充查询条件。'), false);
  assert.equal(looksLikeDataClaim('2026年9月包含30天。'), false);
  assert.equal(looksLikeDataClaim('2026年9月销售额为 1,234 万元。'), true);
  assert.equal(looksLikeDataClaim('销售额环比下降 8.4%。'), true);
  assert.equal(looksLikeDataClaim('| 客户 | 金额 |\n|---|---|\n| A | 10 |'), true);
});
