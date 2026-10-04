// 展示规则（金额单位、精度、比率口径等）属于业务口径，不允许写死在代码里。
// 代码只提供通用解析与投影能力，规则值由主题提示词中的声明块提供：
//
//   ```presentation
//   {
//     "amount":  { "unit": "万元", "decimals": 0, "match": ["<业务字段命中词>"] },
//     "percent": { "decimals": 1, "match": ["<业务字段命中词>"], "inputScale": "fraction" },
//     "fields":  { "<字段名>": "amount", "<字段名>": { "type": "percent", "decimals": 2 } }
//   }
//   ```
//
// - match 是该主题自己的业务字段命中词，只写在提示词里，代码不内置任何词表。
// - inputScale 取 fraction（默认，0.084 表示 8.4%）或 points（8.4 表示 8.4%）。
// - fields 用类型字符串或对象覆盖单个字段，优先于 match。

const PRESENTATION_BLOCK_PATTERN = /```presentation[^\S\r\n]*\r?\n([\s\S]*?)```/;

const PRESENTATION_TYPES = new Set(['amount', 'quantity', 'percent', 'number']);

const MAGNITUDE_FACTORS = {
  万亿: 1e12,
  亿: 1e8,
  万: 1e4,
  千: 1e3,
  百: 1e2,
};

function cleanUnit(value, fallback = '') {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f\s]+/g, '');
  return text ? text.slice(0, 8) : fallback;
}

function normalizeDecimals(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(0, Math.min(6, number)) : fallback;
}

function normalizeScale(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1e12
    ? number
    : null;
}

// 把“万元 / 亿元 / 千元”这类带数量级的单位，还原成一个原始单位对应的展示量级。
function scaleFromUnit(unit) {
  const text = cleanUnit(unit);
  const magnitude = text.match(/^(万亿|亿|万|千|百)/);
  return magnitude ? 1 / MAGNITUDE_FACTORS[magnitude[1]] : 1;
}

function normalizeMatchTerms(value) {
  const items = Array.isArray(value) ? value : [value];
  return items
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

function normalizeKindRule(type, value) {
  const spec = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const unit = cleanUnit(spec.unit, type === 'percent' ? '%' : '');
  const inputScale = String(spec.inputScale ?? '').trim().toLowerCase() === 'points'
    ? 'points'
    : 'fraction';
  const displayScale = type === 'percent'
    ? (inputScale === 'points' ? 1 : 100)
    : (normalizeScale(spec.displayScale)
      ?? normalizeScale(spec.scale)
      ?? scaleFromUnit(unit));
  return {
    type,
    unit,
    decimals: normalizeDecimals(spec.decimals, type === 'percent' ? 1 : 2),
    displayScale,
    xlsxScale: type === 'percent'
      ? (inputScale === 'points' ? 0.01 : 1)
      : displayScale,
    match: normalizeMatchTerms(spec.match),
  };
}

export function parsePresentationSpec(prompt) {
  const block = String(prompt ?? '').match(PRESENTATION_BLOCK_PATTERN);
  if (!block) {
    return null;
  }
  let declared = null;
  try {
    declared = JSON.parse(block[1]);
  } catch {
    return null;
  }
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    return null;
  }
  const rules = new Map();
  for (const [key, value] of Object.entries(declared)) {
    const type = String(key ?? '').trim().toLowerCase();
    if (type === 'fields' || !PRESENTATION_TYPES.has(type)) {
      continue;
    }
    rules.set(type, normalizeKindRule(type, value));
  }
  const fields = {};
  const declaredFields = declared.fields;
  if (declaredFields && typeof declaredFields === 'object' && !Array.isArray(declaredFields)) {
    for (const [field, value] of Object.entries(declaredFields)) {
      const name = String(field ?? '').trim();
      if (!name) {
        continue;
      }
      if (typeof value === 'string') {
        const type = value.trim().toLowerCase();
        if (PRESENTATION_TYPES.has(type)) {
          fields[name] = { type };
        }
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const type = String(value.type ?? '').trim().toLowerCase();
        if (PRESENTATION_TYPES.has(type)) {
          fields[name] = normalizeKindRule(type, value);
        }
      }
    }
  }
  return rules.size === 0 && Object.keys(fields).length === 0
    ? null
    : { rules, fields };
}

function fieldText(field) {
  return [
    field?.label,
    field?.field,
    field?.name,
    field?.bizName,
  ].map((value) => String(value ?? '')).join(' ').toLowerCase();
}

function matchKind(rules, field) {
  const text = fieldText(field);
  let best = null;
  for (const rule of rules.values()) {
    for (const term of rule.match) {
      const keyword = term.toLowerCase();
      if (!keyword || !text.includes(keyword)) {
        continue;
      }
      if (!best || keyword.length > best.keyword.length) {
        best = { rule, keyword };
      }
    }
  }
  return best?.rule ?? null;
}

function kindForField(spec, field, key) {
  const explicit = spec.fields[key];
  if (explicit) {
    return explicit.match
      ? explicit
      : (spec.rules.get(explicit.type) ?? normalizeKindRule(explicit.type, {}));
  }
  return matchKind(spec.rules, field);
}

export function buildThemeColumnRules(prompt, schema = []) {
  const spec = parsePresentationSpec(prompt);
  if (!spec) {
    return {};
  }
  const rules = {};
  for (const field of schema) {
    const key = String(field?.field ?? '').trim();
    if (!key) {
      continue;
    }
    const kind = kindForField(spec, field, key);
    if (!kind) {
      continue;
    }
    rules[key] = {
      type: kind.type,
      unit: kind.unit,
      displayScale: kind.displayScale,
      xlsxScale: kind.xlsxScale,
      decimals: kind.decimals,
      basis: 'THEME_PROMPT',
      reason: `主题提示词展示声明：${kind.type} 按 ${kind.unit || '原始单位'}、${kind.decimals} 位小数展示`,
    };
  }
  return rules;
}
