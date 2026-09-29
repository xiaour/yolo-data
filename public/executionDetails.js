const EXECUTED_STAGE_STATUSES = new Set([
  'RUNNING',
  'SUCCESS',
  'FAILED',
]);

export function visibleExecutionStages(stages = []) {
  return (stages ?? []).filter((stage) => (
    EXECUTED_STAGE_STATUSES.has(String(stage?.status ?? '').toUpperCase())
  ));
}
