import { escapeAttr, escapeHtml, formatDurationSeconds } from '../core/runtime.js';

function normalizeStatus(status) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'running') return 'running';
  if (value === 'error' || value === 'failed') return 'error';
  if (['done', 'success', 'completed', 'completed_with_warnings'].includes(value)) return 'done';
  return 'pending';
}

function renderItems(items) {
  const visible = (items ?? []).filter((item) => item?.title).slice(-12);
  if (visible.length === 0) return '';
  return `<ol class="live-agent-progress execution-timeline-list" aria-live="polite">
    ${visible.map((item) => {
      const status = normalizeStatus(item.status);
      const detail = String(item.detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
      return `<li class="live-agent-progress-item execution-timeline-item is-${status}">
        <span class="live-agent-progress-mark" aria-hidden="true"></span>
        <span class="live-agent-progress-copy"><strong>${escapeHtml(item.title)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}</span>
        ${item.durationMs != null ? `<time>${formatDurationSeconds(item.durationMs)}</time>` : status === 'running' ? '<time>执行中</time>' : ''}
        ${item.artifactId ? `<button class="execution-timeline-artifact" type="button" data-open-process-artifact="${escapeAttr(item.artifactId)}">查看产物</button>` : ''}
      </li>`;
    }).join('')}
  </ol>`;
}

export function renderExecutionTimeline(items, { live = false, durationMs = null, summaryMeta = '', fingerprint = '' } = {}) {
  const content = renderItems(items);
  if (!content) return '';
  if (live) return `<section class="execution-timeline-live" aria-label="执行过程"><div class="execution-timeline-label">执行过程</div>${content}</section>`;
  return `<details class="execution-details execution-timeline-details">
    <summary><span class="execution-summary-title">执行过程</span>${durationMs != null ? `<b class="execution-summary-duration">${formatDurationSeconds(durationMs)}</b>` : ''}${summaryMeta ? `<span class="execution-summary-meta">${summaryMeta}</span>` : ''}<small>${fingerprint ? `指纹 ${escapeHtml(fingerprint)}` : ''}</small></summary>
    <div class="execution-detail-body">${content}</div>
    <div class="execution-detail-note">仅展示可验证的规划与执行状态，不展示模型私有思维过程。</div>
  </details>`;
}

const LEGACY_CATEGORIES = [
  ['UNDERSTAND', '理解问题', ['INTENT', 'SKILL_AUDIT', 'SEMANTIC_RESOLVE', 'SEMANTIC_CONFIRM']],
  ['DISCOVER', '查找数据', ['SEMANTIC_DISCOVERY']],
  ['EXECUTE', '执行计算', ['PLAN', 'VALIDATE', 'EXECUTE']],
  ['ANALYZE', '分析结果', ['RESULT_ANALYST', 'ANALYSIS_CODE', 'RESULT_VALIDATION', 'CODE', 'ANALYZE']],
  ['RESPOND', '生成回答', ['RESPOND', 'REFLECT']],
];

function stepStage(step) {
  if (step?.stageCode) return step.stageCode;
  if (['search_indicators', 'list_business_datasets'].includes(step?.name)) return 'SEMANTIC_DISCOVERY';
  if (['get_indicator', 'get_business_dataset_definition'].includes(step?.name)) return 'SEMANTIC_CONFIRM';
  if (step?.name === 'compile_query_contract' || step?.type === 'plan') return 'PLAN';
  if (step?.name === 'execute_analysis_code') return 'CODE';
  if (step?.type === 'validation') return 'VALIDATE';
  if (step?.type === 'response') return 'RESPOND';
  return step?.type === 'tool' || step?.type === 'reuse' ? 'EXECUTE' : 'INTENT';
}

export function legacyExecutionTimeline(workflow, processSteps = []) {
  const stages = (workflow?.stages ?? []).filter((stage) => stage.status !== 'PENDING');
  return LEGACY_CATEGORIES.map(([code, title, stageCodes]) => {
    const matchedStages = stages.filter((stage) => stageCodes.includes(stage.code));
    const matchedSteps = processSteps.filter((step) => !step.superseded && stageCodes.includes(stepStage(step)));
    if (matchedStages.length === 0 && matchedSteps.length === 0) return null;
    const error = matchedStages.find((stage) => stage.status === 'FAILED')
      ?? matchedSteps.find((step) => ['error', 'failed'].includes(step.status));
    const running = [...matchedStages].reverse().find((stage) => stage.status === 'RUNNING')
      ?? [...matchedSteps].reverse().find((step) => step.status === 'running');
    const latest = error ?? running ?? matchedSteps.at(-1) ?? matchedStages.at(-1);
    return {
      id: `legacy-${code.toLowerCase()}`, source: 'platform', category: code,
      status: error ? 'error' : running ? 'running' : 'done', title,
      detail: latest?.detail || latest?.summary || latest?.resultSummary || '',
      durationMs: matchedStages.reduce((sum, stage) => sum + Number(stage.durationMs ?? 0), 0)
        || matchedSteps.reduce((sum, step) => sum + Number(step.durationMs ?? 0), 0) || null,
      artifactId: [...matchedSteps].reverse().find((step) => step.artifactId)?.artifactId ?? null,
    };
  }).filter(Boolean);
}

