import { escapeHtml, formatDurationSeconds, formatModelName, formatSourceMode, renderSafeMarkdown } from '../core/runtime.js';
import { liveElapsedMs } from './chatStreamState.js';
import { renderContextDecision } from './contextDecision.js';
import { renderExecutionTimeline } from './executionTimeline.js';

function normalizeStatus(status) {
  const value = String(status ?? '').toLowerCase();
  if (value === 'running') return 'running';
  if (value === 'error' || value === 'failed') return 'error';
  if (['done', 'success', 'completed', 'completed_with_warnings'].includes(value)) return 'done';
  return 'pending';
}

function compactDetail(value, maxLength = 180) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? text.slice(0, maxLength) + '…' : text;
}

export function renderLiveExecution(stream) {
  const timeline = stream?.executionTimeline ?? stream?.progress ?? [];
  const activeProgress = [...timeline].reverse().find((item) => normalizeStatus(item.status) === 'running')
    ?? [...timeline].reverse().find((item) => normalizeStatus(item.status) !== 'pending')
    ?? timeline.at(-1);
  const modelText = formatModelName(stream?.runtime);
  const sourceText = formatSourceMode(stream?.source?.mode);
  const meta = [modelText, sourceText].filter(Boolean)
    .map((item) => escapeHtml(item)).join('<span class="live-agent-dot">·</span>');
  const headline = activeProgress?.title ?? '正在启动分析';
  const detail = compactDetail(activeProgress?.detail ?? '');
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
      ${renderExecutionTimeline(timeline, { live: true })}
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
      ${(stream?.warnings ?? []).map((warning) => `<div class="live-warning">${escapeHtml(warning.message)}</div>`).join('')}
    </div>
  `;
}
