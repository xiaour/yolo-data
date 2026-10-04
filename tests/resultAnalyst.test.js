import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeResultFacts,
  buildResultAnalysisText,
} from '../src/resultAnalyst.js';

test('result analyst produces totals, topN, trend and anomalies', () => {
  const facts = analyzeResultFacts({
    columns: [
      { name: '月份', bizName: 'month', showType: 'CATEGORY' },
      { name: '销售额', bizName: 'sale_amt', showType: 'NUMBER' },
    ],
    rows: [
      { month: '2026-01', sale_amt: 100 },
      { month: '2026-02', sale_amt: 130 },
      { month: '2026-03', sale_amt: 210 },
    ],
    topLimit: 2,
  });
  assert.equal(facts.rowCount, 3);
  assert.equal(facts.metricTotals[0].total, 440);
  assert.equal(facts.topBottom[0].top[0].label, '2026-03');
  assert.equal(facts.trends[0].lastValue, 210);
  assert.equal(facts.trends[0].change, 110);
  assert.match(buildResultAnalysisText(facts), /TOP2/);
  assert.match(buildResultAnalysisText(facts), /趋势/);
});

test('result analyst does not sum percentage columns', () => {
  const facts = analyzeResultFacts({
    columns: [
      { name: '区域', bizName: 'region', showType: 'CATEGORY' },
      { name: '毛利率', bizName: 'margin', showType: 'NUMBER', presentationType: 'percent', unit: '%' },
    ],
    rows: [{ region: '华东', margin: 0.2 }],
  });
  assert.equal(facts.metricTotals.length, 0);
  assert.equal(facts.primaryValues[0].value, 0.2);
  assert.match(buildResultAnalysisText(facts), /毛利率 20\.00%/);
});

test('result analyst renders totals with the presentation contract', () => {
  const facts = analyzeResultFacts({
    columns: [
      {
        name: '含税销售额（万元）',
        bizName: 'sale_amt',
        showType: 'NUMBER',
        presentationType: 'amount',
        displayScale: 0.0001,
        displayDecimals: 0,
      },
    ],
    rows: [
      { sale_amt: 173_519_927.79 },
      { sale_amt: 1_037_903_310.75 },
    ],
  });
  const text = buildResultAnalysisText(facts);
  // 表头已经是万元，正文不能再出现原始元值。
  assert.match(text, /含税销售额（万元）合计 121,142/);
  assert.doesNotMatch(text, /173_?519_?927|173519927/);
});
