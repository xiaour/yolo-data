import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { dialectDataset } from './fixtures/dialectDataset.js';
import { enforceRowPolicies } from '../src/permissions.js';

for (const operator of ['IN', 'NOT_IN']) {
  for (const scope of ['ROW', 'AGGREGATE', 'METRIC']) {
    test(`${scope} ${operator} empty set has the correct truth value`, t => {
      const sql = new DatabaseSync(':memory:');
      t.after(() => sql.close());
      sql.exec("CREATE TABLE sales (region TEXT, amount REAL); INSERT INTO sales VALUES ('east',10),('west',20),(NULL,30)");
      const { service } = dialectDataset('MYSQL', 'main');
      const filter = { field: scope === 'AGGREGATE' ? 'amount' : 'region', operator, value: [], scope };
      const request = {
        metrics: [{ field: 'amount', ...(scope === 'METRIC' ? { predicateFilters: [filter] } : {}) }],
        dimensions: ['region'],
        filters: scope === 'METRIC' ? [] : [filter],
      };
      const compiled = service.buildQuery(1, request);
      const rows = sql.prepare(compiled.sql).all(...compiled.values);
      if (scope === 'METRIC') {
        assert.equal(rows.length, 3);
        assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), operator === 'NOT_IN' ? 60 : 0);
      } else {
        assert.equal(rows.length, operator === 'NOT_IN' ? 3 : 0);
      }
    });
  }
}

test('an empty exclusion preserves enforced row restrictions and parameter order', t => {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  sql.exec("CREATE TABLE sales (region TEXT, amount REAL, order_id TEXT); INSERT INTO sales VALUES ('east',10,'1'),('west',20,'2')");
  const { service } = dialectDataset('MYSQL', 'main');
  const enforced = enforceRowPolicies([], [{ dimension: 'region', operator: 'IN', values: ['east'] }]);
  const compiled = service.buildQuery(1, {
    metrics: ['amount'], dimensions: ['region'],
    filters: [
      ...enforced.map(({ bizName, ...filter }) => ({ ...filter, field: bizName })),
      { field: 'order_id', operator: 'NOT_IN', value: [] },
    ],
  });
  assert.deepEqual(compiled.values, ['east', 200]);
  assert.deepEqual(sql.prepare(compiled.sql).all(...compiled.values).map(row => ({ ...row })), [{ region: 'east', amount: 10 }]);
});

test('empty row-policy values still fail closed for both set operators', () => {
  for (const operator of ['IN', 'NOT_IN']) {
    assert.throws(() => enforceRowPolicies([], [{ dimension: 'region', operator, values: [] }]), /no resolvable value/);
  }
});
