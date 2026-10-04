// 主题业务口径写在主题提示词的 ```semantics 块里，代码只做通用解析与归并，
// 不内置任何业务词。语法（每行一条规则）：
//
// ```semantics
// 指标: 毛利额, 毛利 = 含税销售额 - 含税成本额
// 指标: 客户数 = 客户编码:COUNT_DISTINCT
// 维度: 大区, 区域 -> 销售大区名称
// 过滤: 日配业务 -> 业务类型名称 = 日配业务
// 枚举组: 大福利 -> 业务类型名称 = 福利业务, 福利小店, BBC
// ```
//
// 说明：
// - 每行 "<类型>: <内容>"，类型支持 指标/维度/过滤/枚举组，也支持英文 metric/dimension/filter/enumGroup。
// - 逗号分隔的多个名称中，第一个是业务词，其余是别名。
// - 指标公式支持 + - * / 和括号；单个字段可写成 字段:聚合方式。
// - 过滤值用逗号分隔多个时按 IN 处理，单个值按 EQ 处理。

import { normalizeSemanticPolicy } from './semanticPolicy.js';

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

const OPERATOR_OPS = new Map([
  ['+', 'ADD'],
  ['-', 'SUBTRACT'],
  ['*', 'MULTIPLY'],
  ['/', 'DIVIDE'],
]);

const AGGREGATORS = new Set(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNT_DISTINCT']);

const PROMPT_PRIORITY = 100;
const PROMPT_ID_PREFIX = 'prompt-';

function splitNames(value) {
  return [...new Set(String(value ?? '')
    .split(/[,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function splitArrow(value) {
  const match = String(value ?? '').match(/^(.*?)\s*(?:->|→|=>)\s*(.*)$/);
  return match ? [match[1].trim(), match[2].trim()] : null;
}

function splitAssignment(value) {
  const index = String(value ?? '').indexOf('=');
  if (index < 0) {
    return null;
  }
  return [
    String(value).slice(0, index).trim(),
    String(value).slice(index + 1).trim(),
  ];
}

function tokenizeFormula(source) {
  const text = String(source ?? '');
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if ('()+-*/'.includes(character)) {
      tokens.push({ type: 'operator', value: character });
      index += 1;
      continue;
    }
    let end = index;
    while (end < text.length && !/[\s()+\-*/]/.test(text[end])) {
      end += 1;
    }
    const name = text.slice(index, end);
    index = end;
    const [field, aggregator] = name.split(':');
    if (!field) {
      throw new Error(`公式中存在空字段名：${source}`);
    }
    tokens.push({
      type: 'name',
      value: field.trim(),
      aggregator: aggregator ? aggregator.trim().toUpperCase() : null,
    });
  }
  return tokens;
}

function buildFieldNode(token) {
  const aggregator = token.aggregator ?? 'SUM';
  if (!AGGREGATORS.has(aggregator)) {
    throw new Error(`不支持的聚合方式：${token.aggregator}`);
  }
  return { op: 'FIELD', field: token.value, aggregator };
}

// 递归下降解析：expr := term (('+'|'-') term)*；term := factor (('*'|'/') factor)*
export function parseFormula(source) {
  const tokens = tokenizeFormula(source);
  if (tokens.length === 0) {
    throw new Error('公式为空');
  }
  let cursor = 0;
  const peek = () => tokens[cursor];
  const parseExpression = () => {
    let left = parseTerm();
    while (peek()?.type === 'operator' && ['+', '-'].includes(peek().value)) {
      const operator = OPERATOR_OPS.get(tokens[cursor].value);
      cursor += 1;
      left = { op: operator, left, right: parseTerm() };
    }
    return left;
  };
  const parseTerm = () => {
    let left = parseFactor();
    while (peek()?.type === 'operator' && ['*', '/'].includes(peek().value)) {
      const operator = OPERATOR_OPS.get(tokens[cursor].value);
      cursor += 1;
      left = { op: operator, left, right: parseFactor() };
    }
    return left;
  };
  const parseFactor = () => {
    const token = tokens[cursor];
    if (!token) {
      throw new Error('公式不完整');
    }
    if (token.type === 'operator' && token.value === '(') {
      cursor += 1;
      const inner = parseExpression();
      if (!(tokens[cursor]?.type === 'operator' && tokens[cursor].value === ')')) {
        throw new Error('公式缺少右括号');
      }
      cursor += 1;
      return inner;
    }
    if (token.type !== 'name') {
      throw new Error(`公式中出现意外的符号：${token.value}`);
    }
    cursor += 1;
    return buildFieldNode(token);
  };
  const expression = parseExpression();
  if (cursor !== tokens.length) {
    throw new Error(`公式存在多余内容：${tokens.slice(cursor).map((item) => item.value).join(' ')}`);
  }
  return expression;
}

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
  if (!arrow) {
    issues.push(`${kind === 'dimension' ? '维度' : '过滤'}规则缺少 "->"：${content}`);
    return null;
  }
  const [namesPart, targetPart] = arrow;
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
  if (!arrow) {
    issues.push(`枚举组规则缺少 "->"：${content}`);
    return null;
  }
  const [namesPart, targetPart] = arrow;
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
