import { getPlatformLexicon, lexiconPattern } from './businessLexicon.js';

export const FILTER_SCOPES = {
  ROW: 'ROW',
  AGGREGATE: 'AGGREGATE',
};

const AGGREGATE_COMPARISON = /(>|>=|<|<=)|超过|低于|大于|小于|高于|不低于|不超过|不少于|不多于/;

function hasLikeWildcard(value) {
  return String(value ?? '').includes('%') || String(value ?? '').includes('_');
}

export function normalizeLikePattern(value, sourceText = '') {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeLikePattern(item, sourceText));
  }
  const text = String(value ?? '').trim();
  if (!text || hasLikeWildcard(text)) {
    return value;
  }
  const source = String(sourceText ?? '');
  if (/^(?:不等于|不是|排除)/.test(source)) {
    return text;
  }
  if (/开头|起始|以.+开始/.test(source)) {
    return `${text}%`;
  }
  if (/结尾|末尾|以.+结束/.test(source)) {
    return `%${text}`;
  }
  return `%${text}%`;
}

export function resolveFilterScope({
  field = null,
  operator = '',
  sourceText = '',
  lexicon = null,
} = {}) {
  if (String(field?.role ?? '').toUpperCase() === 'METRIC') {
    return FILTER_SCOPES.AGGREGATE;
  }
  const metricPattern = lexiconPattern(
    (lexicon ?? getPlatformLexicon()).metricTerms,
  );
  if (
    metricPattern?.test(sourceText)
    && AGGREGATE_COMPARISON.test(sourceText)
  ) {
    return FILTER_SCOPES.AGGREGATE;
  }
  if (String(operator ?? '').toUpperCase() === 'HAVING') {
    return FILTER_SCOPES.AGGREGATE;
  }
  return FILTER_SCOPES.ROW;
}
