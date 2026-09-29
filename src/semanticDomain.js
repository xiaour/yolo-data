import crypto from 'node:crypto';

export const VALUE_ORIGINS = Object.freeze({
  DORIS_DISTINCT: 'DORIS_DISTINCT',
  DATASET_METADATA: 'DATASET_METADATA',
  THEME_SEMANTIC_POLICY: 'THEME_SEMANTIC_POLICY',
  THEME_PROMPT: 'THEME_PROMPT',
  MANUAL_VERIFIED: 'MANUAL_VERIFIED',
  MANUAL_OVERRIDE: 'MANUAL_OVERRIDE',
  MODEL_PROPOSED: 'MODEL_PROPOSED',
  FILE_IMPORT: 'FILE_IMPORT',
});

export const VALUE_DOMAIN_STATUSES = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  REFRESHING: 'REFRESHING',
  PARTIAL: 'PARTIAL',
  COMPLETE: 'COMPLETE',
  STALE: 'STALE',
  FAILED: 'FAILED',
});

export const REFRESH_MODES = Object.freeze({
  MANUAL: 'MANUAL',
  ON_DEMAND: 'ON_DEMAND',
  SCHEDULED: 'SCHEDULED',
  EVENT_DRIVEN: 'EVENT_DRIVEN',
});

const ORIGIN_RANK = {
  [VALUE_ORIGINS.MODEL_PROPOSED]: 10,
  [VALUE_ORIGINS.FILE_IMPORT]: 20,
  [VALUE_ORIGINS.DATASET_METADATA]: 40,
  [VALUE_ORIGINS.THEME_PROMPT]: 50,
  [VALUE_ORIGINS.THEME_SEMANTIC_POLICY]: 70,
  [VALUE_ORIGINS.MANUAL_VERIFIED]: 90,
  [VALUE_ORIGINS.DORIS_DISTINCT]: 100,
  [VALUE_ORIGINS.MANUAL_OVERRIDE]: 110,
};

const DEFAULT_DATASET_SOURCES = [
  VALUE_ORIGINS.DORIS_DISTINCT,
  VALUE_ORIGINS.DATASET_METADATA,
  VALUE_ORIGINS.THEME_SEMANTIC_POLICY,
  VALUE_ORIGINS.THEME_PROMPT,
];

const DEFAULT_INDICATOR_SOURCES = [
  VALUE_ORIGINS.THEME_SEMANTIC_POLICY,
  VALUE_ORIGINS.THEME_PROMPT,
  VALUE_ORIGINS.MANUAL_VERIFIED,
];

function compact(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s，,。；;：:！!？?、"'“”‘’（）()【】[\]{}_-]/g, '');
}

function uniqueStrings(values) {
  return [...new Set((values ?? [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))];
}

export function originRank(origin) {
  return ORIGIN_RANK[normalizeValueOrigin(origin)] ?? 0;
}

export function normalizeValueOrigin(value, sourceType = 'DATASET') {
  const source = String(value ?? '').trim().toUpperCase();
  if (Object.values(VALUE_ORIGINS).includes(source)) {
    return source;
  }
  if (source === 'SOURCE_VALUES') {
    return VALUE_ORIGINS.DORIS_DISTINCT;
  }
  if (source === 'DESCRIPTION') {
    return String(sourceType ?? '').toUpperCase() === 'INDICATOR'
      ? ''
      : VALUE_ORIGINS.DATASET_METADATA;
  }
  if (source === 'PROMPT') {
    return VALUE_ORIGINS.THEME_PROMPT;
  }
  return '';
}

export function fieldPolicyConfig(rawValue, sourceType = 'DATASET') {
  if (rawValue === true || rawValue === false || rawValue == null) {
    return {
      enabled: rawValue !== false,
      sources: sourceType === 'INDICATOR'
        ? [...DEFAULT_INDICATOR_SOURCES]
        : [...DEFAULT_DATASET_SOURCES],
      refreshMode: REFRESH_MODES.ON_DEMAND,
      ttlSeconds: 3600,
      maxValues: 200,
      allowUnverifiedPolicyValue: false,
      rejectUnknownValue: true,
    };
  }
  if (typeof rawValue !== 'object' || Array.isArray(rawValue)) {
    return fieldPolicyConfig(true, sourceType);
  }
  const sourceList = Array.isArray(rawValue.sources)
    ? rawValue.sources.map((value) => normalizeValueOrigin(value, sourceType)).filter(Boolean)
    : [];
  return {
    enabled: rawValue.enabled !== false,
    sources: sourceList.length > 0
      ? sourceList
      : sourceType === 'INDICATOR'
        ? [...DEFAULT_INDICATOR_SOURCES]
        : [...DEFAULT_DATASET_SOURCES],
    refreshMode: Object.values(REFRESH_MODES).includes(String(rawValue.refreshMode).toUpperCase())
      ? String(rawValue.refreshMode).toUpperCase()
      : REFRESH_MODES.ON_DEMAND,
    ttlSeconds: Number.isFinite(Number(rawValue.ttlSeconds))
      ? Math.max(1, Number(rawValue.ttlSeconds))
      : 3600,
    maxValues: Number.isFinite(Number(rawValue.maxValues))
      ? Math.max(1, Math.min(1000, Number(rawValue.maxValues)))
      : 200,
    allowUnverifiedPolicyValue: rawValue.allowUnverifiedPolicyValue === true,
    rejectUnknownValue: rawValue.rejectUnknownValue !== false,
  };
}

export function semanticDomainKey(sourceType, sourceId, fieldName) {
  return [
    String(sourceType ?? '').toUpperCase(),
    String(sourceId ?? ''),
    String(fieldName ?? ''),
  ].join(':');
}

export function schemaFingerprint(fields) {
  const values = (fields ?? []).map((field) => [
    String(field?.fieldName ?? field?.name ?? ''),
    String(field?.displayName ?? field?.dimensionName ?? ''),
    String(field?.role ?? ''),
    String(field?.semanticType ?? ''),
    String(field?.aggregator ?? ''),
    String(field?.description ?? ''),
  ]);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(values))
    .digest('hex')
    .slice(0, 24);
}

export function scopeSignature(scope = {}) {
  const policies = [
    ...(scope?.rowPolicies ?? []).map((policy) => ({
      dimension: policy.dimension,
      operator: policy.operator,
      values: policy.values ?? [],
    })),
    ...(scope?.columnPolicies ?? []).map((policy) => ({
      columnName: policy.columnName ?? policy.field,
      action: policy.action,
    })),
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(policies))
    .digest('hex')
    .slice(0, 24);
}

export function mergeValueCandidates(groups = []) {
  const merged = new Map();
  for (const group of groups) {
    for (const candidate of group ?? []) {
      if (!candidate || candidate.value === null || candidate.value === undefined) {
        continue;
      }
      const value = String(candidate.value).trim();
      const key = compact(value);
      if (!key) {
        continue;
      }
      const origin = normalizeValueOrigin(candidate.origin ?? candidate.source);
      const current = merged.get(key) ?? {
        value,
        aliases: [],
        origins: [],
        originRefs: [],
        confidence: Number(candidate.confidence ?? 1),
      };
      current.aliases = uniqueStrings([
        ...current.aliases,
        ...(candidate.aliases ?? []),
        value,
      ]);
      if (origin && !current.origins.includes(origin)) {
        current.origins.push(origin);
      }
      if (candidate.originRef && !current.originRefs.includes(candidate.originRef)) {
        current.originRefs.push(String(candidate.originRef));
      }
      current.confidence = Math.min(
        Number.isFinite(Number(current.confidence)) ? Number(current.confidence) : 1,
        Number.isFinite(Number(candidate.confidence)) ? Number(candidate.confidence) : 1,
      );
      merged.set(key, current);
    }
  }
  return [...merged.values()]
    .map((candidate) => ({
      ...candidate,
      origin: candidate.origins
        .sort((left, right) => originRank(right) - originRank(left))[0] ?? '',
      originRef: candidate.originRefs[0] ?? '',
    }))
    .sort((left, right) => (
      originRank(right.origin) - originRank(left.origin)
      || left.value.localeCompare(right.value, 'zh-CN', { numeric: true })
    ));
}

export function extractPolicyCandidates(policy = {}, fieldName = '') {
  const candidates = [];
  for (const rule of policy?.filters ?? []) {
    if (
      String(rule.field ?? rule.targetField ?? '') !== String(fieldName ?? '')
      || !Array.isArray(rule.value)
    ) {
      continue;
    }
    for (const value of rule.value) {
      candidates.push({
        value,
        aliases: [String(rule.concept ?? rule.name ?? ''), String(rule.id ?? '')].filter(Boolean),
        origin: VALUE_ORIGINS.THEME_SEMANTIC_POLICY,
        originRef: `semanticPolicy:${rule.id ?? rule.concept ?? ''}`,
        confidence: 1,
      });
    }
  }
  return candidates;
}

export function extractPromptCandidates(prompt, field) {
  const labels = [
    field?.fieldName,
    field?.displayName,
    field?.name,
    field?.dimensionBizName,
    field?.dimensionName,
  ].filter(Boolean);
  if (labels.length === 0) {
    return [];
  }
  const candidates = [];
  for (const rawLine of String(prompt ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.length > 160 || /[。；;]/.test(line)) {
      continue;
    }
    const compactLine = compact(line);
    const label = labels
      .map(String)
      .find((item) => compactLine.includes(compact(item)));
    if (!label) {
      continue;
    }
    const tail = line.slice(line.indexOf(label) + label.length);
    const mapping = tail.match(
      /^\s*(?:枚举)?\s*(?:=|:|：|映射到|映射为|对应|包括|包含)\s*(.+)$/,
    );
    if (!mapping || mapping[1].length > 100) {
      continue;
    }
    const values = String(mapping[1])
      .split(/[、,，;；|/]+/)
      .map((item) => String(item).trim())
      .filter(Boolean);
    for (const value of values) {
      candidates.push({
        value,
        aliases: [String(label).trim()],
        origin: VALUE_ORIGINS.THEME_PROMPT,
        originRef: 'themePrompt',
        confidence: 0.7,
      });
    }
  }
  return candidates;
}

export function normalizeDomainStatus(value) {
  const status = String(value ?? '').trim().toUpperCase();
  return Object.values(VALUE_DOMAIN_STATUSES).includes(status)
    ? status
    : VALUE_DOMAIN_STATUSES.UNKNOWN;
}
