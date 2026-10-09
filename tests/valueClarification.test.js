import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModelClarification,
  buildValueClarification,
  choiceOptionId,
  collectValueCandidates,
  describeClarificationOption,
  parseValueOption,
  valueOptionId,
} from '../src/valueClarification.js';

test('collectValueCandidates keeps only value-resolution issues', () => {
  const groups = collectValueCandidates([
    {
      code: 'FILTER_VALUE_AMBIGUOUS',
      field: 'region',
      requestedValue: 'T7',
      candidates: ['T7-A', 'T7-B', 'T7-A'],
    },
    { code: 'QUESTION_CLAUSE_NOT_COVERED', message: '无关阻塞项' },
    {
      code: 'FILTER_VALUE_AMBIGUOUS',
      field: 'region',
      requestedValue: 'T7',
      candidates: ['T7-C'],
    },
    {
      code: 'FILTER_DOMAIN_STALE',
      field: 'region',
      requestedValue: 'T7',
      candidates: ['T7-D'],
    },
    { code: 'FILTER_VALUE_AMBIGUOUS', field: 'region', requestedValue: 'T7', candidates: [] },
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].field, 'region');
  assert.equal(groups[0].requested, 'T7');
  assert.deepEqual(groups[0].candidates, ['T7-A', 'T7-B', 'T7-C']);
});

test('value clarification offers the candidate values themselves as options', () => {
  const clarification = buildValueClarification([{
    field: 'region',
    requested: 'T7',
    candidates: ['T7-A', 'T7-B'],
  }]);

  assert.equal(clarification.type, 'NEEDS_CONFIRMATION');
  assert.match(clarification.prompt, /T7/);
  assert.match(clarification.prompt, /T7-A/);
  assert.match(clarification.prompt, /T7-B/);
  assert.deepEqual(
    clarification.options.map((option) => option.id),
    ['filter-value:region=T7-A', 'filter-value:region=T7-B', 'cancel'],
  );
  assert.deepEqual(
    clarification.options.map((option) => option.label),
    ['T7-A', 'T7-B', '都不是，停止本轮查询'],
  );
  // 候选值之间没有「正确答案」，不得给出推荐项。
  assert.equal(clarification.recommendedOptionId, null);
  assert.ok(clarification.options.every((option) => option.recommended === false));
});

test('single candidate is phrased as a confirmation instead of a pick list', () => {
  const clarification = buildValueClarification([{
    field: 'region',
    requested: 'T7',
    candidates: ['T7-A'],
  }]);

  assert.equal(clarification.options.length, 2);
  assert.match(clarification.prompt, /最接近/);
  assert.match(clarification.prompt, /T7-A/);
});

test('value clarification is skipped when asking is not allowed or the field is unknown', () => {
  const groups = [{ field: 'region', requested: 'T7', candidates: ['T7-A'] }];
  assert.equal(buildValueClarification(groups, { allowed: false }), null);
  assert.equal(buildValueClarification([{ field: '', requested: 'T7', candidates: ['T7-A'] }]), null);
  assert.equal(buildValueClarification([]), null);
});

test('selected value option expands into a confirmed filter condition', () => {
  assert.deepEqual(parseValueOption('filter-value:region=T7-A'), {
    field: 'region',
    value: 'T7-A',
  });
  assert.equal(valueOptionId({ field: 'region' }, 'T7=A'), 'filter-value:region=T7=A');
  assert.deepEqual(parseValueOption('filter-value:region=T7=A'), {
    field: 'region',
    value: 'T7=A',
  });
  assert.equal(parseValueOption('use-recommended'), null);
  assert.equal(parseValueOption('filter-value:=T7-A'), null);
  assert.match(describeClarificationOption('filter-value:region=T7-A'), /region/);
  assert.match(describeClarificationOption('filter-value:region=T7-A'), /T7-A/);
  assert.equal(describeClarificationOption('use-recommended'), '');
  assert.equal(describeClarificationOption(''), '');
});

test('plain-choice option carries the picked label without a filter condition', () => {
  assert.equal(choiceOptionId('客户级'), 'choice:客户级');
  assert.match(describeClarificationOption('choice:客户级'), /客户级/);
  assert.equal(parseValueOption('choice:客户级'), null);
});

test('model clarification renders its question and options into a pick list', () => {
  const clarification = buildModelClarification({
    question: '你说的「T7」是指哪一个？',
    options: [
      { label: 'T7-A', field: 'region', value: 'T7-A' },
      { label: 'T7-B', field: 'region', value: 'T7-B' },
      { label: '整个 T7 合并看' },
    ],
  });

  assert.equal(clarification.type, 'NEEDS_CONFIRMATION');
  assert.equal(clarification.prompt, '你说的「T7」是指哪一个？');
  assert.deepEqual(
    clarification.options.map((option) => option.id),
    ['filter-value:region=T7-A', 'filter-value:region=T7-B', 'choice:整个 T7 合并看', 'cancel'],
  );
  assert.deepEqual(
    clarification.options.map((option) => option.label),
    ['T7-A', 'T7-B', '整个 T7 合并看', '都不是，停止本轮查询'],
  );
  assert.equal(clarification.recommendedOptionId, null);
});

test('model clarification is skipped without a question, fewer than two options, or when asking is not allowed', () => {
  const twoOptions = [{ label: 'T7-A' }, { label: 'T7-B' }];
  assert.equal(buildModelClarification({ question: '', options: twoOptions }), null);
  assert.equal(buildModelClarification({ question: 'T7 指哪个？', options: [{ label: 'T7-A' }] }), null);
  assert.equal(
    buildModelClarification({ question: 'T7 指哪个？', options: twoOptions }, { allowed: false }),
    null,
  );
  assert.equal(buildModelClarification({}), null);
});

test('model clarification caps the option list and always keeps the cancel option', () => {
  const options = Array.from({ length: 9 }, (unused, index) => ({ label: `T7-${index}` }));
  const clarification = buildModelClarification({ question: 'T7 指哪个？', options });
  assert.equal(clarification.options.length, 7);
  assert.equal(clarification.options.at(-1).id, 'cancel');
});
