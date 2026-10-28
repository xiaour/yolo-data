import {
  escapeHtml,
  formatDurationSeconds,
  formatModelName,
  formatSourceMode,
  renderSafeMarkdown,
} from '../core/runtime.js';
import { liveElapsedMs } from './chatStreamState.js';
import { renderContextDecision } from './contextDecision.js';

function normalizeStatus(status) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'running') {
    return 'running';
  }
  if (value === 'error' || value === 'failed') {
    return 'error';
  }
  if (
    value === 'done'
    || value === 'success'
    || value === 'completed'
    || value === 'completed_with_warnings'
  ) {
    return 'done';
  }
  return 'pending';
}

function compactDetail(value, maxLength = 180) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) + '…' : text;
}

function renderProgressItems(items) {
  const visible = (items ?? []).slice(-6);
  if (visible.length === 0) {
    return '';
  }
  return `
    <ol class="live-agent-progress" aria-live="polite">
      ${visible.map((item) => {
        const status = normalizeStatus(item.status);
        const detail = compactDetail(item.detail);
        return `
          <li class="live-agent-progress-item is-${status}">
            <span class="live-agent-progress-mark" aria-hidden="true"></span>
            <span class="live-agent-progress-copy">
              <strong>${escapeHtml(item.text ?? '')}</strong>
              ${detail ? `<small>${escapeHtml(detail)}</small>` : ''}
            </span>
          </li>
        `;
      }).join('')}
    </ol>
  `;
}

export function renderLiveExecution(stream, { renderExecutionDetails }) {
  const workflow = stream?.workflow;
  const progress = stream?.progress ?? [];
  const activeStage = workflow?.stages?.find((stage) => stage.status === 'RUNNING')
    ?? [...(workflow?.stages ?? [])].reverse().find((stage) => stage.summary);
  const activeProgress = [...progress].reverse().find((item) => (
    normalizeStatus(item.status) === 'running'
  )) ?? progress.at(-1);
  const modelText = formatModelName(stream?.runtime);
  const sourceText = formatSourceMode(stream?.source?.mode);
  const completed = workflow?.progress?.completed ?? 0;
  const total = workflow?.progress?.total ?? 14;
  const meta = [
    modelText,
    'Data Agent',
    sourceText,
    `${completed}/${total} 步`,
  ].filter(Boolean).map((item) => escapeHtml(item)).join('<span class="live-agent-dot">·</span>');
  const headline = activeProgress?.text
    ?? activeStage?.summary
    ?? activeStage?.name
    ?? '正在启动 DataAgent 工作流';
  const detail = compactDetail(activeProgress?.detail ?? activeStage?.summary ?? '');
  const hasAnswer = stream?.answerStarted || Boolean(stream?.answerText);
  const streamError = stream?.error;
  return `
    <div class="live-agent-stream">
      <div class="live-agent-head">
        <span class="live-agent-pulse${stream?.answerStarted ? ' is-answering' : ''}" aria-hidden="true">
          <img class="live-agent-logo" src="/yolo-mark.svg" alt="" />
        </span>
        <div class="live-agent-head-copy">
          <div class="live-agent-headline">
            <strong>${escapeHtml(headline)}</strong>
            <time class="live-agent-elapsed" data-live-elapsed>${formatDurationSeconds(liveElapsedMs(stream))}</time>
          </div>
          <small>${meta}</small>
          ${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
        </div>
      </div>
      ${renderContextDecision(stream?.contextDecision, { live: true })}
      ${renderProgressItems(progress)}
      ${hasAnswer ? `
        <div class="live-agent-answer">
          <div class="chat-answer-text live-answer-text">${renderSafeMarkdown(stream?.answerText)}${stream?.answerDone ? '' : '<span class="stream-caret" aria-hidden="true"></span>'}</div>
        </div>
      ` : `
        <div class="live-agent-waiting">
          <span class="live-agent-typing" aria-hidden="true"><i></i><i></i><i></i></span>
          <span>Agent 正在执行，结果会在这里实时输出</span>
        </div>
      `}
      ${streamError ? `
        <div class="live-agent-error" role="alert">
          <strong>${escapeHtml(streamError.message)}</strong>
          ${streamError.providerDetail && streamError.providerDetail !== streamError.message
            ? `<small>上游返回：${escapeHtml(streamError.providerDetail)}</small>` : ''}
          ${streamError.statusCode ? `<small>模型服务 HTTP ${escapeHtml(streamError.statusCode)}</small>` : ''}
        </div>
      ` : ''}
      ${(stream?.warnings ?? []).map((warning) => `
        <div class="live-warning">${escapeHtml(warning.message)}</div>
      `).join('')}
      ${renderExecutionDetails({
        workflow,
        processSteps: stream?.processSteps ?? [],
      })}
    </div>
  `;
}
