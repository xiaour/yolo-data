// 业务词表的唯一来源：平台默认值放在 config/bootstrap/default.json 的 businessLexicon，
// 主题可用 semanticPolicy.lexicon 覆盖。代码只做通用的读取、合并与匹配，不内置业务词。
import fs from 'node:fs';

const CONFIG_URL = new URL('../config/bootstrap/default.json', import.meta.url);

const LIST_KEYS = [
  'metricTerms',
  'identifierPatterns',
  'rateTerms',
  'enumFieldTerms',
  'ignoredValues',
  'dimensionFallback',
];
const MAP_KEYS = ['dimensionAliases', 'dimensionValues'];
const PROFILE_HINT_KEYS = [
  'identifier',
  'rate',
  'average',
  'stock',
  'count',
  'extreme',
  'metric',
  'time',
];

let configLexicon = null;
let platformOverride = null;

function stringList(value) {
  const items = Array.isArray(value) ? value : [value];
  return [...new Set(items
    .map((item) => String(item ?? '').trim())
    .filter(Boolean))];
}

function normalizeProfileHint(value) {
  const spec = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { terms: value };
  return {
    wholeWord: spec.wholeWord === true,
    terms: stringList(spec.terms),
  };
}

export function normalizeLexicon(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const lexicon = { version: Number(source.version) || 1 };
  for (const key of LIST_KEYS) {
    lexicon[key] = stringList(source[key]);
  }
  for (const key of MAP_KEYS) {
    const map = source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
      ? source[key]
      : {};
    lexicon[key] = Object.fromEntries(
      Object.entries(map)
        .map(([name, terms]) => [String(name).trim(), stringList(terms)])
      .filter(([name, terms]) => name && terms.length > 0),
    );
  }
  const tax = source.taxPrefixes && typeof source.taxPrefixes === 'object'
    ? source.taxPrefixes
    : {};
  lexicon.taxPrefixes = {
    all: stringList(tax.all),
    excluded: stringList(tax.excluded),
  };
  const hints = source.profileHints && typeof source.profileHints === 'object'
    ? source.profileHints
    : {};
  lexicon.profileHints = Object.fromEntries(
    PROFILE_HINT_KEYS.map((key) => [key, normalizeProfileHint(hints[key])]),
  );
  return lexicon;
}

function readConfigLexicon() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_URL, 'utf8'));
    return normalizeLexicon(parsed?.businessLexicon);
  } catch {
    return normalizeLexicon(null);
  }
}

function cachedConfigLexicon() {
  if (!configLexicon) {
    configLexicon = readConfigLexicon();
  }
  return configLexicon;
}

// 平台默认值优先取运行时设置（platform_settings.business.lexicon），没有时用仓库里的配置。
export function configureBusinessLexicon(value) {
  platformOverride = value && typeof value === 'object'
    ? normalizeLexicon(value)
    : null;
  return getPlatformLexicon();
}

export function getPlatformLexicon() {
  return platformOverride ?? cachedConfigLexicon();
}

function mergeProfileHint(base, override) {
  if (override.terms.length === 0 && !override.wholeWord) {
    return base;
  }
  return {
    wholeWord: override.wholeWord || base.wholeWord,
    terms: [...new Set([...base.terms, ...override.terms])],
  };
}

export function mergeLexicon(base, override) {
  const merged = normalizeLexicon(base);
  const source = normalizeLexicon(override);
  for (const key of LIST_KEYS) {
    merged[key] = [...new Set([...merged[key], ...source[key]])];
  }
  for (const key of MAP_KEYS) {
    const next = { ...merged[key] };
    for (const [name, terms] of Object.entries(source[key])) {
      next[name] = [...new Set([...(next[name] ?? []), ...terms])];
    }
    merged[key] = next;
  }
  merged.taxPrefixes = {
    all: [...new Set([...merged.taxPrefixes.all, ...source.taxPrefixes.all])],
    excluded: [...new Set([
      ...merged.taxPrefixes.excluded,
      ...source.taxPrefixes.excluded,
    ])],
  };
  for (const key of PROFILE_HINT_KEYS) {
    merged.profileHints[key] = mergeProfileHint(
      merged.profileHints[key],
      source.profileHints[key],
    );
  }
  return merged;
}

// 主题级词表覆盖平台默认值；传主题对象或语义包都可以。
export function resolveBusinessLexicon(theme) {
  const override = theme?.semanticPolicy?.lexicon ?? theme?.lexicon ?? null;
  return override ? mergeLexicon(getPlatformLexicon(), override) : getPlatformLexicon();
}

// 词表 -> 正则，供字段画像等场景复用；模式来自词表数据，不在代码里写词。
const patternCache = new Map();

export function lexiconPattern(terms, {
  wholeWord = false,
  flags = 'i',
  raw = false,
} = {}) {
  const items = stringList(terms);
  if (items.length === 0) {
    return null;
  }
  const key = `${wholeWord ? 'w' : 's'}:${raw ? 'r' : 'e'}:${flags}:${items.join('\u0001')}`;
  if (patternCache.has(key)) {
    return patternCache.get(key);
  }
  const escaped = raw
    ? items
    : items.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const body = escaped.join('|');
  const pattern = new RegExp(
    wholeWord ? `(^|[^a-z0-9])(${body})([^a-z0-9]|$)` : `(${body})`,
    flags,
  );
  patternCache.set(key, pattern);
  return pattern;
}

export function profileHintPattern(lexicon, key) {
  const hint = normalizeLexicon(lexicon).profileHints[key];
  if (!hint) {
    return null;
  }
  return lexiconPattern(hint.terms, { wholeWord: hint.wholeWord });
}
