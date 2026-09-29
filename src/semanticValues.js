import crypto from 'node:crypto';
import {
  extractPolicyCandidates,
  fieldPolicyConfig,
  mergeValueCandidates,
  originRank,
  schemaFingerprint,
  scopeSignature,
  semanticDomainKey,
  VALUE_DOMAIN_STATUSES,
  VALUE_ORIGINS,
} from './semanticDomain.js';

const ENUM_FIELD_PATTERN =
  /类型|行业|分类|状态|渠道|模式|板块|等级|级别|属性|类别|enum/i;
const SEPARATOR_PATTERN = /[、,，;；|/]+/;
const GENERIC_VALUES = new Set(['其他', '其它', '全部', '无', '未知', '暂无']);

function compact(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s，,。；;：:！!？?、"'“”‘’（）()【】[\]{}_-]/g, '');
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function cleanCandidate(value) {
  let text = String(value ?? '').trim();
  text = text.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '');
  text = text.replace(
    /^\s*(?:\d{1,3}|[一二三四五六七八九十]+)\s*[.、:：)）-]\s*/, '',
  );
  text = text.replace(/[（(][^）)]*[）)]/g, '').trim();
  if (
    !text
    || text.length > 30
    || /[`。；;]/.test(text)
    || /^(?:不得|必须|需要|禁止|如果|若|当|用户|系统|平台)/.test(text)
  ) {
    return '';
  }
  return text;
}

function candidateRecord(rawValue) {
  const value = cleanCandidate(rawValue);
  if (!value || GENERIC_VALUES.has(value)) {
    return null;
  }
  const original = String(rawValue ?? '').trim();
  return {
    value,
    aliases: uniqueStrings([
      original,
      value,
      original.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, ''),
    ]).filter((item) => item && item.length <= 40),
  };
}

function extractQuotedCandidates(text) {
  const values = [];
  for (const match of String(text ?? '').matchAll(
    /['"“”‘’]([^'"“”‘’]{1,40})['"“”‘’]/g,
  )) {
    const candidate = candidateRecord(match[1]);
    if (candidate) {
      values.push(candidate);
    }
  }
  return values;
}

function extractCandidateList(text) {
  const quoted = extractQuotedCandidates(text);
  if (quoted.length >= 2) {
    return quoted;
  }
  return String(text ?? '')
    .split(SEPARATOR_PATTERN)
    .map(candidateRecord)
    .filter(Boolean);
}

export function extractDescriptionValues(description, { enumLike = false } = {}) {
  const text = String(description ?? '').trim();
  if (!text || !SEPARATOR_PATTERN.test(text)) {
    return [];
  }
  const quoted = extractQuotedCandidates(text);
  if (quoted.length >= 2) {
    return quoted;
  }
  const parenthetical = [...text.matchAll(/[（(]([^）)]+)[）)]/g)]
    .flatMap((match) => extractCandidateList(match[1]));
  if (parenthetical.length >= 2) {
    return parenthetical;
  }
  const candidates = extractCandidateList(text);
  if (candidates.length < 2) {
    return [];
  }
  if (enumLike) {
    return candidates;
  }
  return text.length <= 80
    && candidates.every((candidate) => candidate.value.length <= 12)
    ? candidates
    : [];
}

function lineContainsField(line, labels) {
  const compactLine = compact(line);
  return labels.some((label) => {
    const normalized = compact(label);
    return normalized
      && (compactLine.includes(normalized) || normalized.includes(compactLine));
  });
}

export function extractPromptValues(prompt, field = {}) {
  const labels = [
    field.fieldName,
    field.displayName,
    field.name,
    field.dimensionBizName,
    field.dimensionName,
  ].filter(Boolean);
  if (labels.length === 0) {
    return [];
  }
  const candidates = [];
  for (const rawLine of String(prompt ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      !line
      || line.length > 160
      || /[。；;]/.test(line)
      || !lineContainsField(line, labels)
    ) {
      continue;
    }
    const label = labels
      .map(String)
      .find((item) => line.includes(item));
    const index = label ? line.indexOf(label) : -1;
    const tail = index >= 0 ? line.slice(index + label.length) : line;
    const mapping = tail.match(
      /^\s*(?:枚举)?\s*(?:=|:|：|映射到|映射为|对应|包括|包含)\s*(.+)$/,
    );
    if (!mapping || mapping[1].length > 100) {
      continue;
    }
    const values = extractCandidateList(mapping[1]);
    const prefix = index > 0 ? line.slice(0, index).replace(/映射到\s*$/, '') : '';
    const aliases = prefix.split(/[、,，/;；+]+/).map(cleanCandidate).filter(Boolean);
    for (const candidate of values) {
      candidates.push({
        ...candidate,
        aliases: uniqueStrings([
          ...candidate.aliases,
          ...(values.length === 1 ? aliases : []),
        ]),
      });
    }
  }
  return candidates;
}

function diceCoefficient(left, right) {
  const a = compact(left);
  const b = compact(right);
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  if (a.includes(b) || b.includes(a)) {
    return Math.max(0.82, Math.min(a.length, b.length) / Math.max(a.length, b.length));
  }
  if (a.length < 2 || b.length < 2) {
    return 0;
  }
  const bigrams = (value) => Array.from(
    { length: value.length - 1 },
    (_, index) => value.slice(index, index + 2),
  );
  const leftBigrams = bigrams(a);
  const rightCounts = new Map();
  for (const value of bigrams(b)) {
    rightCounts.set(value, (rightCounts.get(value) ?? 0) + 1);
  }
  let overlap = 0;
  for (const value of leftBigrams) {
    const count = rightCounts.get(value) ?? 0;
    if (count > 0) {
      overlap += 1;
      rightCounts.set(value, count - 1);
    }
  }
  return (2 * overlap) / (leftBigrams.length + Math.max(1, b.length - 1));
}

export function resolveSemanticValue(requested, domain = null) {
  const values = domain?.values ?? [];
  const governance = domain?.governance ?? null;
  if (values.length === 0 || requested === null || requested === undefined) {
    return {
      matched: false,
      reason: 'NO_DOMAIN',
      domainStatus: governance?.status ?? 'UNKNOWN',
    };
  }
  const target = compact(requested);
  for (const value of values) {
    if (compact(value) === target) {
      return {
        matched: true,
        value,
        mode: 'EXACT',
        confidence: 1,
        alias: value,
        domainStatus: governance?.status ?? 'COMPLETE',
      };
    }
  }
  for (const value of values) {
    const aliases = domain?.aliases?.[value] ?? [];
    const alias = aliases.find((item) => compact(item) === target);
    if (alias) {
      return {
        matched: true,
        value,
        mode: 'ALIAS',
        confidence: 1,
        alias,
        domainStatus: governance?.status ?? 'COMPLETE',
      };
    }
  }
  const ranked = values
    .map((value) => ({
      value,
      score: Math.max(
        diceCoefficient(requested, value),
        ...(domain?.aliases?.[value] ?? []).map((alias) => (
          diceCoefficient(requested, alias)
        )),
      ),
    }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.score < 0.72) {
    return {
      matched: false,
      reason: 'NOT_FOUND',
      candidates: ranked.slice(0, 5),
      domainStatus: governance?.status ?? 'COMPLETE',
    };
  }
  if (second && best.score - second.score < 0.12) {
    return {
      matched: false,
      reason: 'AMBIGUOUS',
      candidates: ranked.slice(0, 5),
      domainStatus: governance?.status ?? 'COMPLETE',
    };
  }
  return {
    matched: true,
    value: best.value,
    mode: 'FUZZY',
    confidence: Number(best.score.toFixed(3)),
    alias: String(requested),
    domainStatus: governance?.status ?? 'COMPLETE',
  };
}

export function isPotentialEnumField(field = {}) {
  return ENUM_FIELD_PATTERN.test(
    `${field.fieldName ?? ''} ${field.displayName ?? ''} ${field.name ?? ''}`,
  );
}

export function semanticValueFieldKey(sourceType, sourceId, fieldName) {
  return semanticDomainKey(sourceType, sourceId, fieldName);
}

export function normalizeSemanticValueConfig(config = {}) {
  const fields = config?.fields && typeof config.fields === 'object'
    ? config.fields
    : {};
  return {
    enabled: config?.enabled !== false,
    autoDiscover: config?.autoDiscover !== false,
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => {
        const sourceType = String(key).split(':')[0]?.toUpperCase();
        return [key, fieldPolicyConfig(value, sourceType)];
      }),
    ),
  };
}

function domainSnapshotStatus(snapshot) {
  const status = String(snapshot?.status ?? '').toUpperCase();
  return Object.values(VALUE_DOMAIN_STATUSES).includes(status)
    ? status
    : VALUE_DOMAIN_STATUSES.UNKNOWN;
}

function sourceValuesOrigin(sourceType) {
  return String(sourceType ?? '').toUpperCase() === 'DATASET'
    ? VALUE_ORIGINS.DORIS_DISTINCT
    : VALUE_ORIGINS.MANUAL_VERIFIED;
}

function legacySourceLabel(origin, sourceLoaded) {
  if (
    origin === VALUE_ORIGINS.DORIS_DISTINCT
    || (origin === VALUE_ORIGINS.MANUAL_VERIFIED && sourceLoaded)
  ) {
    return 'SOURCE_VALUES';
  }
  if (origin === VALUE_ORIGINS.DATASET_METADATA) {
    return 'DESCRIPTION';
  }
  if (origin === VALUE_ORIGINS.THEME_PROMPT) {
    return 'PROMPT';
  }
  return origin;
}

export class SemanticValueRegistry {
  constructor(database) {
    this.database = database;
  }

  async enrichField({
    themeId,
    sourceType,
    sourceId,
    fieldName,
    displayName,
    description,
    prompt,
    valueLoader = null,
    config = {},
    preferStored = false,
    semanticPolicy = {},
    scope = {},
  }) {
    const normalizedSourceType = String(sourceType ?? '').toUpperCase();
    const normalizedConfig = normalizeSemanticValueConfig(config);
    if (!normalizedConfig.enabled) {
      return {
        fieldName,
        displayName,
        description,
      };
    }
    const fieldKey = semanticDomainKey(sourceType, sourceId, fieldName);
    const fieldPolicy = normalizedConfig.fields[fieldKey];
    if (!fieldPolicy || fieldPolicy.enabled === false) {
      return {
        fieldName,
        displayName,
        description,
      };
    }

    const field = {
      fieldName,
      displayName,
      description,
    };
    const enumLike = isPotentialEnumField(field);
    const schemaHash = schemaFingerprint([field]);
    const currentScopeSignature = scopeSignature(scope);
    const activeSnapshot = this.database.getActiveSemanticValueSnapshot({
      themeId,
      sourceType: normalizedSourceType,
      sourceId: String(sourceId),
      fieldName: String(fieldName),
    });
    const persistedItems = (activeSnapshot?.items ?? []).map((item) => ({
      value: item.value,
      aliases: item.aliases ?? [],
      origin: item.origin,
      originRef: item.originRef,
      confidence: item.confidence,
      firstSeenAt: item.firstSeenAt,
    }));
    const policyCandidates = extractPolicyCandidates(
      semanticPolicy,
      String(fieldName),
    );
    const promptCandidates = (enumLike || policyCandidates.length > 0)
      ? extractPromptValues(prompt, field).map((candidate) => ({
        ...candidate,
        origin: VALUE_ORIGINS.THEME_PROMPT,
        originRef: 'themePrompt',
        confidence: 0.7,
      }))
      : [];
    const metadataCandidates = normalizedSourceType === 'DATASET'
      ? extractDescriptionValues(description, { enumLike })
        .map((candidate) => ({
          ...candidate,
          origin: VALUE_ORIGINS.DATASET_METADATA,
          originRef: `dataset:${sourceId}`,
          confidence: 0.55,
        }))
      : [];

    const authoritativeOrigin = sourceValuesOrigin(normalizedSourceType);
    const hasAuthoritativeSnapshot = (activeSnapshot?.origins ?? [])
      .includes(authoritativeOrigin)
      && domainSnapshotStatus(activeSnapshot) === VALUE_DOMAIN_STATUSES.COMPLETE;
    const expired = activeSnapshot?.expiresAt
      && Date.parse(activeSnapshot.expiresAt) <= Date.now();
    const schemaChanged = Boolean(activeSnapshot?.schemaHash)
      && activeSnapshot.schemaHash !== schemaHash;
    const scopeChanged = Boolean(activeSnapshot?.scopeSignature)
      && activeSnapshot.scopeSignature !== currentScopeSignature;
    const forceRefresh = !preferStored;
    const needsSourceRefresh = forceRefresh
      || !activeSnapshot
      || !hasAuthoritativeSnapshot
      || expired
      || schemaChanged
      || scopeChanged;

    let sourceCandidates = [];
    let sourceLoaded = false;
    let sourceTruncated = false;
    let sourceError = '';
    if (
      needsSourceRefresh
      && normalizedConfig.autoDiscover
      && fieldPolicy.refreshMode !== 'MANUAL'
      && valueLoader
      && enumLike
    ) {
      try {
        const loaded = await valueLoader(field);
        sourceCandidates = (loaded ?? [])
          .map(candidateRecord)
          .filter(Boolean)
          .map((candidate) => ({
            ...candidate,
            origin: authoritativeOrigin,
            originRef: `${normalizedSourceType}:${sourceId}`,
            confidence: 1,
          }));
        sourceLoaded = true;
        sourceTruncated = sourceCandidates.length >= fieldPolicy.maxValues;
      } catch (error) {
        sourceError = String(error?.message ?? 'source refresh failed');
      }
    }

    const overrideRows = this.database.listSemanticValueOverrides({
      themeId,
      sourceType: normalizedSourceType,
      sourceId: String(sourceId),
      fieldName: String(fieldName),
    }).filter((override) => override.enabled);
    const excludedValues = new Set(
      overrideRows
        .filter((override) => override.action === 'EXCLUDE')
        .flatMap((override) => override.configuredValues)
        .map(compact),
    );
    const manualCandidates = overrideRows
      .filter((override) => override.action === 'ENUM_MAPPING')
      .flatMap((override) => override.configuredValues.map((value) => ({
        value,
        aliases: [
          override.concept,
          ...(override.aliases ?? []),
        ].filter(Boolean),
        origin: VALUE_ORIGINS.MANUAL_VERIFIED,
        originRef: `override:${override.id}`,
        confidence: 1,
      })));

    const availableCandidates = mergeValueCandidates([
      sourceLoaded ? sourceCandidates : persistedItems,
      metadataCandidates,
      promptCandidates,
      policyCandidates,
      manualCandidates,
    ])
      .filter((candidate) => !excludedValues.has(compact(candidate.value)))
      .filter((candidate) => fieldPolicy.sources.includes(candidate.origin));

    const authoritativeValueSet = new Set(
      (sourceLoaded
        ? sourceCandidates
        : persistedItems.filter((item) => item.origin === authoritativeOrigin))
        .map((item) => compact(item.value)),
    );
    const trustedCandidates = availableCandidates.filter((candidate) => (
      candidate.origin !== VALUE_ORIGINS.THEME_SEMANTIC_POLICY
      || fieldPolicy.allowUnverifiedPolicyValue
      || authoritativeValueSet.has(compact(candidate.value))
    ));
    const items = trustedCandidates
      .map((candidate) => ({
        ...candidate,
        firstSeenAt: candidate.firstSeenAt ?? new Date().toISOString(),
      }))
      .sort((left, right) => (
        originRank(right.origin) - originRank(left.origin)
        || left.value.localeCompare(right.value, 'zh-CN', { numeric: true })
      ));
    const origins = [...new Set(items.map((item) => item.origin))];
    const status = sourceLoaded
      ? sourceCandidates.length === 0
        ? VALUE_DOMAIN_STATUSES.FAILED
        : sourceTruncated
          ? VALUE_DOMAIN_STATUSES.PARTIAL
          : VALUE_DOMAIN_STATUSES.COMPLETE
      : sourceError
        ? VALUE_DOMAIN_STATUSES.FAILED
        : activeSnapshot
          ? domainSnapshotStatus(activeSnapshot)
          : VALUE_DOMAIN_STATUSES.UNKNOWN;
    const checksum = items.length > 0
      ? crypto
        .createHash('sha256')
        .update(JSON.stringify(items.map((item) => item.value).sort()))
        .digest('hex')
      : '';
    const snapshotChanged = needsSourceRefresh
      || checksum !== (activeSnapshot?.checksum ?? '')
      || status !== domainSnapshotStatus(activeSnapshot)
      || schemaChanged
      || scopeChanged;
    const refreshedAt = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + fieldPolicy.ttlSeconds * 1000,
    ).toISOString();
    let snapshot = activeSnapshot;
    if (snapshotChanged) {
      const previousChecksum = activeSnapshot?.checksum ?? '';
      snapshot = this.database.saveSemanticValueSnapshot({
        themeId,
        sourceType: normalizedSourceType,
        sourceId: String(sourceId),
        fieldName: String(fieldName),
        displayName: String(displayName ?? ''),
        status,
        origins,
        items,
        sampleSize: sourceLoaded ? sourceCandidates.length : 0,
        scopeSignature: currentScopeSignature,
        schemaHash,
        errorMessage: sourceError,
        expiresAt,
      });
      this.database.createSemanticValueAuditLog({
        themeId,
        sourceType: normalizedSourceType,
        sourceId: String(sourceId),
        fieldName: String(fieldName),
        action: needsSourceRefresh ? 'REFRESH' : 'REBUILD',
        beforeChecksum: previousChecksum,
        afterChecksum: snapshot.checksum,
      });
      this.database.replaceSemanticValueDomains({
        themeId,
        sourceType: normalizedSourceType,
        sourceId: String(sourceId),
        fieldName: String(fieldName),
        displayName: String(displayName ?? ''),
        values: items.map((item) => ({
          value: item.value,
          aliases: item.aliases ?? [],
          source: legacySourceLabel(item.origin, sourceLoaded),
          confidence: item.confidence,
        })),
        description: String(description ?? ''),
      });
    }

    const aliases = Object.fromEntries(items.map((item) => [
      item.value,
      item.aliases ?? [],
    ]));
    const governance = {
      id: snapshot?.id ?? null,
      version: snapshot?.version ?? 0,
      status,
      origins,
      sampleSize: snapshot?.sampleSize ?? 0,
      checksum: snapshot?.checksum ?? checksum,
      scopeSignature: currentScopeSignature,
      schemaHash,
      refreshedAt: snapshot?.refreshedAt ?? refreshedAt,
      expiresAt: snapshot?.expiresAt ?? expiresAt,
      errorMessage: sourceError,
      refreshMode: fieldPolicy.refreshMode,
      allowUnverifiedPolicyValue: fieldPolicy.allowUnverifiedPolicyValue,
      rejectUnknownValue: fieldPolicy.rejectUnknownValue,
    };
    return {
      fieldName,
      displayName,
      description,
      values: items.map((item) => item.value),
      valueAliases: aliases,
      valueDomain: {
        values: items.map((item) => item.value),
        aliases,
        source: [...new Set(items.map((item) => (
          legacySourceLabel(item.origin, sourceLoaded)
        )))],
        description: String(description ?? ''),
        governance,
      },
    };
  }

  async initializeIndicator(
    indicator,
    prompt = '',
    valueLoader = null,
    config = {},
    themeId = null,
    preferStored = false,
    semanticPolicy = {},
    scope = {},
  ) {
    const dimensions = [];
    for (const dimension of indicator.dimensions ?? []) {
      const fieldName = dimension.dimensionBizName
        ?? dimension.bizName
        ?? dimension.fieldName
        ?? dimension.name;
      const displayName = dimension.dimensionName
        ?? dimension.name
        ?? fieldName;
      const enriched = await this.enrichField({
        themeId,
        sourceType: 'INDICATOR',
        sourceId: indicator.id,
        fieldName,
        displayName,
        description: dimension.description,
        prompt,
        valueLoader: valueLoader
          ? (field) => valueLoader(field, dimension)
          : null,
        config,
        preferStored,
        semanticPolicy,
        scope,
      });
      dimensions.push({
        ...dimension,
        ...enriched,
      });
    }
    return {
      ...indicator,
      dimensions,
    };
  }

  async initializeDataset(
    dataset,
    fields,
    prompt = '',
    valueLoader = null,
    config = {},
    themeId = null,
    preferStored = false,
    semanticPolicy = {},
    scope = {},
  ) {
    const enrichedFields = [];
    for (const field of fields ?? []) {
      const enriched = await this.enrichField({
        themeId,
        sourceType: 'DATASET',
        sourceId: dataset.id,
        fieldName: field.fieldName,
        displayName: field.displayName ?? field.fieldName,
        description: field.description,
        prompt,
        valueLoader: valueLoader
          ? () => valueLoader(field)
          : null,
        config,
        preferStored,
        semanticPolicy,
        scope,
      });
      enrichedFields.push({
        ...field,
        ...enriched,
      });
    }
    return enrichedFields;
  }
}
