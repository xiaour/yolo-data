import { applySemanticPolicy } from './semanticPolicy.js';
import { classifyAnalysisSemantics } from './analysisSemantics.js';
import { extractTemporalMentions } from './timeSemantics.js';
import { inferAnalysisMode } from './queryIntent.js';

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
  now = new Date(),
} = {}) {
  const text = String(question ?? '').trim();
  if (!text || !theme?.semanticPolicy) {
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
  if (metricMatches.length !== 1) {
    return {
      eligible: false,
      reason: metricMatches.length === 0
        ? 'no_unique_metric_policy'
        : 'ambiguous_metric_policy',
      draft: {},
      metricMatches,
    };
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
