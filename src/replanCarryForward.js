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
