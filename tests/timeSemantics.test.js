import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPreviousAlignedWindow,
  extractTemporalMentions,
  parseTemporalExpression,
  resolveRecentDateInfo,
} from '../src/timeSemantics.js';

const now = new Date('2026-09-22T03:00:00Z');

test('time semantics resolves recent days against business T-1', () => {
  const result = parseTemporalExpression('最近7天含税销售金额趋势', now);
  assert.equal(result.dateMode, 'BETWEEN');
  assert.equal(result.startDate, '2026-09-15');
  assert.equal(result.endDate, '2026-09-21');
  assert.equal(result.detectWord, '最近7天');
});

test('time semantics resolves yesterday and current month', () => {
  assert.deepEqual(
    parseTemporalExpression('昨天销售额', now),
    {
      dateMode: 'BETWEEN',
      startDate: '2026-09-21',
      endDate: '2026-09-21',
      unit: null,
      period: null,
      dateList: [],
      detectWord: '昨天',
      expression: '昨天',
      anchor: 'BUSINESS_T_MINUS_1',
    },
  );
  const month = parseTemporalExpression('本月销售额', now);
  assert.equal(month.startDate, '2026-09-01');
  assert.equal(month.endDate, '2026-09-21');
});

test('time semantics resolves explicit dates and months', () => {
  const explicit = parseTemporalExpression(
    '查询2026年9月1日到2026年9月7日每天的销售额',
    now,
  );
  assert.equal(explicit.startDate, '2026-09-01');
  assert.equal(explicit.endDate, '2026-09-07');
  assert.equal(explicit.anchor, 'EXPLICIT');

  const month = parseTemporalExpression('2026年8月销售额', now);
  assert.equal(month.startDate, '2026-08-01');
  assert.equal(month.endDate, '2026-08-31');

  const currentYear = parseTemporalExpression('2026年销售额趋势', now);
  assert.equal(currentYear.startDate, '2026-01-01');
  assert.equal(currentYear.endDate, '2026-09-21');

  const completedYear = parseTemporalExpression('2025年销售额趋势', now);
  assert.equal(completedYear.startDate, '2025-01-01');
  assert.equal(completedYear.endDate, '2025-12-31');
});

test('attribution windows align the previous period by the same number of days', () => {
  const current = parseTemporalExpression('9月份业绩变化原因', now);
  assert.equal(current.startDate, '2026-09-01');
  assert.equal(current.endDate, '2026-09-21');

  const previous = buildPreviousAlignedWindow(current);
  assert.equal(previous.startDate, '2026-08-01');
  assert.equal(previous.endDate, '2026-08-21');
});

test('recent date resolver supports week, month and year periods', () => {
  assert.equal(
    resolveRecentDateInfo({ unit: 2, period: 'WEEK' }, now).startDate,
    '2026-09-08',
  );
  assert.equal(
    resolveRecentDateInfo({ unit: 2, period: 'MONTH' }, now).startDate,
    '2026-08-01',
  );
  assert.equal(
    resolveRecentDateInfo({ unit: 2, period: 'YEAR' }, now).startDate,
    '2025-01-01',
  );
});

test('time semantics supports project-specific Chinese period formats', () => {
  const shortYearMonth = parseTemporalExpression('26年8月销售额', now);
  assert.equal(shortYearMonth.startDate, '2026-08-01');
  assert.equal(shortYearMonth.endDate, '2026-08-31');

  const compactMonth = parseTemporalExpression('202608月销售额', now);
  assert.equal(compactMonth.startDate, '2026-08-01');
  assert.equal(compactMonth.endDate, '2026-08-31');

  const monthRange = parseTemporalExpression('2026年1~8月销售额', now);
  assert.equal(monthRange.startDate, '2026-01-01');
  assert.equal(monthRange.endDate, '2026-08-31');

  const monthToDate = parseTemporalExpression('9月至今销售额', now);
  assert.equal(monthToDate.startDate, '2026-09-01');
  assert.equal(monthToDate.endDate, '2026-09-21');

  const yearlessRange = parseTemporalExpression('9月1-15号销售额', now);
  assert.equal(yearlessRange.startDate, '2026-09-01');
  assert.equal(yearlessRange.endDate, '2026-09-15');

  const shortYearRange = parseTemporalExpression('26年9月1-15号销售额', now);
  assert.equal(shortYearRange.startDate, '2026-09-01');
  assert.equal(shortYearRange.endDate, '2026-09-15');
});

test('time semantics covers common period-to-date and relative ranges', () => {
  const monthToDate = parseTemporalExpression(
    '月至今的标准配送的业绩是多少？按management_category拆分',
    now,
  );
  assert.equal(monthToDate.startDate, '2026-09-01');
  assert.equal(monthToDate.endDate, '2026-09-21');
  assert.equal(monthToDate.detectWord, '月至今');

  const cases = [
    ['本月至今销售额', '2026-09-01', '2026-09-21'],
    ['月初累计销售额', '2026-09-01', '2026-09-21'],
    ['周至今销售额', '2026-09-21', '2026-09-21'],
    ['季度至今销售额', '2026-07-01', '2026-09-21'],
    ['年初至今销售额', '2026-01-01', '2026-09-21'],
    ['自9月1日以来销售额', '2026-09-01', '2026-09-21'],
    ['2026年9月1日至今销售额', '2026-09-01', '2026-09-21'],
    ['近三个月销售额', '2026-07-01', '2026-09-21'],
    ['过去7天销售额', '2026-09-15', '2026-09-21'],
    ['近半年销售额', '2026-04-01', '2026-09-21'],
  ];
  for (const [question, startDate, endDate] of cases) {
    const result = parseTemporalExpression(question, now);
    assert.equal(result?.startDate, startDate, question);
    assert.equal(result?.endDate, endDate, question);
  }

  const mentions = extractTemporalMentions(
    '月至今的标准配送的业绩是多少？按management_category拆分',
    now,
  );
  assert.deepEqual(
    mentions.map((item) => item.expression),
    ['月至今'],
  );
});

test('time semantics extracts every comparison window from one question', () => {
  const mentions = extractTemporalMentions(
    '各省区26年8月对比25年8月、26年2月的未税销售额',
    now,
  );
  assert.deepEqual(
    mentions.map((item) => item.expression),
    ['26年8月', '25年8月', '26年2月'],
  );
  assert.deepEqual(
    mentions.map((item) => [item.dateInfo.startDate, item.dateInfo.endDate]),
    [
      ['2026-08-01', '2026-08-31'],
      ['2025-08-01', '2025-08-31'],
      ['2026-02-01', '2026-02-28'],
    ],
  );
});

test('time semantics treats a year-month range as one window', () => {
  const mentions = extractTemporalMentions('查询2026年5~8月销售额', now);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].expression, '2026年5~8月');
  assert.equal(mentions[0].dateInfo.startDate, '2026-05-01');
  assert.equal(mentions[0].dateInfo.endDate, '2026-08-31');
});
