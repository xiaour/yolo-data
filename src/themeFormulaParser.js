// 主题语义规则的公式与文本解析原语：赋值/箭头/名称列表切分，以及
// 「字段:聚合」四则公式的递归下降解析。规则构建器见 themeSemanticRules.js。

const OPERATOR_OPS = new Map([
  ['+', 'ADD'],
  ['-', 'SUBTRACT'],
  ['*', 'MULTIPLY'],
  ['/', 'DIVIDE'],
]);

export const AGGREGATORS = new Set(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNT_DISTINCT']);

export function splitNames(value) {
  return [...new Set(String(value ?? '')
    .split(/[,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

export function splitArrow(value) {
  const match = String(value ?? '').match(/^(.*?)\s*(?:->|→|=>)\s*(.*)$/);
  return match ? [match[1].trim(), match[2].trim()] : null;
}

export function splitAssignment(value) {
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
