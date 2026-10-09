// 过滤值未唯一命中时的「选值澄清」。
//
// 平台在值域解析阶段已经算出候选值（`src/semanticValues.js`），这里负责把候选值
// 变成一次可点选的澄清：先问用户「你要的是哪个值」，而不是让模型就同一处歧义
// 展开成一串业务口径反问。本模块只做候选值的收集与呈现，不含任何业务口径。

// 需要用户从候选值里挑一个的契约门禁码。
export const VALUE_CLARIFICATION_CODES = Object.freeze({
  AMBIGUOUS: 'FILTER_VALUE_AMBIGUOUS',
  NOT_IN_DOMAIN: 'FILTER_VALUE_NOT_IN_DOMAIN',
});

const VALUE_OPTION_PREFIX = 'filter-value:';
const CHOICE_OPTION_PREFIX = 'choice:';
const MAX_MODEL_OPTIONS = 6;
const CANCEL_OPTION = {
  id: 'cancel',
  label: '都不是，停止本轮查询',
  description: '保留当前上下文，不执行新的数据查询。',
  recommended: false,
};

function candidateValue(item) {
  return String(typeof item === 'string' ? item : item?.value ?? '').trim();
}

export function collectValueCandidates(issues = []) {
  const codes = new Set(Object.values(VALUE_CLARIFICATION_CODES));
  const groups = [];
  for (const issue of issues ?? []) {
    if (!codes.has(String(issue?.code ?? ''))) {
      continue;
    }
    const candidates = [...new Set((issue?.candidates ?? []).map(candidateValue).filter(Boolean))];
    if (candidates.length === 0) {
      continue;
    }
    const field = String(issue?.field ?? '').trim();
    const requested = String(issue?.requestedValue ?? '').trim();
    const existing = groups.find((group) => group.field === field && group.requested === requested);
    if (existing) {
      existing.candidates = [...new Set([...existing.candidates, ...candidates])];
      continue;
    }
    groups.push({ field, requested, candidates, reason: issue?.reason ?? null });
  }
  return groups;
}

export function valueOptionId(group, value) {
  return `${VALUE_OPTION_PREFIX}${group?.field ?? ''}=${value}`;
}

export function choiceOptionId(label) {
  return `${CHOICE_OPTION_PREFIX}${String(label ?? '').trim()}`;
}

// 把选中的选项还原成一条可执行的过滤条件；不是选值选项时返回 null。
export function parseValueOption(id) {
  const text = String(id ?? '').trim();
  if (!text.startsWith(VALUE_OPTION_PREFIX)) {
    return null;
  }
  const rest = text.slice(VALUE_OPTION_PREFIX.length);
  const separator = rest.indexOf('=');
  if (separator <= 0) {
    return null;
  }
  const field = rest.slice(0, separator).trim();
  const value = rest.slice(separator + 1).trim();
  if (!field || !value) {
    return null;
  }
  return { field, value };
}

// 注入提示词：把选项 id 展开成平台已确认的过滤条件，避免模型自行解析 id。
export function describeClarificationOption(clarificationOptionId = '') {
  const parsed = parseValueOption(clarificationOptionId);
  if (parsed) {
    return `本轮澄清选项已解析为过滤条件：字段「${parsed.field}」=「${parsed.value}」。`
      + '该值已由用户确认，必须按此值提交 filterFields，不得替换为其它相近值，也不得就同一过滤值再次反问。';
  }
  const text = String(clarificationOptionId ?? '').trim();
  if (!text.startsWith(CHOICE_OPTION_PREFIX)) {
    return '';
  }
  const choice = text.slice(CHOICE_OPTION_PREFIX.length).trim();
  return choice
    ? `用户已选择「${choice}」，必须按该选择继续执行本轮查询，不得再就同一问题反问。`
    : '';
}

// 澄清话术面向业务人员：只说要确认什么 + 重点候选项，不出现内部术语和校验过程。
export function buildValueClarificationPrompt(groups) {
  if (groups.length === 1) {
    const [group] = groups;
    const [only] = group.candidates;
    if (group.candidates.length === 1) {
      return `没找到「${group.requested}」这个值，最接近的是「${only}」。是要查「${only}」吗？`
        + '如果不是，请告诉我准确的名称。';
    }
    return `「${group.requested}」对应多个可能的值，请选一个：${group.candidates.join('、')}。`;
  }
  const lines = groups.map((group) => (
    `- 「${group.requested}」→ ${group.candidates.join('、')}`
  ));
  return `以下名称对应多个可能的值，请分别选一个：\n${lines.join('\n')}`;
}

export function buildValueClarification(groups = [], { allowed = true } = {}) {
  const usable = (groups ?? []).filter((group) => (group?.candidates ?? []).length > 0);
  if (!allowed || usable.length === 0) {
    return null;
  }
  const options = [];
  const seen = new Set();
  for (const group of usable) {
    if (!group.field) {
      // 没有字段就无法把选择还原成过滤条件，不能给用户一个点了没用的选项。
      continue;
    }
    for (const value of group.candidates) {
      const id = valueOptionId(group, value);
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      options.push({
        id,
        label: value,
        description: '按该值继续查询本轮问题。',
        // 候选值之间不做推荐：分数接近的候选项没有哪个是「正确答案」。
        recommended: false,
      });
    }
  }
  if (options.length === 0) {
    return null;
  }
  return {
    type: 'NEEDS_CONFIRMATION',
    prompt: buildValueClarificationPrompt(usable),
    recommendedOptionId: null,
    options: [...options, { ...CANCEL_OPTION }],
  };
}

// 模型提出的澄清：平台只负责把它变成可点选的选项，不替它编造内容。
// 选项带 field + value 时按过滤条件处理，否则只作为一次普通选择回传。
export function buildModelClarification({ question, options } = {}, { allowed = true } = {}) {
  if (!allowed) {
    return null;
  }
  const prompt = String(question ?? '').trim();
  const items = (Array.isArray(options) ? options : [])
    .map((option) => ({
      label: String(option?.label ?? option?.value ?? '').trim(),
      field: String(option?.field ?? '').trim(),
      value: String(option?.value ?? '').trim(),
    }))
    .filter((option) => option.label)
    .slice(0, MAX_MODEL_OPTIONS);
  if (!prompt || items.length < 2) {
    return null;
  }
  return {
    type: 'NEEDS_CONFIRMATION',
    prompt,
    recommendedOptionId: null,
    options: [
      ...items.map((option) => ({
        id: option.field && option.value
          ? valueOptionId({ field: option.field }, option.value)
          : choiceOptionId(option.label),
        label: option.label,
        description: option.field && option.value
          ? '按该值继续查询本轮问题。'
          : '按该选择继续查询本轮问题。',
        recommended: false,
      })),
      { ...CANCEL_OPTION },
    ],
  };
}
