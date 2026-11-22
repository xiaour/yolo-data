import { STAGE_DEFINITIONS } from './workflowStages.js';
function nowIso() {
  return new Date().toISOString();
}

function stageAttempt(stage, status, summary, detail, timestamp) {
  return {
    sequence: (stage.attempts?.length ?? 0) + 1,
    status,
    summary: String(summary || ''),
    detail: String(detail || ''),
    startedAt: stage.startedAt ?? timestamp,
    finishedAt: timestamp,
    durationMs: Math.max(
      0,
      new Date(timestamp).getTime() - new Date(stage.startedAt ?? timestamp).getTime(),
    ),
  };
}

export class DataAgentWorkflow {
  constructor({ question, user, theme, runtime = null, onEvent = null, replanDepth = 0 }) {
    this.id = `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.name = 'DataAgent Standard Workflow';
    this.version = '1.0';
    this.replanDepth = Math.max(0, Number(replanDepth) || 0);
    this.runtime = runtime;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.question = question;
    this.user = {
      id: user?.id,
      username: user?.username,
      displayName: user?.displayName,
    };
    this.theme = {
      id: theme?.id,
      name: theme?.name,
    };
    this.startedAt = nowIso();
    this.finishedAt = null;
    this.status = 'RUNNING';
    this.stages = STAGE_DEFINITIONS.map((definition) => ({
      ...definition,
      status: 'PENDING',
      summary: '',
      detail: '',
      evidence: [],
      attempts: [],
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      active: false,
    }));
    this.stageMap = new Map(this.stages.map((stage) => [stage.code, stage]));
  }

  notify(type, stage = null) {
    if (!this.onEvent) {
      return;
    }
    this.onEvent({
      type,
      stage: stage ? { ...stage } : null,
      workflow: this.toJSON(),
    });
  }

  start(code, summary = '') {
    const stage = this.requireStage(code);
    stage.active = true;
    stage.status = 'RUNNING';
    stage.startedAt = nowIso();
    if (summary) {
      stage.summary = summary;
    }
    this.notify('workflow_stage', stage);
    return stage;
  }

  complete(code, { summary = '', detail = '', evidence = [] } = {}) {
    const stage = this.requireStage(code);
    stage.active = true;
    const timestamp = nowIso();
    if (!stage.startedAt || stage.status !== 'RUNNING') {
      stage.startedAt = timestamp;
    }
    const attempt = stageAttempt(
      stage,
      'SUCCESS',
      summary || stage.summary,
      detail || stage.detail,
      timestamp,
    );
    const recoveringFailedAttempt = stage.status === 'FAILED'
      && stage.attempts.some((item) => item.status === 'FAILED');
    stage.attempts.push(attempt);
    stage.status = 'SUCCESS';
    stage.summary = String(summary || stage.summary || '');
    stage.detail = String(detail || stage.detail || '');
    if (evidence.length > 0) {
      stage.evidence.push(...evidence);
    }
    stage.finishedAt = timestamp;
    stage.durationMs = attempt.durationMs;
    if (recoveringFailedAttempt) {
      this.status = 'RUNNING';
    }
    this.notify('workflow_stage', stage);
    return stage;
  }

  fail(code, error) {
    const stage = this.requireStage(code);
    stage.active = true;
    const timestamp = nowIso();
    if (!stage.startedAt || stage.status !== 'RUNNING') {
      stage.startedAt = timestamp;
    }
    const message = error?.message ?? String(error);
    const attempt = stageAttempt(stage, 'FAILED', message, '', timestamp);
    stage.attempts.push(attempt);
    stage.status = 'FAILED';
    stage.summary = message;
    stage.finishedAt = timestamp;
    stage.durationMs = attempt.durationMs;
    this.status = 'FAILED';
    this.notify('workflow_stage', stage);
    return stage;
  }

  skip(code, summary = '当前问题不需要该步骤') {
    const stage = this.requireStage(code);
    if (!stage.active) return stage;
    const timestamp = nowIso();
    stage.startedAt = timestamp;
    const attempt = stageAttempt(stage, 'SKIPPED', summary, '', timestamp);
    stage.attempts.push(attempt);
    stage.status = 'SKIPPED';
    stage.summary = summary;
    stage.finishedAt = timestamp;
    stage.durationMs = attempt.durationMs;
    this.notify('workflow_stage', stage);
    return stage;
  }

  isCompleted(code) {
    return this.requireStage(code).status === 'SUCCESS';
  }

  canExecuteQuery() {
    return this.isCompleted('SEMANTIC_DISCOVERY')
      && this.isCompleted('SEMANTIC_CONFIRM');
  }

  finish(summary = '', { warnings = [] } = {}) {
    const activeStages = this.stages.filter((stage) => stage.active);
    const hasFailedStage = activeStages.some((stage) => stage.status === 'FAILED');
    this.warnings = Array.isArray(warnings) ? warnings : [];
    this.status = hasFailedStage
      ? 'FAILED'
      : this.warnings.length > 0
        ? 'COMPLETED_WITH_WARNINGS'
        : 'COMPLETED';
    this.finishedAt = nowIso();
    this.durationMs = Math.max(
      0,
      new Date(this.finishedAt).getTime() - new Date(this.startedAt).getTime(),
    );
    if (summary) {
      this.summary = summary;
    }
    this.notify('workflow_finished');
    return this.toJSON();
  }

  requireStage(code) {
    const stage = this.stageMap.get(code);
    if (!stage) {
      throw new Error(`unknown workflow stage: ${code}`);
    }
    return stage;
  }

  toJSON() {
    const activeStages = this.stages.filter((stage) => stage.active);
    const completedCount = activeStages.filter(
      (stage) => stage.status === 'SUCCESS',
    ).length;
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      runtime: this.runtime,
      question: this.question,
      user: this.user,
      theme: this.theme,
      status: this.status,
      warnings: this.warnings ?? [],
      replanDepth: this.replanDepth,
      summary: this.summary ?? '',
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      durationMs: this.durationMs ?? null,
      progress: {
        completed: completedCount,
        total: activeStages.length,
        percent: activeStages.length > 0
          ? Math.round((completedCount / activeStages.length) * 100)
          : 0,
      },
      stages: activeStages.map((stage) => ({ ...stage })),
    };
  }
}

export { STAGE_DEFINITIONS };
