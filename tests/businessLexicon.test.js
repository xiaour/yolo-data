import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getPlatformLexicon,
  mergeLexicon,
  normalizeLexicon,
  profileHintPattern,
  resolveBusinessLexicon,
} from '../src/businessLexicon.js';
import { normalizeSemanticPolicy } from '../src/semanticPolicy.js';

test('platform lexicon comes from configuration, not from code', () => {
  const lexicon = getPlatformLexicon();
  // 词表内容全部来自 config/bootstrap/default.json，模块本身不内置业务词。
  assert.ok(lexicon.metricTerms.length > 0);
  assert.ok(lexicon.taxPrefixes.excluded.length > 0);
  assert.ok(Object.keys(lexicon.dimensionAliases).length > 0);
  assert.ok(lexicon.profileHints.rate.terms.length > 0);
});

test('theme semantic policy overrides and extends the platform lexicon', () => {
  const theme = {
    semanticPolicy: {
      lexicon: {
        metricTerms: ['客单价'],
        taxPrefixes: { excluded: ['免税'] },
        dimensionAliases: { region: ['片区'] },
        profileHints: { rate: { terms: ['折扣率'] } },
      },
    },
  };
  const lexicon = resolveBusinessLexicon(theme);
  const platform = getPlatformLexicon();
  assert.ok(lexicon.metricTerms.includes('客单价'));
  assert.ok(lexicon.metricTerms.includes(platform.metricTerms[0]));
  assert.ok(lexicon.taxPrefixes.excluded.includes('免税'));
  assert.ok(lexicon.taxPrefixes.excluded.includes('未税'));
  assert.deepEqual(lexicon.dimensionAliases.region, [
    ...platform.dimensionAliases.region,
    '片区',
  ]);
  assert.ok(lexicon.profileHints.rate.terms.includes('折扣率'));
});

test('normalizeLexicon keeps list, map, tax and profile sections', () => {
  const lexicon = normalizeLexicon({
    metricTerms: ['金额', '金额', ''],
    taxPrefixes: { all: ['含税'], excluded: ['未税'] },
    profileHints: { identifier: { wholeWord: true, terms: ['code'] } },
  });
  assert.deepEqual(lexicon.metricTerms, ['金额']);
  assert.deepEqual(lexicon.taxPrefixes, { all: ['含税'], excluded: ['未税'] });
  assert.equal(lexicon.profileHints.identifier.wholeWord, true);
  assert.deepEqual(lexicon.profileHints.identifier.terms, ['code']);
  assert.deepEqual(lexicon.profileHints.metric, { wholeWord: false, terms: [] });
});

test('mergeLexicon unions lists and keeps override entries', () => {
  const merged = mergeLexicon(
    { rateTerms: ['率'], dimensionValues: { region: ['华东'] } },
    { rateTerms: ['占比'], dimensionValues: { channel: ['线上'] } },
  );
  assert.deepEqual(merged.rateTerms, ['率', '占比']);
  assert.deepEqual(merged.dimensionValues, { region: ['华东'], channel: ['线上'] });
});

test('profileHintPattern builds patterns from lexicon data', () => {
  const lexicon = normalizeLexicon({
    profileHints: {
      identifier: { wholeWord: true, terms: ['code'] },
      rate: { terms: ['率'] },
    },
  });
  assert.equal(profileHintPattern(lexicon, 'identifier').test('order_code'), true);
  assert.equal(profileHintPattern(lexicon, 'identifier').test('encoder'), false);
  assert.equal(profileHintPattern(lexicon, 'rate').test('毛利率'), true);
  assert.equal(profileHintPattern(lexicon, 'missing'), null);
});

test('semantic policy keeps the theme lexicon section', () => {
  const policy = normalizeSemanticPolicy({
    lexicon: { metricTerms: ['金额'] },
  });
  assert.deepEqual(policy.lexicon.metricTerms, ['金额']);
  assert.deepEqual(normalizeSemanticPolicy({}).lexicon.metricTerms, []);
});
