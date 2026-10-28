import { applySemanticPolicy } from './semanticPolicy.js';
import { classifyAnalysisSemantics } from './analysisSemantics.js';
import { extractTemporalMentions } from './timeSemantics.js';
import { inferAnalysisMode } from './queryIntent.js';
import { getPlatformLexicon } from './businessLexicon.js';

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

function promptDefaultsToTaxIncluded(prompt) {
  return /(?:未指定|未说明|未明确)[^\n。；;]{0,16}(?:默认|按)[^\n。；;]{0,8}含税|含税[^\n。；;]{0,8}(?:默认口径|默认)/.test(String(prompt ?? ''));
}

function metricFieldName(field) {
  return normalizeTerm(field?.displayName ?? field?.name ?? field?.fieldName);
}

function metricFieldId(field) {
  return String(field?.fieldName ?? field?.name ?? '').trim();
}

function matchPromptMetric(question, theme, datasetFields) {
  const prompt = String(theme?.systemPrompt ?? '');
  const questionText = normalizeTerm(question);
  const metricFields = (datasetFields ?? []).filter((field) => field.role === 'METRIC');
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
  const lexicon = getPlatformLexicon();
  const taxPrefixes = (lexicon.taxPrefixes?.all ?? [])
    .map(normalizeTerm)
    .sort((left, right) => right.length - left.length);
  const matched = metricFields.flatMap((field) => {
    const name = metricFieldName(field);
    const prefix = taxPrefixes.find((item) => name.startsWith(item)) ?? '';
    const core = prefix ? name.slice(prefix.length) : name;
    if (!core || !questionText.includes(core)) return [];
    return [{ field, core, prefix }];
  });
  if (matched.length === 1) return { field: matched[0].field, sourceText: matched[0].core };
  if (matched.length > 1 && promptDefaultsToTaxIncluded(prompt)) {
    const includedPrefix = taxPrefixes.find((item) => item === '含税');
    const included = matched.filter((item) => item.prefix === includedPrefix);
    const uniqueCores = new Set(included.map((item) => item.core));
    if (included.length === 1 && uniqueCores.size === 1) {
      return { field: included[0].field, sourceText: included[0].core };
    }
  }
  return null;
}

const NON_FAST_CATEGORIES = new Set([
  'TIME_GRAIN',
  'DIMENSION',
  'FILTER',
  'SCOPE',
  'RANKING',
  'COMPARISON',
  'CALCULATION',
  'TREND',
  'ATTRIBUTION',
  'RESULT_ACTION',
]);

export function buildSemanticFastPathDraft({
  question,
  theme,
  datasetFields = [],
  now = new Date(),
} = {}) {
  const text = String(question ?? '').trim();
  if (!text || (!theme?.semanticPolicy && !theme?.systemPrompt)) {
    return {
      eligible: false,
      reason: 'missing_semantic_policy',
      draft: {},
    };
  }

  const policyApplication = applySemanticPolicy({
    question: text,
    policy: theme.semanticPolicy,
    draft: {},
  });
  const metricMatches = (policyApplication.matches ?? [])
    .filter((match) => match.category === 'METRIC');
  if (metricMatches.length > 1) {
    return {
      eligible: false,
      reason: 'ambiguous_metric_policy',
      draft: {},
      metricMatches,
    };
  }

  if (metricMatches.length === 0) {
    const resolved = matchPromptMetric(text, theme, datasetFields);
    if (!resolved) {
      return {
        eligible: false,
        reason: 'no_unique_metric_policy_or_field_match',
        draft: {},
        metricMatches,
      };
    }
    const condition = {
      id: 'resolved-prompt-metric',
      sourceText: resolved.sourceText,
      kind: 'METRIC',
      status: 'RESOLVED',
      ruleSource: 'themePrompt/datasetFieldMatch',
    };
    policyApplication.draft.conditions.push(condition);
    policyApplication.draft.metricFields.push({
      field: metricFieldId(resolved.field),
      sourceText: resolved.sourceText,
      aggregator: resolved.field.aggregator || 'SUM',
      ruleSource: 'themePrompt/datasetFieldMatch',
      conditionIds: [condition.id],
    });
    metricMatches.push({
      category: 'METRIC',
      concept: resolved.field.displayName ?? metricFieldId(resolved.field),
      matchedText: resolved.sourceText,
      field: metricFieldId(resolved.field),
    });
  }

  const dimensionMatches = (policyApplication.matches ?? [])
    .filter((match) => match.category === 'DIMENSION');
  if (dimensionMatches.length > 0) {
    return {
      eligible: false,
      reason: 'dimension_breakdown_requires_full_workflow',
      draft: {},
      metricMatches,
    };
  }

  const analysisMode = inferAnalysisMode(text);
  if (analysisMode.mode === 'ATTRIBUTION') {
    return {
      eligible: false,
      reason: 'attribution_requires_full_workflow',
      draft: {},
      metricMatches,
    };
  }

  const profile = classifyAnalysisSemantics(text, now);
  const unsupportedCategories = profile.categories
    .filter((category) => NON_FAST_CATEGORIES.has(category.code))
    .map((category) => category.code);
  if (unsupportedCategories.length > 0) {
    return {
      eligible: false,
      reason: `unsupported_categories:${[...new Set(unsupportedCategories)].join(',')}`,
      draft: {},
      metricMatches,
    };
  }

  const timeMentions = extractTemporalMentions(text, now);
  if (timeMentions.length !== 1) {
    return {
      eligible: false,
      reason: timeMentions.length === 0
        ? 'missing_unique_time_window'
        : 'multiple_time_windows',
      draft: {},
      metricMatches,
    };
  }
  if (!timeMentions[0]?.dateInfo?.startDate || !timeMentions[0]?.dateInfo?.endDate) {
    return {
      eligible: false,
      reason: 'time_window_not_resolved',
      draft: {},
      metricMatches,
    };
  }

  return {
    eligible: true,
    reason: 'unique_metric_policy_and_single_time_window',
    draft: policyApplication.draft,
    matches: policyApplication.matches,
    metricMatches,
    timeMentions,
    analysisMode,
    profile,
  };
}

/**
 * Resolve a prompt-defined metric synonym across the datasets available to a
 * theme. When no primary dataset is configured, only return an automatic
 * choice if exactly one dataset has a complete, eligible semantic match.
 */
export async function resolveSemanticFastPathCandidate({
  question,
  theme,
  datasets = [],
  preferredDatasetId = null,
  loadDatasetFields,
  now = new Date(),
} = {}) {
  const preferred = datasets.find((dataset) => (
    preferredDatasetId != null
    && String(dataset.id) === String(preferredDatasetId)
  ));
  const candidatesToCheck = preferred ? [preferred] : datasets;
  const eligible = [];
  const errors = [];

  for (const dataset of candidatesToCheck) {
    try {
      const datasetFields = await loadDatasetFields(dataset);
      const fastPath = buildSemanticFastPathDraft({
        question,
        theme,
        datasetFields,
        now,
      });
      if (fastPath.eligible) eligible.push({ dataset, fastPath });
    } catch (error) {
      errors.push({ datasetId: dataset.id, error });
    }
  }

  return {
    candidate: eligible.length === 1 ? eligible[0] : null,
    ambiguous: eligible.length > 1,
    eligibleDatasetIds: eligible.map(({ dataset }) => dataset.id),
    errors,
  };
}
