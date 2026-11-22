// 主题业务口径写在主题提示词的 ```semantics 块里，代码只做通用解析与归并，
// 不内置任何业务词。语法（每行一条规则）：
//
// ```semantics
// 指标: <指标名>, <别名> = <字段A> - <字段B>
// 指标: <去重计数名> = <标识字段>:COUNT_DISTINCT
// 维度: <维度名>, <别名> -> <维度字段>
// 过滤: <过滤名> -> <字段> = <值>
// 枚举组: <分组名> -> <字段> = <值1>, <值2>
// ```
//
// 说明：
// - 每行 "<类型>: <内容>"，类型支持 指标/维度/过滤/枚举组，也支持英文 metric/dimension/filter/enumGroup。
// - 逗号分隔的多个名称中，第一个是业务词，其余是别名。
// - 指标公式支持 + - * / 和括号；单个字段可写成 字段:聚合方式。
// - 过滤值用逗号分隔多个时按 IN 处理，单个值按 EQ 处理。

import { normalizeSemanticPolicy } from './semanticPolicy.js';
import { AGGREGATORS, parseFormula, splitArrow, splitAssignment, splitNames } from './themeFormulaParser.js';

const BLOCK_PATTERN = /```semantics[^\S\r\n]*\r?\n([\s\S]*?)```/;

const RULE_TYPES = new Map([
  ['指标', 'metric'],
  ['metric', 'metric'],
  ['metrics', 'metric'],
  ['维度', 'dimension'],
  ['dimension', 'dimension'],
  ['dimensions', 'dimension'],
  ['过滤', 'filter'],
  ['filter', 'filter'],
  ['filters', 'filter'],
  ['枚举组', 'enumGroup'],
  ['枚举', 'enumGroup'],
  ['enumgroup', 'enumGroup'],
  ['enumgroups', 'enumGroup'],
  ['enums', 'enumGroup'],
]);

const PROMPT_PRIORITY = 100;
const PROMPT_ID_PREFIX = 'prompt-';

function buildMetricRule(content, index, issues) {
  const assignment = splitAssignment(content);
  if (!assignment) {
    issues.push(`指标规则缺少 "="：${content}`);
    return null;
  }
  const [namesPart, formulaPart] = assignment;
  const names = splitNames(namesPart);
  if (names.length === 0 || !formulaPart) {
    issues.push(`指标规则不完整：${content}`);
    return null;
  }
  const directField = formulaPart.match(/^([^()+\-*/\s]+?)\s*:\s*([A-Za-z_]+)$/);
  let target = null;
  try {
    target = directField
      ? { type: 'FIELD', field: directField[1].trim(), aggregator: directField[2].toUpperCase() }
      : {
        type: 'FORMULA',
        outputField: `${PROMPT_ID_PREFIX}metric_${index + 1}`,
        outputFormat: 'NUMBER',
        precision: null,
        expression: parseFormula(formulaPart),
      };
  } catch (error) {
    issues.push(`指标公式无法解析（${content}）：${error.message}`);
    return null;
  }
  if (target.type === 'FIELD' && !AGGREGATORS.has(target.aggregator)) {
    issues.push(`不支持的聚合方式：${content}`);
    return null;
  }
  return {
    id: `${PROMPT_ID_PREFIX}metric-${index + 1}`,
    concept: names[0],
    aliases: names,
    excludeWhen: [],
    priority: PROMPT_PRIORITY,
    exclusive: true,
    target,
  };
}

function buildFieldRule(content, index, kind, issues) {
  const arrow = splitArrow(content);
  let namesPart;
  let targetPart;
  if (arrow) {
    [namesPart, targetPart] = arrow;
  } else if (kind === 'filter' && splitAssignment(content)) {
    // 简写：过滤: 字段 = 值（枚举值本身作为可匹配的过滤名称）。
    namesPart = splitAssignment(content)[1];
    targetPart = content;
  } else {
    issues.push(`${kind === 'dimension' ? '维度' : '过滤'}规则需要使用 "->"，过滤规则也可写成 "字段 = 值"：${content}`);
    return null;
  }
  const names = splitNames(namesPart);
  if (names.length === 0 || !targetPart) {
    issues.push(`规则不完整：${content}`);
    return null;
  }
  const base = {
    id: `${PROMPT_ID_PREFIX}${kind}-${index + 1}`,
    concept: names[0],
    aliases: names,
    excludeWhen: [],
    priority: PROMPT_PRIORITY,
    ruleSource: '',
  };
  if (kind === 'dimension') {
    return { ...base, field: targetPart, operator: 'IN' };
  }
  const assignment = splitAssignment(targetPart);
  if (!assignment || !assignment[0] || !assignment[1]) {
    issues.push(`过滤规则需要写成 "字段 = 值"：${content}`);
    return null;
  }
  const values = splitNames(assignment[1]);
  return {
    ...base,
    field: assignment[0],
    operator: values.length > 1 ? 'IN' : 'EQ',
    value: values.length > 1 ? values : values[0],
  };
}

function buildEnumGroup(content, index, issues) {
  const arrow = splitArrow(content);
  const [namesPart, targetPart] = arrow
    ?? (() => {
      // 简写：枚举组: 字段 = 值1, 值2（字段名同时作为组名）。
      const assignment = splitAssignment(content);
      return assignment ? [assignment[0], content] : [content, ''];
    })();
  if (!targetPart) {
    issues.push(`枚举组规则需要使用 "->"，或写成 "字段 = 值1, 值2"：${content}`);
    return null;
  }
  const names = splitNames(namesPart);
  const assignment = splitAssignment(targetPart);
  if (names.length === 0 || !assignment || !assignment[0] || !assignment[1]) {
    issues.push(`枚举组规则需要写成 "字段 = 值1, 值2"：${content}`);
    return null;
  }
  const values = splitNames(assignment[1]);
  if (values.length === 0) {
    issues.push(`枚举组缺少枚举值：${content}`);
    return null;
  }
  return {
    id: `${PROMPT_ID_PREFIX}enum-${index + 1}`,
    name: names[0],
    aliases: names,
    field: assignment[0],
    values,
    exclusive: true,
  };
}

export function parseSemanticBlock(prompt) {
  const match = String(prompt ?? '').match(BLOCK_PATTERN);
  if (!match) {
    return { policy: null, issues: [] };
  }
  const collections = { metric: [], dimension: [], filter: [], enumGroup: [] };
  const issues = [];
  const counters = { metric: 0, dimension: 0, filter: 0, enumGroup: 0 };
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) {
      continue;
    }
    const lineMatch = line.match(/^([^:：]+)[:：]\s*(.+)$/);
    const kind = lineMatch ? RULE_TYPES.get(lineMatch[1].trim().toLowerCase()) : null;
    if (!kind) {
      issues.push(`无法识别的规则行：${line}`);
      continue;
    }
    const content = lineMatch[2].trim();
    const index = counters[kind];
    counters[kind] += 1;
    if (kind === 'metric') {
      const rule = buildMetricRule(content, index, issues);
      if (rule) {
        collections.metric.push(rule);
      }
    } else if (kind === 'enumGroup') {
      const rule = buildEnumGroup(content, index, issues);
      if (rule) {
        collections.enumGroup.push(rule);
      }
    } else {
      const rule = buildFieldRule(content, index, kind, issues);
      if (rule) {
        collections[kind].push(rule);
      }
    }
  }
  const total = Object.values(collections).reduce((sum, list) => sum + list.length, 0);
  if (total === 0) {
    return { policy: null, issues };
  }
  const normalized = normalizeSemanticPolicy({
    version: 2,
    metrics: collections.metric,
    dimensions: collections.dimension,
    filters: collections.filter,
    enumGroups: collections.enumGroup,
  });
  return { policy: normalized, issues };
}

function mergeByConcept(stored = [], fromPrompt = []) {
  const concepts = new Set(fromPrompt.map((rule) => (
    rule.concept ?? rule.name ?? ''
  )));
  return [
    ...fromPrompt,
    ...(stored ?? []).filter((rule) => !concepts.has(rule.concept ?? rule.name ?? '')),
  ];
}

// 提示词里的规则优先于数据库里保存的语义包，两边同名的以提示词为准。
export function mergeThemeSemanticPolicy(prompt, storedPolicy) {
  const { policy } = parseSemanticBlock(prompt);
  if (!policy) {
    return storedPolicy ?? {};
  }
  const stored = storedPolicy && typeof storedPolicy === 'object' ? storedPolicy : {};
  return normalizeSemanticPolicy({
    ...stored,
    metrics: mergeByConcept(stored.metrics, policy.metrics),
    dimensions: mergeByConcept(stored.dimensions, policy.dimensions),
    filters: mergeByConcept(stored.filters, policy.filters),
    enumGroups: mergeByConcept(stored.enumGroups, policy.enumGroups),
  });
}

export function isPromptSemanticRule(rule) {
  return String(rule?.id ?? '').startsWith(PROMPT_ID_PREFIX);
}

export { PROMPT_ID_PREFIX };
export { parseFormula };
