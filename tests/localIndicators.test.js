import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import { LocalIndicatorRepository } from '../src/localIndicatorRepository.js';

test('local indicator repository supports create, list, update and delete', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-local-indicators-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  const repository = new LocalIndicatorRepository(database.db);

  const created = repository.save({
    name: '本地销售额',
    bizName: 'local_sales_amount',
    typeId: 'business',
    typeName: '经营指标',
    indicatorLevel: 'ATOMIC',
    businessCaliber: '本地维护的销售额口径',
    metrics: [{ metricBizName: 'local_sales_amount', metricName: '本地销售额' }],
    dimensions: [{ dimensionBizName: 'region', dimensionName: '区域' }],
  });

  assert.match(created.id, /^local:/);
  assert.equal(repository.count(), 1);
  assert.equal(repository.get(created.id).name, '本地销售额');
  assert.deepEqual(repository.listTypes(), [{
    id: 'business',
    name: '经营指标',
    code: '',
    parentId: '',
  }]);

  const updated = repository.save({
    ...created,
    name: '本地含税销售额',
  }, created.id);
  assert.equal(updated.name, '本地含税销售额');
  assert.equal(repository.count(), 1);

  assert.equal(repository.delete(created.id), true);
  assert.equal(repository.count(), 0);
  database.close();
});
