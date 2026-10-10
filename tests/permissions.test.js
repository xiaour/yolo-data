import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import {
  applyColumnPolicies,
  assertRowPoliciesSupported,
  enforceRowPolicies,
  resolveAccessScope,
} from '../src/permissions.js';

function createDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-permissions-'));
  return new PlatformDatabase(path.join(directory, 'test.db'));
}

test('theme scope intersects theme indicators with explicit user grants', () => {
  const database = createDatabase();
  const user = database.getUserByUsername('east_manager');
  const theme = database.listThemes().find((item) => item.name === '经营总览');
  const indicators = [
    { id: 'sales_amount' },
    { id: 'order_count' },
    { id: 'gross_margin_rate' },
    { id: 'gross_profit' },
  ];
  const profile = database.getPermissionProfile(user.id);
  profile.indicatorGrants = [
    { indicatorId: 'sales_amount', canQuery: true },
    { indicatorId: 'order_count', canQuery: true },
    { indicatorId: 'gross_margin_rate', canQuery: true },
  ];
  database.replacePermissionProfile(user.id, profile);
  const scope = resolveAccessScope({
    user,
    theme,
    indicators,
    permissionProfile: database.getPermissionProfile(user.id),
  });
  assert.equal(scope.allowed, true);
  assert.deepEqual(scope.allowedIndicatorIds, [
    'sales_amount',
    'order_count',
    'gross_margin_rate',
  ]);
  assert.equal(scope.rowPolicies.length, 1);
  assert.equal(scope.rowPolicies[0].dimension, 'region');
});

test('forced row policies override agent requested filters', () => {
  const filters = enforceRowPolicies(
    [{ bizName: 'region', operator: 'IN', value: ['华南'] }],
    [{ dimension: 'region', operator: 'IN', values: ['华东'] }],
  );
  assert.deepEqual(filters, [{ bizName: 'region', operator: 'IN', value: ['华东'] }]);
});

test('row policies fail closed when no value can be resolved', () => {
  assert.throws(
    () => enforceRowPolicies([], [{
      dimension: 'region',
      operator: 'IN',
      values: [],
      valueSource: 'USER_ATTRIBUTE',
      attributeKey: 'region',
    }]),
    /no resolvable value/,
  );
});

test('column policies hide or mask configured result columns', () => {
  const columns = [
    { name: '手机号', bizName: 'phone' },
    { name: 'customer_name', bizName: 'customer_name' },
  ];
  const rows = [
    { phone: '13800000000', customer_name: '示例客户' },
  ];
  const result = applyColumnPolicies(columns, rows, [
    { columnName: 'phone', action: 'MASK', maskValue: '138****0000', enabled: true },
    { columnName: 'customer_name', action: 'HIDE', enabled: true },
  ]);
  assert.equal(result.columns.length, 1);
  assert.deepEqual(result.rows[0], { phone: '138****0000' });
});

test('row policy save guard accepts missing, default and padded operators', () => {
  assertRowPoliciesSupported([
    { dimension: 'region', operator: 'IN', values: ['east'] },
    { dimension: 'amount', operator: '>=', value: 100 },
    { dimension: 'memo', operator: ' like ', value: 'a%' },
    { dimension: 'city' },
  ]);
});

test('row policy save guard rejects unsupported operators as a 400 error', () => {
  assert.throws(
    () => assertRowPoliciesSupported([{ dimension: 'region', operator: 'EQ', values: ['east'] }]),
    (error) => error.statusCode === 400
      && error.code === 'ROW_POLICY_OPERATOR_UNSUPPORTED'
      && /EQ/.test(error.message),
  );
  assert.throws(
    () => assertRowPoliciesSupported([{ dimension: 'region', operator: 'BETWEEN' }]),
    (error) => error.statusCode === 400 && /BETWEEN/.test(error.message),
  );
});
