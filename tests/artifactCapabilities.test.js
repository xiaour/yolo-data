import assert from 'node:assert/strict';
import test from 'node:test';
import {
  artifactCanSatisfy,
  buildArtifactCapabilities,
  decideArtifactStrategy,
} from '../src/artifactCapabilities.js';

test('artifact capabilities describe row grain, metrics and derived fields', () => {
  const capabilities = buildArtifactCapabilities({
    sourceType: 'BUSINESS_DATASET',
    source: { id: 3, name: 'sales_fact' },
    data: {
      columns: [
        { name: '销售省区', bizName: 'province_name', showType: 'CATEGORY' },
        { name: '含税销售额', bizName: 'sale_amt', showType: 'NUMBER' },
        { name: '毛利率', bizName: 'gross_margin', showType: 'NUMBER' },
      ],
      rows: [{ province_name: '江苏', sale_amt: 100, gross_margin: 0.08 }],
    },
    semanticParse: {
      dimensions: ['province_name'],
      metrics: ['sale_amt'],
      timeGrain: 'MONTH',
      dateInfo: {
        startDate: '2026-08-01',
        endDate: '2026-08-31',
        field: 'sales_date',
      },
      filters: [],
      queryContract: {
        derivedMetrics: [{ outputField: 'gross_margin' }],
      },
    },
    queryFingerprint: 'fp',
    dataHash: 'hash',
  });

  assert.deepEqual(capabilities.rowGrain, ['province_name']);
  assert.deepEqual(capabilities.metrics, ['sale_amt']);
  assert.deepEqual(capabilities.derivedMetrics, ['gross_margin']);
  assert.equal(capabilities.dateRange.field, 'sales_date');
});

test('artifact strategy chooses reuse only when required fields are available', () => {
  const artifacts = [{
    id: 'artifact-1',
    capabilities: {
      columns: [
        { field: 'province_name' },
        { field: 'sale_amt' },
      ],
    },
  }];

  assert.equal(artifactCanSatisfy(
    artifacts[0].capabilities,
    { dimensions: ['province_name'], metrics: ['sale_amt'] },
  ), true);
  assert.equal(decideArtifactStrategy({
    artifacts,
    requirements: {
      dimensions: ['province_name'],
      metrics: ['sale_amt'],
    },
  }).action, 'REUSE');
  assert.equal(decideArtifactStrategy({
    artifacts,
    requirements: {
      dimensions: ['province_name'],
      metrics: ['profit_no_tax'],
    },
  }).action, 'NEW_QUERY_AND_DERIVE');
});
