import { getPlatformLexicon, lexiconPattern } from './businessLexicon.js';

// 规则版 Harness 的问句理解辅助：把自然语言问题确定性地匹配到
// 数据集、字段、维度、筛选与时间范围。全部是纯文本/词典规则，
// 不触达模型、连接池与平台库。

export function normalizeMatchText(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '').trim();
}

export function fieldAliases(field) {
  return [
    field?.name,
    field?.fieldName,
    field?.displayName,
    field?.bizName,
  ].map(normalizeMatchText).filter(Boolean);
}

export function matchingFields(question, fields, role = null) {
  const text = normalizeMatchText(question);
  return (fields ?? []).filter((field) => {
    if (role && field.role !== role) {
      return false;
    }
    return fieldAliases(field).some((alias) => text.includes(alias));
  });
}

export function scoreBusinessDataset(question, dataset) {
  const text = normalizeMatchText(question);
  const fields = dataset?.fields ?? [];
  const matchedFields = fields.filter((field) => (
    fieldAliases(field).some((alias) => text.includes(alias))
  ));
  const matchedValues = fields.flatMap((field) => (
    (field.valueDomain?.values ?? field.values ?? [])
      .map((value) => normalizeMatchText(value?.value ?? value))
      .filter((value) => value && text.includes(value))
  ));
  if (matchedFields.length === 0 && matchedValues.length === 0) {
    return { score: 0, matchedConcepts: 0 };
  }
  const name = normalizeMatchText(dataset?.name);
  const code = normalizeMatchText(dataset?.code);
  let score = matchedFields.length * 10 + matchedValues.length * 4;
  if (name && text.includes(name)) {
    score += 8;
  }
  if (code && text.includes(code)) {
    score += 6;
  }
  return {
    score,
    matchedConcepts: matchedFields.length + matchedValues.length,
  };
}

export function selectBusinessDataset(question, datasets) {
  const ranked = (datasets ?? [])
    .map((dataset) => ({
      dataset,
      ...scoreBusinessDataset(question, dataset),
    }))
    .filter((item) => item.matchedConcepts > 0)
    .sort((left, right) => right.score - left.score);
  if (
    ranked.length === 0
    || ranked[0].score <= 0
    || (ranked[1] && ranked[1].score === ranked[0].score)
  ) {
    return null;
  }
  return ranked[0].dataset;
}

export function contextualizeQuestion(messages) {
  const userMessages = (messages ?? [])
    .filter((message) => message.role === 'user')
    .map((message) => String(message.content ?? '').trim())
    .filter(Boolean);
  const current = userMessages.at(-1) ?? '';
  const previous = userMessages.slice(-3, -1);
  if (previous.length === 0) {
    return current;
  }
  const needsContext = current.length < 18
    || /^(那|再|换|按|这个|上述|它|他|她|还有|呢)|同比|环比|继续/.test(current);
  return needsContext ? `${previous.join('；')}；${current}` : current;
}

export function selectDimensions(question, detail, lexicon = null) {
  const rules = lexicon ?? getPlatformLexicon();
  const available = new Set((detail.dimensions ?? []).flatMap((dimension) => [
    dimension.dimensionBizName,
    dimension.bizName,
    dimension.dimensionName,
    dimension.name,
  ]).filter(Boolean));
  const requested = [];
  if (/趋势|走势|变化|每天|按日|日级|近\d+天|最近\d+天/.test(question) && available.has('date')) {
    requested.push('date');
  }
  for (const [dimension, aliases] of Object.entries(rules.dimensionAliases)) {
    const pattern = lexiconPattern([dimension, ...aliases]);
    if (available.has(dimension) && pattern?.test(question)) {
      requested.push(dimension);
    }
  }
  if (requested.length === 0 && /对比|排名|排行|分布|构成|各|top/i.test(question)) {
    const fallback = rules.dimensionFallback
      .find((dimension) => available.has(dimension));
    if (fallback) {
      requested.push(fallback);
    }
  }
  return [...new Set(requested)].slice(0, 2);
}

export function extractQuestionFilters(question, detail, lexicon = null) {
  const rules = lexicon ?? getPlatformLexicon();
  const filters = [];
  const candidateDimensions = (detail.dimensions ?? []).map(
    (dimension) => dimension.dimensionBizName ?? dimension.bizName,
  ).filter(Boolean);
  for (const [dimension, values] of Object.entries(rules.dimensionValues)) {
    if (!candidateDimensions.includes(dimension)) {
      continue;
    }
    const matched = values.find((value) => question.includes(value));
    if (matched) {
      filters.push({ bizName: dimension, operator: 'IN', value: [matched] });
    }
  }
  return filters;
}

export function extractDateRange(question) {
  const match = question.match(/(?:最近|近)\s*(\d+)\s*(天|周|月|季度|年)/);
  if (!match) {
    return undefined;
  }
  const unit = Number(match[1]);
  const periodMap = {
    天: 'DAY',
    周: 'WEEK',
    月: 'MONTH',
    季度: 'QUARTER',
    年: 'YEAR',
  };
  return {
    dateMode: 'RECENT',
    unit,
    period: periodMap[match[2]],
  };
}
