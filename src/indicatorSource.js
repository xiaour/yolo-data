// Single source of truth for where the online indicator catalog came from.
// Reads must declare LIVE / SNAPSHOT{freshAt} / UNAVAILABLE so the platform can
// never silently treat a stale cache as the live catalog (SOURCE-002).

export const INDICATOR_SOURCE = {
  LIVE: 'LIVE',
  LOCAL: 'LOCAL',
  SNAPSHOT: 'SNAPSHOT',
  UNAVAILABLE: 'UNAVAILABLE',
};

export function describeIndicatorSource({ live, local, snapshot } = {}) {
  const snapshotCount = Number(snapshot?.count ?? 0);
  if (live?.available) {
    return {
      source: INDICATOR_SOURCE.LIVE,
      freshAt: null,
      snapshotCount,
    };
  }
  if (local) {
    return {
      source: INDICATOR_SOURCE.LOCAL,
      freshAt: null,
      snapshotCount,
    };
  }
  if (snapshotCount > 0) {
    return {
      source: INDICATOR_SOURCE.SNAPSHOT,
      freshAt: snapshot?.freshAt ?? null,
      snapshotCount,
    };
  }
  return {
    source: INDICATOR_SOURCE.UNAVAILABLE,
    freshAt: null,
    snapshotCount: 0,
  };
}

export function indicatorSourceLabel(state) {
  if (!state) {
    return INDICATOR_SOURCE.UNAVAILABLE;
  }
  if (state.source === INDICATOR_SOURCE.SNAPSHOT) {
    return `SNAPSHOT{freshAt=${state.freshAt ?? 'unknown'}}`;
  }
  if (state.source === INDICATOR_SOURCE.LOCAL) {
    return 'LOCAL';
  }
  return state.source;
}

export function indicatorSourceIssue(state, {
  phase = 'SEMANTIC_DISCOVERY',
} = {}) {
  if (state?.source !== INDICATOR_SOURCE.UNAVAILABLE) {
    return null;
  }
  return {
    level: 'ERROR',
    code: 'INDICATOR_SOURCE_UNAVAILABLE',
    phase,
    message: '指标目录来源不可用（指标平台未配置且无可用快照），不得继续规划指标查询。',
  };
}
