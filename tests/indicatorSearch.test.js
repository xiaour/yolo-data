import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeBusinessTerm,
  rankIndicators,
  sortIndicators,
} from '../src/indicatorSearch.js';

test('business term normalization only compacts text', () => {
  assert.equal(normalizeBusinessTerm(' 含税销售金额 '), '含税销售金额');
  assert.equal(normalizeBusinessTerm('ABC_金额'), 'abc_金额');
});

test('indicator ranking is stable and prefers the semantic match', () => {
  const indicators = [
    { id: '10', name: '销售数量' },
    { id: '2', name: '含税销售金额' },
    { id: '6', name: '不含税销售金额' },
  ];
  const ranked = rankIndicators(indicators, '查询华东含税销售金额', 3);
  assert.equal(ranked[0].indicator.name, '含税销售金额');
  assert.deepEqual(
    sortIndicators(indicators).map((indicator) => indicator.id),
    ['2', '6', '10'],
  );
});

test('synonym expansion is not hardcoded into indicator search', () => {
  const ranked = rankIndicators([
    { id: '6', name: '不含税销售金额' },
    { id: '2', name: '含税销售金额' },
  ], '本月重点客户组业务的销售额', 2);

  assert.equal(ranked.length, 0);
});
