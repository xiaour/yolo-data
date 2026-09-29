import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSemanticTaxonomyPrompt,
  classifyAnalysisSemantics,
} from '../src/analysisSemantics.js';

test('analysis semantics classifies structural and analytical conditions', () => {
  const profile = classifyAnalysisSemantics(
    '月至今的标准配送按management_category拆分，排名前10，并对比上月趋势',
    new Date('2026-09-22T03:00:00Z'),
  );
  const codes = profile.categories.map((item) => item.code);
  assert.ok(codes.includes('TIME_WINDOW'));
  assert.ok(codes.includes('DIMENSION'));
  assert.ok(codes.includes('RANKING'));
  assert.ok(codes.includes('COMPARISON'));
  assert.ok(codes.includes('TREND'));
  assert.equal(
    profile.categories.find((item) => item.code === 'TIME_WINDOW').startDate,
    '2026-09-01',
  );
});

test('analysis semantics exposes a model-facing taxonomy prompt', () => {
  const prompt = buildSemanticTaxonomyPrompt();
  assert.match(prompt, /时间范围/);
  assert.match(prompt, /拆解维度/);
  assert.match(prompt, /排名与上限/);
  assert.match(prompt, /平台可自动补全/);
});
