import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractPolicyCandidates,
  fieldPolicyConfig,
  mergeValueCandidates,
  normalizeValueOrigin,
  scopeSignature,
  VALUE_ORIGINS,
} from '../src/semanticDomain.js';

test('dataset domain sources use Doris and never include Supersonic metadata', () => {
  const policy = fieldPolicyConfig(true, 'DATASET');
  assert.ok(policy.sources.includes(VALUE_ORIGINS.DORIS_DISTINCT));
  assert.ok(policy.sources.includes(VALUE_ORIGINS.THEME_SEMANTIC_POLICY));
  assert.equal(policy.sources.includes('SUPERSONIC_METADATA'), false);
  assert.equal(policy.sources.includes('SUPERSONIC_DIMENSION'), false);
});

test('indicator domain policies default to theme and manual sources only', () => {
  const policy = fieldPolicyConfig(true, 'INDICATOR');
  assert.deepEqual(policy.sources, [
    VALUE_ORIGINS.THEME_SEMANTIC_POLICY,
    VALUE_ORIGINS.THEME_PROMPT,
    VALUE_ORIGINS.MANUAL_VERIFIED,
  ]);
  assert.equal(policy.sources.includes(VALUE_ORIGINS.DORIS_DISTINCT), false);
});

test('legacy source markers map to the governed origin taxonomy', () => {
  assert.equal(
    normalizeValueOrigin('SOURCE_VALUES', 'DATASET'),
    VALUE_ORIGINS.DORIS_DISTINCT,
  );
  assert.equal(
    normalizeValueOrigin('DESCRIPTION', 'DATASET'),
    VALUE_ORIGINS.DATASET_METADATA,
  );
  assert.equal(normalizeValueOrigin('DESCRIPTION', 'INDICATOR'), '');
  assert.equal(normalizeValueOrigin('PROMPT'), VALUE_ORIGINS.THEME_PROMPT);
});

test('candidate merging preserves the highest authority origin', () => {
  const merged = mergeValueCandidates([
    [{
      value: '企业客户',
      aliases: ['重点客户组'],
      origin: VALUE_ORIGINS.THEME_SEMANTIC_POLICY,
    }],
    [{
      value: '企业客户',
      aliases: ['企业客户'],
      origin: VALUE_ORIGINS.DORIS_DISTINCT,
    }],
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].origin, VALUE_ORIGINS.DORIS_DISTINCT);
  assert.ok(merged[0].aliases.includes('重点客户组'));
  assert.ok(merged[0].aliases.includes('企业客户'));
});

test('policy candidate extraction is configuration-driven', () => {
  const candidates = extractPolicyCandidates({
    filters: [{
      id: 'policy.welfare',
      concept: '重点客户组',
      field: 'business_type_name',
      value: ['企业客户', '零售客户', '大客户'],
    }],
  }, 'business_type_name');

  assert.deepEqual(candidates.map((item) => item.value), [
    '企业客户',
    '零售客户',
    '大客户',
  ]);
  assert.equal(candidates[0].origin, VALUE_ORIGINS.THEME_SEMANTIC_POLICY);
  assert.equal(candidates[0].originRef, 'semanticPolicy:policy.welfare');
});

test('permission scope signature is stable and input-order independent', () => {
  const first = scopeSignature({
    rowPolicies: [
      { dimension: 'region', operator: 'IN', values: ['华东'] },
      { dimension: 'channel', operator: 'IN', values: ['线上'] },
    ],
  });
  const second = scopeSignature({
    rowPolicies: [
      { dimension: 'channel', operator: 'IN', values: ['线上'] },
      { dimension: 'region', operator: 'IN', values: ['华东'] },
    ],
  });

  assert.equal(first, second);
});
