import { DISPLAY_CATEGORIES, categoryForStage, statusOf as normalizedStatus } from './executionTimeline.js';
const RUNNING_TEXT = {
  UNDERSTAND: '正在理解问题和业务口径', DISCOVER: '正在查找匹配的指标和数据集',
  EXECUTE: '正在校验条件并执行计算', ANALYZE: '正在验证数据并提炼关键发现', RESPOND: '正在组织最终回答',
};
function progressEvent({ id, source = 'platform', category, status, title, detail = '', durationMs = null, artifactId = null }) {
  return {
    type: 'execution_progress', id, source, category,
    status: normalizedStatus(status),
    title: String(title ?? '').trim(),
    detail: String(detail ?? '').trim(),
    durationMs,
    artifactId,
  };
}
function platformStageProgress(stage) {
  if (!stage?.code) return null;
  const status = normalizedStatus(stage.status);
  if (status === 'pending') return null;
  const category = categoryForStage(stage.code);
  const definition = DISPLAY_CATEGORIES[category];
  return progressEvent({
    id: `platform-${category.toLowerCase()}`,
    category,
    status,
    title: definition.title,
    detail: status === 'running'
      ? RUNNING_TEXT[category]
      : String(stage.detail || stage.summary || (status === 'done' ? '已完成' : '未完成')).trim(),
    durationMs: stage.durationMs ?? null,
  });
}
function processStepProgress(step, { codexActive }) {
  if (!step?.id) return null;
  const status = normalizedStatus(step.status);
  if (status === 'pending') return null;
  const category = categoryForStage(step.stageCode);
  return progressEvent({
    id: codexActive ? `tool-${step.id}` : `platform-${category.toLowerCase()}`,
    source: 'tool',
    category,
    status,
    title: codexActive ? String(step.title || step.name || '执行数据工具') : DISPLAY_CATEGORIES[category].title,
    detail: String(step.detail || step.resultSummary || '').trim(),
    durationMs: step.durationMs ?? null,
    artifactId: step.artifactId ?? null,
  });
}
export function createChatStreamPresenter() {
  let codexActive = false;
  const activateCodex = () => {
    if (codexActive) return [];
    codexActive = true;
    return [{ type: 'execution_reset', source: 'codex' }];
  };
  return function present(event) {
    if (!event?.type) return [];
    if (event.type === 'run_started') {
      return [progressEvent({
        id: 'platform-understand', category: 'UNDERSTAND', status: 'running',
        title: '理解问题', detail: RUNNING_TEXT.UNDERSTAND,
      })];
    }
    if (event.type === 'codex_plan_updated') {
      return [
        ...activateCodex(),
        ...(event.steps ?? []).map((step, index) => progressEvent({
          id: `codex-plan-${step.id ?? index + 1}`,
          source: 'codex',
          category: step.category ?? 'UNDERSTAND',
          status: step.status ?? 'pending',
          title: step.title || `步骤 ${index + 1}`,
          detail: step.detail ?? '',
        })),
      ];
    }
    if (event.type === 'codex_item') {
      return [
        ...activateCodex(),
        progressEvent({
          id: `codex-item-${event.id}`,
          source: 'codex',
          category: event.category ?? 'UNDERSTAND',
          status: event.status,
          title: event.title,
          detail: event.detail,
          durationMs: event.durationMs ?? null,
        }),
      ];
    }
    if (event.type === 'codex_turn_completed') return [{ type: 'execution_complete', status: event.status }];
    if (event.type === 'workflow_stage') {
      if (codexActive) return [];
      const progress = platformStageProgress(event.stage);
      return progress ? [progress] : [];
    }
    if (event.type === 'tool_call' || event.type === 'process_step') {
      const progress = processStepProgress(event.step, { codexActive });
      return progress ? [progress] : [];
    }
    if (event.type === 'error') {
      return [progressEvent({
        id: 'run-error', source: codexActive ? 'codex' : 'platform', category: 'RESPOND',
        status: 'error', title: '执行遇到问题', detail: String(event.message ?? '').trim(),
      })];
    }
    return [];
  };
}

export function assistantTextChunks(message, { targetChunks = 120, minChunkSize = 12 } = {}) {
  const characters = Array.from(String(message ?? ''));
  if (characters.length === 0) return [];
  const count = Math.max(1, Math.min(targetChunks, characters.length));
  const size = Math.max(minChunkSize, Math.ceil(characters.length / count));
  const chunks = [];
  for (let index = 0; index < characters.length; index += size) {
    chunks.push(characters.slice(index, index + size).join(''));
  }
  return chunks;
}
