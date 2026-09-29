const SUPPORTED_OPERATORS = new Set([
  'IN',
  'NOT_IN',
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'LIKE',
  'IS_NULL',
  'IS_NOT_NULL',
]);

function uniqueStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value)).filter(Boolean))];
}

function resolvePolicyValues(policy, user) {
  if (policy.valueSource === 'USER_ATTRIBUTE' && policy.attributeKey) {
    const value = user?.attributes?.[policy.attributeKey];
    if (Array.isArray(value)) {
      return value.map((item) => String(item));
    }
    return value === undefined || value === null ? [] : [String(value)];
  }
  return uniqueStrings(policy.values);
}

export function isAdmin(user) {
  return String(user?.role ?? '').toUpperCase() === 'ADMIN';
}

export function resolveAccessScope({ user, theme, indicators, permissionProfile }) {
  if (!user || !theme) {
    return {
      allowed: false,
      reason: 'user or theme is missing',
      allowedIndicatorIds: [],
      unrestrictedIndicators: false,
      allowedDatasetIds: [],
      allowedDimensions: [],
      rowPolicies: [],
      columnPolicies: [],
      canManage: false,
    };
  }

  const admin = isAdmin(user);
  const themeGrant = permissionProfile.themeGrants.find(
    (grant) => Number(grant.themeId) === Number(theme.id),
  );
  if (!admin && (!themeGrant || !themeGrant.canQuery)) {
    return {
      allowed: false,
      reason: 'user has no query grant for this theme',
      allowedIndicatorIds: [],
      unrestrictedIndicators: false,
      allowedDatasetIds: [],
      allowedDimensions: [],
      rowPolicies: [],
      columnPolicies: [],
      canManage: false,
    };
  }

  const themeIndicatorIds = uniqueStrings(theme.indicatorIds);
  const explicitlyGrantedIds = permissionProfile.indicatorGrants
    .filter((grant) => grant.canQuery)
    .map((grant) => String(grant.indicatorId));
  const hasExplicitIndicatorGrants = permissionProfile.indicatorGrants.length > 0;

  let allowedIndicatorIds = [];
  let unrestrictedIndicators = false;
  if (Array.isArray(indicators)) {
    allowedIndicatorIds = indicators.map((indicator) => String(indicator.id));
    if (themeIndicatorIds.length > 0) {
      allowedIndicatorIds = allowedIndicatorIds.filter(
          (id) => themeIndicatorIds.includes(id));
    }
    if (!admin && hasExplicitIndicatorGrants) {
      allowedIndicatorIds = allowedIndicatorIds.filter(
          (id) => explicitlyGrantedIds.includes(id));
    }
  } else if (!admin && hasExplicitIndicatorGrants) {
    allowedIndicatorIds = themeIndicatorIds.length > 0
        ? themeIndicatorIds.filter((id) => explicitlyGrantedIds.includes(id))
        : explicitlyGrantedIds;
  } else if (themeIndicatorIds.length > 0) {
    allowedIndicatorIds = themeIndicatorIds;
  } else {
    unrestrictedIndicators = true;
  }

  const explicitDatasetIds = permissionProfile.datasetGrants
    .filter((grant) => grant.canQuery)
    .map((grant) => String(grant.datasetId));
  const allowedDatasetIds = admin
    ? []
    : explicitDatasetIds;

  const themeDimensions = uniqueStrings(theme.allowedDimensions);
  const rowPolicies = permissionProfile.rowPolicies
    .filter((policy) => policy.enabled)
    .filter((policy) => policy.themeId === null
      || policy.themeId === undefined
      || Number(policy.themeId) === Number(theme.id))
    .map((policy) => ({
      ...policy,
      dimension: String(policy.dimension),
      operator: String(policy.operator || 'IN').toUpperCase(),
      values: resolvePolicyValues(policy, user),
    }))
    .filter((policy) => SUPPORTED_OPERATORS.has(policy.operator));

  const columnPolicies = permissionProfile.columnPolicies
    .filter((policy) => policy.enabled)
    .filter((policy) => policy.themeId === null
      || policy.themeId === undefined
      || Number(policy.themeId) === Number(theme.id));

  return {
    allowed: true,
    reason: '',
    allowedIndicatorIds,
    unrestrictedIndicators,
    allowedDatasetIds,
    allowedDimensions: themeDimensions,
    rowPolicies,
    columnPolicies,
    canManage: admin || Boolean(themeGrant?.canManage),
    isAdmin: admin,
  };
}

export function canAccessIndicator(scope, indicatorId) {
  return scope.allowed === true
    && (scope.unrestrictedIndicators
        || scope.allowedIndicatorIds.includes(String(indicatorId)));
}

export function normalizeRequestedFilters(filters) {
  if (!Array.isArray(filters)) {
    return [];
  }
  return filters
    .map((filter) => ({
      bizName: String(filter.bizName ?? filter.dimension ?? '').trim(),
      operator: String(filter.operator ?? 'IN').trim().toUpperCase(),
      value: filter.value,
    }))
    .filter((filter) => filter.bizName && SUPPORTED_OPERATORS.has(filter.operator));
}

export function enforceRowPolicies(requestedFilters, rowPolicies) {
  const filtersByDimension = new Map();
  for (const filter of normalizeRequestedFilters(requestedFilters)) {
    filtersByDimension.set(filter.bizName, filter);
  }

  for (const policy of rowPolicies ?? []) {
    const forcedFilter = policyToFilter(policy);
    if (forcedFilter) {
      filtersByDimension.set(policy.dimension, forcedFilter);
    }
  }
  return [...filtersByDimension.values()];
}

function policyToFilter(policy) {
  if (!policy?.dimension || !SUPPORTED_OPERATORS.has(policy.operator)) {
    return null;
  }
  if (policy.operator === 'IS_NULL' || policy.operator === 'IS_NOT_NULL') {
    return { bizName: policy.dimension, operator: policy.operator, value: null };
  }
  const values = uniqueStrings(policy.values);
  if (values.length === 0) {
    throw new Error(`row policy for ${policy.dimension} has no resolvable value`);
  }
  if (policy.operator === 'IN' || policy.operator === 'NOT_IN') {
    return { bizName: policy.dimension, operator: policy.operator, value: values };
  }
  return {
    bizName: policy.dimension,
    operator: policy.operator,
    value: values.length === 1 ? values[0] : values,
  };
}

export function filterIndicatorsByScope(indicators, scope) {
  if (!scope.allowed) {
    return [];
  }
  if (scope.unrestrictedIndicators) {
    return indicators;
  }
  const allowed = new Set(scope.allowedIndicatorIds);
  return indicators.filter((indicator) => allowed.has(String(indicator.id)));
}

export function filterDimensionsByScope(dimensions, scope) {
  if (!scope.allowed || scope.allowedDimensions.length === 0) {
    return dimensions;
  }
  const allowed = new Set(scope.allowedDimensions.map((dimension) => dimension.toLowerCase()));
  return dimensions.filter((dimension) => {
    const candidates = [
      dimension.dimensionBizName,
      dimension.dimensionName,
      dimension.bizName,
      dimension.name,
    ].filter(Boolean).map((value) => String(value).toLowerCase());
    return candidates.some((candidate) => allowed.has(candidate));
  });
}

export function applyColumnPolicies(columns, rows, columnPolicies) {
  const activePolicies = (columnPolicies ?? []).filter((policy) => policy.enabled !== false);
  if (activePolicies.length === 0) {
    return { columns, rows };
  }

  const policiesByName = new Map(
    activePolicies.map((policy) => [String(policy.columnName).toLowerCase(), policy]),
  );
  const nextColumns = [];
  for (const column of columns ?? []) {
    const candidates = [column.bizName, column.name, column.nameEn]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    const policy = candidates.map((candidate) => policiesByName.get(candidate)).find(Boolean);
    if (policy?.action === 'HIDE') {
      continue;
    }
    nextColumns.push(policy?.action === 'MASK'
      ? { ...column, authorized: false, masked: true }
      : column);
  }

  const nextRows = (rows ?? []).map((row) => {
    const nextRow = { ...row };
    for (const [key, value] of Object.entries(nextRow)) {
      const policy = policiesByName.get(String(key).toLowerCase());
      if (!policy) {
        continue;
      }
      if (policy.action === 'HIDE') {
        delete nextRow[key];
      } else if (policy.action === 'MASK') {
        nextRow[key] = policy.maskValue ?? '***';
      }
    }
    return nextRow;
  });

  return { columns: nextColumns, rows: nextRows };
}

export function assertAllowedDimensions(requestedDimensions, indicatorDimensions, scope) {
  const candidates = new Set();
  for (const dimension of indicatorDimensions ?? []) {
    for (const value of [
      dimension.dimensionBizName,
      dimension.dimensionName,
      dimension.bizName,
      dimension.name,
    ]) {
      if (value) {
        candidates.add(String(value));
      }
    }
  }

  const themeDimensions = new Set(scope.allowedDimensions.map((value) => value.toLowerCase()));
  return (requestedDimensions ?? []).filter((dimension) => {
    const normalized = String(dimension);
    if (!candidates.has(normalized)) {
      return false;
    }
    if (themeDimensions.size === 0) {
      return true;
    }
    return [...candidates].some((candidate) => (
      candidate.toLowerCase() === normalized.toLowerCase()
      && themeDimensions.has(candidate.toLowerCase())
    ));
  });
}

export { SUPPORTED_OPERATORS };
