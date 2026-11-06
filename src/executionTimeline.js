const DISPLAY_CATEGORIES = {
  UNDERSTAND: { title: '理解问题', stages: ['INTENT', 'SKILL_AUDIT', 'SEMANTIC_RESOLVE', 'SEMANTIC_CONFIRM'] },
  DISCOVER: { title: '查找数据', stages: ['SEMANTIC_DISCOVERY'] },
  EXECUTE: { title: '执行计算', stages: ['PLAN', 'VALIDATE', 'EXECUTE'] },
  ANALYZE: { title: '分析结果', stages: ['RESULT_ANALYST', 'ANALYSIS_CODE', 'RESULT_VALIDATION', 'ANALYZE', 'CODE'] },
  RESPOND: { title: '生成回答', stages: ['RESPOND', 'REFLECT'] },
};

const STAGE_CATEGORY = new Map(
  Object.entries(DISPLAY_CATEGORIES).flatMap(([category, definition]) => (
    definition.stages.map((stage) => [stage, category])
  )),
);

function statusOf(value) {
  const status = String(value ?? '').toUpperCase();
  if (['FAILED', 'ERROR'].includes(status)) return 'error';
  if (['RUNNING', 'IN_PROGRESS'].includes(status)) return 'running';
  if (['SUCCESS', 'COMPLETED', 'DONE', 'COMPLETED_WITH_WARNINGS'].includes(status)) return 'done';
  return 'pending';
}

function timestamp(value) {
  const time = new Date(value ?? 0).getTime();
  return Number.isFinite(time) && time > 0 ? time : 0;
}

function compact(value, limit = 180) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function categoryForStage(stageCode) {
  return STAGE_CATEGORY.get(String(stageCode ?? '').toUpperCase()) ?? 'UNDERSTAND';
}

function platformTimeline(workflow, processSteps = []) {
  const stages = Array.isArray(workflow?.stages) ? workflow.stages : [];
  const items = [];
  for (const [category, definition] of Object.entries(DISPLAY_CATEGORIES)) {
    const categoryStages = stages.filter((stage) => categoryForStage(stage.code) === category);
    const categorySteps = processSteps.filter((step) => (
      !step?.superseded && categoryForStage(step?.stageCode) === category
    ));
    const visibleStages = categoryStages.filter((stage) => statusOf(stage.status) !== 'pending');
    if (visibleStages.length === 0 && categorySteps.length === 0) continue;
    const error = visibleStages.find((stage) => statusOf(stage.status) === 'error')
      ?? categorySteps.find((step) => statusOf(step.status) === 'error');
    const running = [...visibleStages].reverse().find((stage) => statusOf(stage.status) === 'running')
      ?? [...categorySteps].reverse().find((step) => statusOf(step.status) === 'running');
    const latest = error ?? running ?? categorySteps.at(-1) ?? visibleStages.at(-1);
    const startTimes = [
      ...visibleStages.map((stage) => timestamp(stage.startedAt)),
      ...categorySteps.map((step) => timestamp(step.startedAt)),
    ].filter(Boolean);
    const startedAt = startTimes.length > 0 ? Math.min(...startTimes) : null;
    const durationMs = visibleStages.reduce((sum, stage) => sum + Number(stage.durationMs ?? 0), 0)
      || categorySteps.reduce((sum, step) => sum + Number(step.durationMs ?? 0), 0)
      || null;
    items.push({
      id: `platform-${category.toLowerCase()}`,
      source: 'platform',
      category,
      status: error ? 'error' : running ? 'running' : 'done',
      title: definition.title,
      detail: compact(latest?.detail || latest?.summary || latest?.resultSummary),
      startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      durationMs,
      artifactId: categorySteps.findLast?.((step) => step.artifactId)?.artifactId ?? null,
    });
  }
  return items;
}

function upsert(items, incoming) {
  if (!incoming?.id || !incoming?.title) return;
  const index = items.findIndex((item) => item.id === incoming.id);
  if (index < 0) items.push(incoming);
  else items[index] = { ...items[index], ...incoming };
}

function codexTimeline(codexEvents = [], processSteps = []) {
  const items = [];
  for (const event of codexEvents) {
    if (event?.type === 'codex_plan_updated') {
      for (const [index, step] of (event.steps ?? []).entries()) {
        upsert(items, {
          id: `codex-plan-${step.id ?? index + 1}`,
          source: 'codex',
          category: step.category ?? 'UNDERSTAND',
          status: statusOf(step.status),
          title: compact(step.title || `步骤 ${index + 1}`, 80),
          detail: compact(step.detail),
          startedAt: event.timestamp ?? null,
          durationMs: null,
          artifactId: null,
        });
      }
    } else if (event?.type === 'codex_item') {
      upsert(items, {
        id: `codex-item-${event.id}`,
        source: 'codex',
        category: event.category ?? 'UNDERSTAND',
        status: statusOf(event.status),
        title: compact(event.title, 80),
        detail: compact(event.detail),
        startedAt: event.startedAt ?? event.timestamp ?? null,
        durationMs: event.durationMs ?? null,
        artifactId: null,
      });
    } else if (event?.type === 'codex_turn_completed') {
      for (const item of items) {
        if (item.status === 'running') {
          item.status = String(event.status).toLowerCase() === 'failed' ? 'error' : 'done';
        }
      }
    }
  }
  for (const step of processSteps.filter((item) => !item?.superseded)) {
    upsert(items, {
      id: `tool-${step.id}`,
      source: 'tool',
      category: categoryForStage(step.stageCode),
      status: statusOf(step.status),
      title: compact(step.title || step.name || '执行数据工具', 80),
      detail: compact(step.detail || step.resultSummary),
      startedAt: step.startedAt ?? null,
      durationMs: step.durationMs ?? null,
      artifactId: step.artifactId ?? null,
    });
  }
  const completed = codexEvents.some((event) => event?.type === 'codex_turn_completed');
  return completed ? items.filter((item) => item.status !== 'pending') : items;
}

export function buildExecutionTimeline({ workflow, processSteps = [], codexEvents = [] } = {}) {
  const hasCodexProgress = codexEvents.some((event) => (
    event?.type === 'codex_plan_updated' || event?.type === 'codex_item'
  ));
  return hasCodexProgress
    ? codexTimeline(codexEvents, processSteps)
    : platformTimeline(workflow, processSteps);
}

export { DISPLAY_CATEGORIES, categoryForStage, statusOf };
