import {
  adjudicateMetricResolution,
  resolveMetricCandidates,
} from './metricResolver.js';
import { analyzeResultFacts } from './resultAnalyst.js';

const DEFAULT_PLUGINS = [
  {
    id: 'core.semantic_resolver',
    name: '指标语义解析器',
    phase: 'SEMANTIC_RESOLVE',
    kind: 'PLATFORM',
    enabledByDefault: true,
    config: {
      threshold: 0.78,
      topN: 5,
    },
  },
  {
    id: 'core.result_analyst',
    name: '结果分析器',
    phase: 'RESULT_ANALYST',
    kind: 'PLATFORM',
    enabledByDefault: true,
    config: {
      topN: 3,
      anomalyZScore: 1.5,
    },
  },
  {
    id: 'core.contract_guard',
    name: '查询契约门禁',
    phase: 'VALIDATE',
    kind: 'PLATFORM',
    enabledByDefault: true,
    config: {},
  },
  {
    id: 'core.result_validator',
    name: '结果证据验证',
    phase: 'RESULT_VALIDATION',
    kind: 'PLATFORM',
    enabledByDefault: true,
    config: {},
  },
];

function normalizePlugin(value, index) {
  const definition = DEFAULT_PLUGINS.find((plugin) => plugin.id === value?.id);
  return {
    id: String(value?.id ?? `custom-plugin-${index + 1}`).trim(),
    name: String(value?.name ?? definition?.name ?? value?.id ?? '').trim(),
    phase: String(value?.phase ?? definition?.phase ?? '').trim().toUpperCase(),
    kind: String(value?.kind ?? definition?.kind ?? 'CUSTOM').trim().toUpperCase(),
    enabled: value?.enabled !== false,
    config: {
      ...(definition?.config ?? {}),
      ...(value?.config ?? {}),
    },
  };
}

export function normalizeAnalysisPlugins(policy) {
  const source = policy && typeof policy === 'object' ? policy : {};
  const configured = Array.isArray(source.plugins) ? source.plugins : [];
  const byId = new Map(
    configured.map(normalizePlugin).map((plugin) => [plugin.id, plugin]),
  );
  const defaults = DEFAULT_PLUGINS
    .filter((plugin) => plugin.enabledByDefault)
    .map((plugin) => byId.get(plugin.id) ?? normalizePlugin(plugin));
  const custom = [...byId.values()].filter((plugin) => (
    !DEFAULT_PLUGINS.some((definition) => definition.id === plugin.id)
  ));
  return [...defaults, ...custom].sort((left, right) => (
    left.phase.localeCompare(right.phase)
    || left.id.localeCompare(right.id)
  ));
}

export function enabledPluginsForPhase(policy, phase) {
  return normalizeAnalysisPlugins(policy)
    .filter((plugin) => plugin.phase === phase && plugin.enabled);
}

export function resolveWithPlugins({
  concept,
  candidates = [],
  policy = {},
}) {
  const resolver = enabledPluginsForPhase(policy, 'SEMANTIC_RESOLVE')
    .find((plugin) => plugin.id === 'core.semantic_resolver');
  const config = resolver?.config ?? {};
  const resolution = resolveMetricCandidates({
    concept,
    candidates,
    policyRules: policy.metrics ?? [],
    threshold: Number(config.threshold) || 0.78,
    topN: Number(config.topN) || 5,
  });
  return {
    plugin: resolver ?? null,
    ...resolution,
    adjudication: adjudicateMetricResolution(resolution),
  };
}

export function analyzeWithPlugins({
  columns = [],
  rows = [],
  policy = {},
}) {
  const analyst = enabledPluginsForPhase(policy, 'RESULT_ANALYST')
    .find((plugin) => plugin.id === 'core.result_analyst');
  const config = analyst?.config ?? {};
  return {
    plugin: analyst ?? null,
    facts: analyzeResultFacts({
      columns,
      rows,
      topLimit: Number(config.topN) || 3,
    }),
  };
}

export { DEFAULT_PLUGINS };
