import { applyExecutionTimelineEvent } from './executionTimelineState.js';

export function createChatStreamState() {
  return {
    workflow: null,
    processSteps: [],
    warnings: [],
    runtime: null,
    source: null,
    contextDecision: null,
    lastEvent: null,
    executionTimeline: [],
    progress: [],
    answerText: '',
    answerStarted: false,
    answerDone: false,
    error: null,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
  };
}

export function liveElapsedMs(stream) {
  return Math.max(0, Date.now() - Number(stream?.startedAt ?? Date.now()));
}

export function applyChatStreamEvent(stream, event) {
  const next = stream ?? createChatStreamState();
  next.lastEvent = event;
  next.lastEventAt = Date.now();
  if (applyExecutionTimelineEvent(next, event)) return next;
  if (event.type === 'error' || event.type === 'stream_error') {
    next.error = {
      message: String(event.message ?? '本轮查询失败'),
      code: event.code ?? null,
      statusCode: event.statusCode ?? null,
      providerStatus: event.providerStatus ?? null,
      providerDetail: event.providerDetail ?? null,
      recovery: event.recovery ?? null,
    };
    return next;
  }
  if (event.type === 'assistant_answer_start') {
    next.answerStarted = true;
    next.answerDone = false;
    next.answerText = '';
    return next;
  }
  if (event.type === 'assistant_delta') {
    next.answerStarted = true;
    next.answerText += String(event.text ?? '');
    return next;
  }
  if (event.type === 'assistant_answer_done') {
    next.answerStarted = true;
    next.answerDone = true;
    return next;
  }
  if (event.type === 'assistant_answer_replace') {
    next.answerStarted = true;
    next.answerDone = false;
    next.answerText = String(event.text ?? '');
    return next;
  }
  if (event.type === 'workflow_stage' || event.type === 'workflow_finished') {
    next.workflow = event.workflow ?? next.workflow;
  } else if (event.type === 'process_step') {
    const index = next.processSteps.findIndex((step) => step.id === event.step?.id);
    if (index >= 0) {
      next.processSteps.splice(index, 1, event.step);
    } else if (event.step) {
      next.processSteps.push(event.step);
    }
  } else if (event.type === 'runtime_selected') {
    next.runtime = event.runtime;
    next.source = event.source;
  } else if (event.type === 'context_resolved') {
    next.contextDecision = event.context ?? null;
  } else if (event.type === 'execution_selected') {
    next.source = event.source;
    next.execution = event.source;
  } else if (event.type === 'warning') {
    if (!next.warnings.some((warning) => warning.code === event.code)) {
      next.warnings.push(event);
    }
  } else if (event.type === 'result') {
    next.workflow = event.workflow ?? next.workflow;
    next.processSteps = event.processSteps ?? next.processSteps;
    next.runtime = event.runtime ?? next.runtime;
    next.contextDecision = event.contextDecision ?? next.contextDecision;
    next.executionTimeline = event.executionTimeline ?? next.executionTimeline;
    next.progress = next.executionTimeline;
    if (event.message) {
      next.answerStarted = true;
      next.answerDone = true;
      next.answerText = event.message;
    }
  } else if (event.type === 'sql') {
    next.sql = event.sql;
  }
  return next;
}
