function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

function bigrams(value) {
  const text = normalizeText(value);
  const result = new Set();
  for (let index = 0; index < Math.max(0, text.length - 1); index += 1) {
    result.add(text.slice(index, index + 2));
  }
  return result;
}

function similarity(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    return Math.min(0.98, 0.74 + (shorter / longer) * 0.24);
  }
  const leftGrams = bigrams(a);
  const rightGrams = bigrams(b);
  const union = new Set([...leftGrams, ...rightGrams]);
  const intersection = [...leftGrams].filter((gram) => rightGrams.has(gram)).length;
  return union.size > 0 ? intersection / union.size : 0;
}

function candidateAliases(candidate) {
  return [
    candidate?.name,
    candidate?.displayName,
    candidate?.bizName,
    candidate?.metricName,
    candidate?.fieldName,
    candidate?.concept,
    ...(candidate?.aliases ?? []),
  ]
    .map(normalizeText)
    .filter(Boolean);
}

export function scoreMetricCandidate({
  concept,
  candidate,
  policyRules = [],
}) {
  const aliases = candidateAliases(candidate);
  const conceptText = normalizeText(concept);
  if (!conceptText || aliases.length === 0) {
    return null;
  }
  const policyMatch = policyRules.find((rule) => (
    [...(rule?.aliases ?? []), rule?.concept]
      .some((alias) => normalizeText(alias) === conceptText)
  ));
  if (policyMatch) {
    const targetValues = [
      policyMatch.target?.field,
      policyMatch.target?.outputField,
      policyMatch.target?.indicatorId,
      policyMatch.id,
    ].map(normalizeText).filter(Boolean);
    if (
      targetValues.some((value) => aliases.includes(value))
      || targetValues.some((value) => normalizeText(candidate?.id) === value)
    ) {
      return {
        score: 1,
        mode: 'POLICY_EXACT',
        evidence: `semanticPolicy:${policyMatch.id}`,
        policyRuleId: policyMatch.id,
      };
    }
  }
  const aliasScores = aliases.map((alias) => similarity(alias, conceptText));
  const bestScore = Math.max(0, ...aliasScores);
  if (bestScore >= 0.99) {
    return {
      score: 1,
      mode: 'METADATA_EXACT',
      evidence: `metadata alias:${aliases[aliasScores.indexOf(bestScore)]}`,
    };
  }
  if (bestScore >= 0.86) {
    return {
      score: bestScore,
      mode: 'METADATA_ALIAS',
      evidence: `metadata approximate:${aliases[aliasScores.indexOf(bestScore)]}`,
    };
  }
  return {
    score: bestScore,
    mode: bestScore >= 0.6 ? 'VECTOR_FUZZY' : 'WEAK',
    evidence: bestScore > 0
      ? `similarity ${bestScore.toFixed(2)}`
      : 'no direct alias evidence',
  };
}

export function resolveMetricCandidates({
  concept,
  candidates = [],
  policyRules = [],
  threshold = 0.78,
  topN = 5,
}) {
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      ...(scoreMetricCandidate({ concept, candidate, policyRules }) ?? {}),
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => (
      right.score - left.score
      || String(left.candidate?.id ?? '').localeCompare(String(right.candidate?.id ?? ''))
    ))
    .slice(0, Math.max(1, Math.min(topN, 10)));
  return {
    concept,
    candidates: ranked,
    threshold,
  };
}

export function adjudicateMetricResolution(resolution) {
  const candidates = resolution?.candidates ?? [];
  if (candidates.length === 0) {
    return {
      status: 'CAPABILITY_GAP',
      reason: 'no metric candidate matched the requested concept',
      selected: null,
    };
  }
  const [first, second] = candidates;
  if (first.score < (resolution.threshold ?? 0.78)) {
    return {
      status: 'CAPABILITY_GAP',
      reason: `best candidate score ${first.score.toFixed(2)} is below threshold`,
      selected: null,
    };
  }
  const margin = first.score - (second?.score ?? 0);
  if (margin < 0.1) {
    return {
      status: 'AMBIGUOUS',
      reason: 'multiple metric candidates have similar scores',
      selected: null,
    };
  }
  return {
    status: 'RESOLVED',
    reason: first.evidence || 'unique high-confidence candidate',
    selected: first,
  };
}

export function buildMetricResolverPrompt(question, policy) {
  const rules = policy?.metrics ?? [];
  if (rules.length === 0) {
    return '当前主题未配置指标语义包。指标候选必须通过字段元数据唯一匹配或大模型候选裁决，禁止选择分数接近的相似字段。';
  }
  return [
    '指标候选裁决规则：',
    '1. semanticPolicy 精确命中时优先级最高。',
    '2. 字段名称/显示名/业务名唯一精确匹配时直接采用。',
    '3. 允许近似和向量候选，但默认必须保留所有候选及分数。',
    '4. 最高分与次高分差距小于 0.1 时必须澄清，禁止猜测。',
    `当前语义包指标：${rules.map((rule) => rule.concept).join('、') || '无'}`,
  ].join('\n');
}
