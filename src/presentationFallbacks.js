// 展示契约的确定性兜底：在线模板与主题提示词规则补在模型推断之前，
// 避免模型漏字段或凭样本猜错时同一提示词下展示口径漂移。

import { normalizeFieldRule } from './resultPresentation.js';

export function buildOnlineTemplateRules(onlineTemplates, schema) {
  const rules = {};
  for (const field of schema) {
    const template = onlineTemplates?.[field.field];
    if (!template) {
      continue;
    }
    const normalized = normalizeFieldRule(
      { ...template, basis: 'ONLINE_METADATA' },
      { source: 'ONLINE_METADATA', defaultBasis: 'ONLINE_METADATA' },
    );
    if (normalized) {
      rules[field.field] = normalized;
    }
  }
  return rules;
}

// 展示优先级：在线元数据 > 主题提示词 > 模型基于结果样本的推断。
export function mergeDeterministicFallbacks(contract, {
  schema = [],
  themeRules = {},
  onlineTemplateRules = {},
} = {}) {
  const fields = { ...contract.fields };
  const fallbackFields = [];
  for (const field of schema) {
    const key = String(field?.field ?? '').trim();
    if (!key || fields[key]?.basis === 'ONLINE_METADATA') {
      continue;
    }
    if (onlineTemplateRules[key]) {
      fields[key] = onlineTemplateRules[key];
      fallbackFields.push({ field: key, basis: 'ONLINE_METADATA' });
      continue;
    }
    const themeRule = themeRules[key];
    if (themeRule && (!fields[key] || fields[key].basis === 'RESULT_EVIDENCE')) {
      fields[key] = themeRule;
      fallbackFields.push({ field: key, basis: 'THEME_PROMPT' });
    }
  }
  if (fallbackFields.length === 0) {
    return contract;
  }
  return {
    ...contract,
    fields,
    meta: {
      ...contract.meta,
      fieldCount: Object.keys(fields).length,
      fallbackFields,
    },
  };
}
