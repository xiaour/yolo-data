function uniqueStrings(values) {
  return [...new Set(
    (values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean),
  )];
}

export function buildArtifactCapabilities({
  sourceType = '',
  source = null,
  data = null,
  semanticParse = null,
  queryFingerprint = null,
  dataHash = null,
} = {}) {
  const columns = data?.columns ?? semanticParse?.columns ?? [];
  const metrics = uniqueStrings(
    semanticParse?.metrics
      ?? columns.filter((column) => String(column?.showType).toUpperCase() === 'NUMBER')
        .map((column) => column?.bizName ?? column?.name),
  );
  const dimensions = uniqueStrings(
    semanticParse?.dimensions
      ?? columns.filter((column) => String(column?.showType).toUpperCase() !== 'NUMBER')
        .map((column) => column?.bizName ?? column?.name),
  );
  const derivedMetrics = uniqueStrings(
    semanticParse?.queryContract?.derivedMetrics
      ?.map((metric) => metric.outputField),
  );
  return {
    version: 1,
    sourceType: String(sourceType ?? '').toUpperCase(),
    sourceId: source?.id == null ? null : String(source.id),
    sourceName: source?.name ?? null,
    rowCount: data?.rows?.length ?? 0,
    columns: columns.map((column) => ({
      field: column?.bizName ?? column?.name ?? '',
      label: column?.name ?? column?.bizName ?? '',
      type: column?.showType ?? column?.type ?? '',
      unit: column?.unit ?? '',
    })),
    metrics,
    dimensions,
    derivedMetrics,
    rowGrain: dimensions,
    timeGrain: semanticParse?.timeGrain ?? null,
    dateRange: semanticParse?.dateInfo
      ? {
        startDate: semanticParse.dateInfo.startDate ?? null,
        endDate: semanticParse.dateInfo.endDate ?? null,
        field: semanticParse.dateInfo.field ?? semanticParse.dateInfo.dateField ?? null,
      }
      : null,
    filters: semanticParse?.filters ?? [],
    queryFingerprint,
    dataHash,
  };
}

export function artifactCanSatisfy(capabilities, requirements = {}) {
  const availableFields = new Set(
    (capabilities?.columns ?? []).map((column) => String(column.field)),
  );
  for (const metric of requirements.metrics ?? []) {
    if (!availableFields.has(String(metric))) {
      return false;
    }
  }
  for (const dimension of requirements.dimensions ?? []) {
    if (!availableFields.has(String(dimension))) {
      return false;
    }
  }
  return true;
}

export function decideArtifactStrategy({
  artifacts = [],
  requirements = {},
} = {}) {
  for (const artifact of artifacts) {
    const capabilities = artifact?.capabilities
      ?? artifact?.metadata?.capabilities;
    if (artifactCanSatisfy(capabilities, requirements)) {
      return {
        action: 'REUSE',
        artifactId: artifact.id,
        reason: '现有快照满足字段和粒度要求。',
      };
    }
  }
  return {
    action: 'NEW_QUERY_AND_DERIVE',
    artifactId: null,
    reason: '现有快照不包含所需基础字段，应执行最小范围新查询并保留旧快照。',
  };
}
