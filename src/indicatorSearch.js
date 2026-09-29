function compactText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

export function normalizeBusinessTerm(value) {
  return compactText(value);
}

function indicatorValues(indicator) {
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

export function scoreIndicator(indicator, question) {
  const text = normalizeBusinessTerm(question);
  const values = indicatorValues(indicator);
  const noTaxRequested = /不含税|未税/.test(text);

  let score = 0;
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (text.includes(value)) {
      score += value.length >= 4 ? 20 : 12;
    }
    const coreValue = value.replace(/^(含税|不含税|未税)/, '');
    if (coreValue && coreValue !== value && text.includes(coreValue)) {
      const excludesTax = /^(不含税|未税)/.test(value);
      score += excludesTax
        ? (noTaxRequested ? 18 : 5)
        : (noTaxRequested ? 5 : 18);
    }
    for (const token of value.split(/[\s,，、;；/]+/).filter((item) => item.length >= 2)) {
      if (text.includes(token)) {
        score += Math.min(token.length, 6);
      }
    }
  }
  return score;
}

export function rankIndicators(indicators, question, limit = 6) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 6, 20));
  return (indicators ?? [])
    .map((indicator) => ({
      indicator,
      score: scoreIndicator(indicator, question),
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
