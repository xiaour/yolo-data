import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANALYSIS_CLAIMS,
  ANALYSIS_CONTRACT_VERSION,
  ANALYSIS_RESULT_FILE,
  MAX_ANALYSIS_ROWS,
  buildAnalysisContractPrompt,
  normalizeAnalysisResult,
  summarizeAnalysisResult,
  validateAnalysisResult,
  summarizeAnalysisReport,
} from '../src/analysisContract.js';

function attributionPayload(overrides = {}) {
  return {
    version: ANALYSIS_CONTRACT_VERSION,
    kind: 'ATTRIBUTION',
    metric: { label: '含税销售额', unit: '万元', isRate: false },
    periods: { current: '本期', previous: '上期' },
    totals: { base: 150, current: 160, delta: 10 },
    rows: [
      { key: 'A', label: '渠道A', base: 100, current: 120, delta: 20, contribution: 20, share: 2, direction: 'INCREASE' },
      { key: 'B', label: '渠道B', base: 50, current: 40, delta: -10, contribution: -10, share: -1, direction: 'DECREASE' },
    ],
    claims: [{ code: 'ADDITIVE', row: 'contribution', total: 'delta' }],
    ...overrides,
  };
}

test('analysis result file and claim registry are stable', () => {
  assert.equal(ANALYSIS_RESULT_FILE, 'analysis.json');
  assert.deepEqual(
    ANALYSIS_CLAIMS.map((claim) => claim.code),
    ['ADDITIVE', 'SHARE_SUM', 'DELTA_CONSISTENT'],
  );
});

test('normalizeAnalysisResult coerces values and caps rows', () => {
  const normalized = normalizeAnalysisResult({
    kind: 'ATTRIBUTION',
    rows: [...Array(MAX_ANALYSIS_ROWS + 20).keys()].map((index) => ({
      key: `k${index}`, label: `标签${index}`, delta: String(index),
    })),
    totals: { delta: '12.5' },
  });
  assert.equal(normalized.rows.length, MAX_ANALYSIS_ROWS);
  assert.equal(normalized.rows[1].delta, 1);
  assert.equal(normalized.totals.delta, 12.5);
  assert.equal(normalized.totals.base, null);
  assert.equal(normalized.kind, 'ATTRIBUTION');
});

test('validateAnalysisResult accepts a payload whose declared additivity holds', () => {
  const validation = validateAnalysisResult(attributionPayload());
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.issues, []);
  assert.equal(validation.claims.length, 1);
  assert.equal(validation.claims[0].verified, true);
});

test('validateAnalysisResult rejects a payload that violates declared additivity', () => {
  const validation = validateAnalysisResult(attributionPayload({
    rows: [
      { key: 'A', label: '渠道A', base: 100, current: 120, delta: 20, contribution: 20 },
      { key: 'B', label: '渠道B', base: 50, current: 40, delta: -10, contribution: -5 },
    ],
  }));
  assert.equal(validation.valid, false);
  const additivity = validation.issues.find((item) => item.code === 'ANALYSIS-ADDITIVITY');
  assert.ok(additivity);
  assert.equal(additivity.residual, 5);
  assert.equal(validation.claims[0].verified, false);
});

test('validateAnalysisResult verifies share normalisation and delta consistency', () => {
  // 带符号份额（占净变化）之和为 1 是合法语义：2 + (-1) = 1。
  const signedShares = validateAnalysisResult(attributionPayload({
    claims: [{ code: 'SHARE_SUM', scale: 1 }],
  }));
  assert.equal(signedShares.valid, true);

  const shareBroken = validateAnalysisResult(attributionPayload({
    rows: [
      { key: 'A', label: '渠道A', base: 100, current: 120, delta: 20, contribution: 20, share: 0.5 },
      { key: 'B', label: '渠道B', base: 50, current: 40, delta: -10, contribution: -10, share: 0.2 },
    ],
    claims: [{ code: 'SHARE_SUM', scale: 1 }],
  }));
  assert.equal(shareBroken.valid, false);
  assert.ok(shareBroken.issues.some((item) => item.code === 'ANALYSIS-SHARE-SUM'));

  const deltaBroken = validateAnalysisResult(attributionPayload({
    rows: [{ key: 'A', label: '渠道A', base: 100, current: 120, delta: 5 }],
    claims: [{ code: 'DELTA_CONSISTENT' }],
  }));
  assert.equal(deltaBroken.valid, false);
  assert.ok(deltaBroken.issues.some((item) => item.code === 'ANALYSIS-DELTA-CONSISTENT'));
});

test('validateAnalysisResult catches inconsistent totals and non-finite numbers', () => {
  const totalsBroken = validateAnalysisResult(attributionPayload({
    totals: { base: 150, current: 160, delta: 99 },
  }));
  assert.equal(totalsBroken.valid, false);
  assert.ok(totalsBroken.issues.some((item) => item.code === 'ANALYSIS-TOTALS'));

  const nonFinite = validateAnalysisResult(attributionPayload({
    rows: [{ key: 'A', label: '渠道A', base: 100, current: 120, delta: 20, contribution: Infinity }],
  }));
  assert.equal(nonFinite.valid, false);
  assert.ok(nonFinite.issues.some((item) => item.code === 'ANALYSIS-NON-FINITE'));
});

test('validateAnalysisResult warns on unknown claims without blocking', () => {
  const validation = validateAnalysisResult(attributionPayload({
    claims: [{ code: 'SHAPLEY_EXACT' }],
  }));
  assert.equal(validation.valid, true);
  const warning = validation.issues.find((item) => item.code === 'ANALYSIS-UNKNOWN-CLAIM');
  assert.equal(warning.level, 'warning');
});

test('validateAnalysisResult rejects empty results', () => {
  const validation = validateAnalysisResult({ kind: 'ATTRIBUTION', rows: [] });
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((item) => item.code === 'ANALYSIS-EMPTY'));
});

test('buildAnalysisContractPrompt describes the sandbox output contract', () => {
  const prompt = buildAnalysisContractPrompt();
  assert.match(prompt, /output\/analysis\.json/);
  assert.match(prompt, /ADDITIVE/);
  assert.match(prompt, /SHARE_SUM/);
  assert.match(prompt, /DELTA_CONSISTENT/);
  // 契约只描述结构与断言，不应教授任何具体分析方法。
  assert.doesNotMatch(prompt, /毛利率|日配|大区/);
});

test('summarizeAnalysisResult ranks rows by contribution without inventing numbers', () => {
  const validation = validateAnalysisResult(attributionPayload({
    rows: [
      { key: 'A', label: '渠道A', delta: 20, contribution: 20, share: 2 },
      { key: 'B', label: '渠道B', delta: -10, contribution: -10, share: -1 },
      { key: 'C', label: '渠道C', delta: 60, contribution: 60, share: 6 },
    ],
    totals: { base: 150, current: 240, delta: 90 },
    claims: [],
  }));
  const text = summarizeAnalysisResult(validation);
  assert.match(text, /分析类型：ATTRIBUTION/);
  assert.match(text, /总变化：90/);
  const lines = text.split('\n');
  assert.match(lines[2], /渠道C/);
});

test('report findings must reference existing rows and supported opportunities need evidence', () => {
  const validation = validateAnalysisResult(attributionPayload({
    executiveSummary: '渠道A增长，渠道B下降。',
    findings: [{
      id: 'f1', title: '渠道B下降', statement: '渠道B下降10',
      evidenceRefs: ['row:B'], status: 'SUPPORTED', confidence: 'HIGH',
    }],
    opportunities: [{
      id: 'o1', title: '挽回渠道B', rationale: '渠道B同比下降', action: '核查客户流失原因',
      evidenceRefs: ['row:B'], status: 'SUPPORTED', confidence: 'MEDIUM',
    }],
    limitations: ['同期变化不能单独证明因果。'],
  }));
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  const report = summarizeAnalysisReport(validation);
  assert.match(report, /关键发现/);
  assert.match(report, /机会与行动/);
  assert.match(report, /同期变化不能单独证明因果/);

  const invalid = validateAnalysisResult(attributionPayload({
    findings: [{
      id: 'f1', title: '不存在的分组', statement: '错误引用',
      evidenceRefs: ['row:missing'], status: 'SUPPORTED', confidence: 'HIGH',
    }],
    opportunities: [{
      id: 'o1', title: '无依据机会', rationale: '没有数据依据', action: '直接投入',
      evidenceRefs: [], status: 'SUPPORTED', confidence: 'HIGH',
    }],
  }));
  assert.equal(invalid.valid, false);
  assert.ok(invalid.issues.some((item) => item.code === 'ANALYSIS-EVIDENCE-REF'));
  assert.ok(invalid.issues.some((item) => item.code === 'ANALYSIS-OPPORTUNITY-EVIDENCE'));
});

test('an unproven opportunity is allowed only when labelled as a hypothesis', () => {
  const validation = validateAnalysisResult(attributionPayload({
    opportunities: [{
      id: 'o1', title: '验证渠道触达', rationale: '现有快照没有触达数据',
      action: '补充触达和复购字段后验证', evidenceRefs: [],
      status: 'HYPOTHESIS', confidence: 'LOW',
    }],
  }));
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
});

test('report validation requires an executive summary and evidence-backed findings', () => {
  const validation = validateAnalysisResult(attributionPayload(), { requireReport: true });
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((item) => item.code === 'ANALYSIS-REPORT-SUMMARY'));
  assert.ok(validation.issues.some((item) => item.code === 'ANALYSIS-REPORT-FINDINGS'));
});

test('report evidence row keys must be unique', () => {
  const validation = validateAnalysisResult(attributionPayload({
    rows: [
      { key: 'A', label: '渠道A-1', delta: 1 },
      { key: 'A', label: '渠道A-2', delta: 2 },
    ],
    totals: { base: null, current: null, delta: 3 },
    claims: [],
  }));
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((item) => item.code === 'ANALYSIS-ROW-KEY-DUPLICATE'));
});
