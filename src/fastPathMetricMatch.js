import { getPlatformLexicon } from './businessLexicon.js';

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requestedTaxBasis(text, prefixes, excluded) {
  const expression = new RegExp(prefixes.map(escapePattern).join('|'), 'g');
  const bases = new Set([...text.matchAll(expression)].map(([prefix]) => excluded.has(prefix)));
  return bases;
}

function normalizeTerm(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '').trim();
}

function promptMetricSynonyms(prompt) {
  const mappings = [];
  for (const line of String(prompt ?? '').split(/\r?\n/)) {
    if (!/指标同义词/.test(line)) continue;
    const separator = line.includes('：') ? line.indexOf('：') : line.indexOf(':');
    if (separator < 0) continue;
    for (const item of line.slice(separator + 1).split(/[；;，,]/)) {
      const match = item.match(/^\s*([^=＝]+?)\s*[=＝]\s*(.+?)\s*$/);
      if (match) mappings.push({ alias: match[1].trim(), target: match[2].trim() });
    }
  }
  return mappings;
}

function promptDefaultsToTaxIncluded(prompt, included) {
  return included.some(prefix => new RegExp(
    '(?:未指定|未说明|未明确)[^\\n。；;]{0,16}(?:默认|按)[^\\n。；;]{0,8}' + escapePattern(prefix)
      + '|' + escapePattern(prefix) + '[^\\n。；;]{0,8}(?:默认口径|默认)',
  ).test(String(prompt ?? '')));
}

function metricFieldName(field) {
  return normalizeTerm(field?.displayName ?? field?.name ?? field?.fieldName);
}

export function metricFieldId(field) {
  return String(field?.fieldName ?? field?.name ?? '').trim();
}

export function matchPromptMetric(question, theme, datasetFields) {
  const prompt = String(theme?.systemPrompt ?? '');
  const questionText = normalizeTerm(question);
  const tax = getPlatformLexicon().taxPrefixes;
  const taxPrefixes = (tax?.all ?? []).map(normalizeTerm).filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const excluded = new Set((tax?.excluded ?? []).map(normalizeTerm));
  const requested = taxPrefixes.length ? requestedTaxBasis(questionText, taxPrefixes, excluded) : new Set();
  if (requested.size > 1) return null;
  const basis = requested.size ? [...requested][0] : null;
  const prefixOf = field => taxPrefixes.find(prefix => metricFieldName(field).startsWith(prefix)) ?? '';
  const metricFields = (datasetFields ?? []).filter(field => field.role === 'METRIC')
    .filter(field => basis === null || (prefixOf(field) && excluded.has(prefixOf(field)) === basis));
  const exactSynonymMatches = promptMetricSynonyms(prompt)
    .filter(({ alias }) => questionText.includes(normalizeTerm(alias)))
    .sort((left, right) => right.alias.length - left.alias.length);
  if (exactSynonymMatches.length > 0) {
    const bestLength = exactSynonymMatches[0].alias.length;
    const aliases = exactSynonymMatches.filter((item) => item.alias.length === bestLength);
    const targets = new Set(aliases.map((item) => normalizeTerm(item.target)));
    if (targets.size !== 1) return null;
    const target = [...targets][0];
    const fields = metricFields.filter((field) => (
      [metricFieldId(field), field.displayName, field.description]
        .some((value) => normalizeTerm(value) === target)
    ));
    if (fields.length === 1) {
      return { field: fields[0], sourceText: aliases[0].alias };
    }
    if (fields.length > 1) return null;
  }

  // A metric's tax prefix is a modifier, not a separate business concept.
  // Only collapse that modifier when the prompt explicitly defines the
  // default tax basis; ambiguous same-core metrics otherwise remain blocked.
  const matched = metricFields.flatMap((field) => {
    const name = metricFieldName(field);
    const prefix = taxPrefixes.find((item) => name.startsWith(item)) ?? '';
    const core = prefix ? name.slice(prefix.length) : name;
    if (!core || !questionText.includes(core)) return [];
    return [{ field, core, prefix }];
  });
  if (matched.length === 1) return { field: matched[0].field, sourceText: matched[0].core };
  if (matched.length > 1 && promptDefaultsToTaxIncluded(prompt, taxPrefixes.filter(prefix => !excluded.has(prefix)))) {
    const included = matched.filter(item => item.prefix && !excluded.has(item.prefix));
    const uniqueCores = new Set(included.map((item) => item.core));
    if (included.length === 1 && uniqueCores.size === 1) {
      return { field: included[0].field, sourceText: included[0].core };
    }
  }
  return null;
}

