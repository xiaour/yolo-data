function compactText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

export function normalizeBusinessTerm(value) {
  return compactText(value);
}

// Business terms can differ by one character. Keep small lexical
// variations deterministic instead of requiring an embedding service.
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

export function fuzzyTermMatch(query, term) {
  const left = normalizeBusinessTerm(query);
  const right = normalizeBusinessTerm(term);
  if (left.length < 2 || right.length < 2) return 0;
  const overlap = longestCommonSubstringLength(left, right);
  const threshold = Math.max(2, Math.ceil(Math.min(left.length, right.length) * 0.5));
  return overlap >= threshold ? overlap : 0;
}

export function indicatorValues(indicator) {
  return [
    indicator?.name,
    indicator?.bizName,
    indicator?.description,
    indicator?.businessCaliber,
    indicator?.typeName,
    ...(indicator?.metrics ?? []).flatMap((metric) => [
      metric?.metricName,
      metric?.name,
      metric?.metricBizName,
      metric?.bizName,
    ]),
    ...(indicator?.dimensions ?? []).flatMap((dimension) => [
      dimension?.dimensionName,
      dimension?.name,
      dimension?.dimensionBizName,
      dimension?.bizName,
    ]),
  ].filter(Boolean).map(normalizeBusinessTerm);
}

export function promptMetricAliases(prompt) {
  const text = String(prompt ?? '');
  const aliases = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/指标同义词/.test(line)) continue;
    const expression = line.slice(line.indexOf('：') >= 0 ? line.indexOf('：') + 1 : line.indexOf(':') + 1);
    for (const mapping of expression.split(/[；;，,]/)) {
      const match = mapping.match(/^\s*([^=＝]+?)\s*[=＝]\s*(.+?)\s*$/);
      if (!match) continue;
      const alias = normalizeBusinessTerm(match[1]);
      const target = normalizeBusinessTerm(match[2]);
      if (alias && target) aliases.push({ alias, target });
    }
  }
  return aliases;
}

