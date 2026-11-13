import { getPlatformLexicon } from './businessLexicon.js';

function compactText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

function normalizeBusinessTerm(value) {
  return compactText(value);
}

// Short metric labels often differ by one character. Keep this deterministic
// and explainable instead of requiring an embedding service for small lexical variation.
function longestCommonSubstringLength(left, right) {
  const a = normalizeBusinessTerm(left);
  const b = normalizeBusinessTerm(right);
  if (!a || !b) return 0;
  let previous = new Array(b.length + 1).fill(0);
  let longest = 0;
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1] + 1;
        longest = Math.max(longest, current[j]);
      }
    }
    previous = current;
  }
  return longest;
}

export { normalizeBusinessTerm };

export function scoreIndicator(indicator, question, lexicon = null, prompt = '') {
  const text = normalizeBusinessTerm(question);
  const values = indicatorValues(indicator);
  for (const { alias, target } of promptMetricAliases(prompt)) {
    // Require an exact configured target so one qualified metric cannot match
    // another merely because its label contains a shorter qualified label.
    if (text.includes(alias) && values.some((value) => value === target)) {
      values.push(alias);
    }
  }
  const tax = (lexicon ?? getPlatformLexicon()).taxPrefixes;
  const excludedPrefixes = tax.excluded.map((prefix) => normalizeBusinessTerm(prefix));
  const allPrefixes = tax.all.map((prefix) => normalizeBusinessTerm(prefix));
  const noTaxRequested = excludedPrefixes.some((prefix) => text.includes(prefix));
  const coreOf = (value) => {
    const prefix = allPrefixes
      .filter((item) => value.startsWith(item))
      .sort((left, right) => right.length - left.length)[0];
    return prefix ? value.slice(prefix.length) : value;
  };
  const isExcluded = (value) => excludedPrefixes.some((prefix) => value.startsWith(prefix));

  let score = 0;
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (text.includes(value)) {
      score += value.length >= 4 ? 20 : 12;
    }
    const coreValue = coreOf(value);
    if (coreValue && coreValue !== value && text.includes(coreValue)) {
      const excludesTax = isExcluded(value);
      score += excludesTax
        ? (noTaxRequested ? 18 : 5)
        : (noTaxRequested ? 5 : 18);
    }
    // Fuzzy-match the metric core so common label variants still resolve,
    // while preserving the configured qualifier preference.
    if (coreValue && !text.includes(coreValue)) {
      const overlap = fuzzyTermMatch(text, coreValue);
      if (overlap > 0) {
        const excludesTax = isExcluded(value);
        score += excludesTax
          ? (noTaxRequested ? 12 : 3)
          : (noTaxRequested ? 3 : 12);
      }
    }
    for (const token of value.split(/[\s,，、;；/]+/).filter((item) => item.length >= 2)) {
      if (text.includes(token)) {
        score += Math.min(token.length, 6);
      }
    }
  }
  return score;
}

export function rankIndicators(indicators, question, limit = 6, lexicon = null, prompt = '') {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 6, 20));
  return (indicators ?? [])
    .map((indicator) => ({
      indicator,
      score: scoreIndicator(indicator, question, lexicon, prompt),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || String(left.indicator?.name ?? '').localeCompare(
        String(right.indicator?.name ?? ''),
        'zh-CN',
        { numeric: true },
      )
      || String(left.indicator?.id ?? '').localeCompare(
        String(right.indicator?.id ?? ''),
        'zh-CN',
        { numeric: true },
      )
    ))
    .slice(0, safeLimit);
}

export function sortIndicators(indicators) {
  return [...(indicators ?? [])].sort((left, right) => (
    String(left?.id ?? '').localeCompare(String(right?.id ?? ''), 'zh-CN', {
      numeric: true,
    })
    || String(left?.name ?? '').localeCompare(String(right?.name ?? ''), 'zh-CN', {
      numeric: true,
    })
  ));
}

export { normalizeBusinessTerm };
