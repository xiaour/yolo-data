function executionRecord(result, answer) {
  return {
    kind: result?.kind ?? 'carry',
    queryArtifactId: result?.artifactId
      ?? answer?.taskState?.result?.artifactId
      ?? null,
    queryFingerprint: result?.queryFingerprint ?? answer?.queryFingerprint ?? null,
    dataHash: result?.dataHash ?? answer?.dataHash ?? null,
    finalMessage: String(result?.summary ?? answer?.message ?? '').trim(),
    toolResult: {
      rowCount: Number(result?.rowCount) || 0,
    },
  };
}

const NON_RECOVERABLE_PATTERNS = [
  /permission denied|权限|无权|禁止访问/i,
  /api key|密钥|调用权限|没有调用权限/i,
  /not configured|未配置|未启用|不可用/i,
  /request_clarification|需要.*(确认|补充)|口径.*(缺失|确认)/i,
  /user.*cancel|aborted|用户.*取消/i,
];

export function classifyRecoveryError(error, { signal = null } = {}) {
  if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return { retryable: false, category: 'CANCELLED', reason: '用户或请求已取消' };
  }
  if (Number(error?.statusCode) === 401 || Number(error?.statusCode) === 403) {
    return { retryable: false, category: 'PERMISSION', reason: '权限或密钥错误' };
  }
  const message = String(error?.message ?? '');
  const matched = NON_RECOVERABLE_PATTERNS.find((pattern) => pattern.test(message));
  if (matched) {
    return { retryable: false, category: 'NON_RECOVERABLE', reason: '需要配置、权限或用户确认' };
  }
  if (error?.code === 'REQUEST_TIMEOUT' || /超时|timed out|timeout/i.test(message)) {
    return { retryable: true, category: 'TIMEOUT', reason: '执行超时，可更换计划或降低范围' };
  }
  if (/429|请求过于频繁|访问量过大|rate.?limit|temporarily unavailable|上游.*不可用/i.test(message)) {
    return { retryable: true, category: 'TRANSIENT_UPSTREAM', reason: '上游服务暂时不可用' };
  }
  return { retryable: true, category: 'EXECUTION', reason: '查询或工具执行失败，可重新规划' };
}

export function recoverySignature(error, context = {}) {
  const phase = context.phase ?? error?.recoveryContext?.phase ?? '';
  const message = String(error?.message ?? '').slice(0, 240);
  return `${phase}|${message}`;
}

// A replan may deliberately switch to workspace-only analysis. The new attempt
// then has no fresh query result, but the previous locked result is still the
// source of truth. Carry its evidence forward so the final answer cannot lose
// grounding merely because a second strategy pass was attempted.
export function buildReplanCarryForward(answer) {
  const rows = Array.isArray(answer?.data?.rows) ? answer.data.rows : [];
  const semanticParse = answer?.semanticParse ?? null;
  const queryFingerprint = answer?.queryFingerprint
    ?? answer?.answerEvidence?.queryFingerprint
    ?? null;
  const dataHash = answer?.dataHash
    ?? answer?.answerEvidence?.dataHash
    ?? null;
  if (
    !Array.isArray(answer?.data?.rows)
    || !semanticParse?.queryContract
    || !queryFingerprint
    || !dataHash
  ) {
    return null;
  }
  const executions = (answer.executionResults ?? [])
    .map((result) => executionRecord(result, answer));
  if (executions.length === 0) {
    executions.push(executionRecord(null, answer));
  }
  const lockedExecution = executions.find((execution) => (
    execution.queryFingerprint === queryFingerprint
  )) ?? executions[executions.length - 1];
  return {
    data: answer.data,
    semanticParse,
    chart: answer.chart ?? null,
    indicator: answer.indicator ?? null,
    dataset: answer.dataset
      ? {
        ...answer.dataset,
        primaryTable: answer.dataset.primaryTable ?? answer.dataset.tableName,
      }
      : null,
    executions,
    lockedExecution,
    lastSummary: executions[executions.length - 1].finalMessage,
  };
}
