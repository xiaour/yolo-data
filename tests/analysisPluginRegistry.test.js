import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeWithPlugins,
  enabledPluginsForPhase,
  resolveWithPlugins,
} from '../src/analysisPluginRegistry.js';

test('plugin registry exposes semantic resolver and result analyst', () => {
  assert.equal(enabledPluginsForPhase({}, 'SEMANTIC_RESOLVE').length, 1);
  assert.equal(enabledPluginsForPhase({}, 'RESULT_ANALYST').length, 1);

  const resolution = resolveWithPlugins({
    concept: 'margin',
    candidates: [{ id: '3', name: 'frontend_margin' }],
    policy: {
      metrics: [{
        id: 'gross_margin',
        concept: 'margin',
        aliases: ['frontend_margin'],
      }],
    },
  });
  assert.equal(resolution.adjudication.status, 'RESOLVED');

  const analysis = analyzeWithPlugins({
    columns: [{ name: '销售额', bizName: 'sale_amt', showType: 'NUMBER' }],
    rows: [{ sale_amt: 100 }],
  });
  assert.equal(analysis.facts.metricTotals[0].total, 100);
});
