import { listGates } from './gateRegistry.js';

const BASE_STAGE_DEFINITIONS = [
  { code: 'INTENT', name: '理解问题', description: '识别问数意图、主题和多轮上下文' },
  { code: 'SKILL_AUDIT', name: 'Skill 口径审计', description: '按主题 Skill 检查数据含义、粒度、时间和来源' },
  { code: 'SEMANTIC_RESOLVE', name: '语义解析', description: '对指标、维度和枚举生成候选并执行多策略裁决' },
  { code: 'SEMANTIC_DISCOVERY', name: '检索语义对象', description: '搜索相关指标或业务数据集' },
  { code: 'SEMANTIC_CONFIRM', name: '确认口径', description: '确认指标定义或数据集字段口径' },
  { code: 'PLAN', name: '生成查询计划', description: '将问题编译为结构化查询计划' },
  { code: 'VALIDATE', name: '校验计划', description: '校验字段白名单、数据集和数据权限' },
  { code: 'EXECUTE', name: '执行查询', description: '通过受控适配器执行只读查询' },
  { code: 'RESULT_ANALYST', name: '结果分析', description: '生成合计、TopN、趋势、异常和业务判断' },
  { code: 'RESULT_VALIDATION', name: 'Skill 结果验证', description: '按主题 Skill 验证结果和回答证据' },
  { code: 'ANALYZE', name: '分析结果', description: '选择可视化并提炼关键发现' },
  { code: 'RESPOND', name: '生成回答', description: '输出业务回答、证据与执行过程' },
];

const STAGE_DEFINITIONS = BASE_STAGE_DEFINITIONS.map((definition) => ({
  ...definition,
  gateIds: listGates({ phase: definition.code }).map((gate) => gate.id),
}));

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
  constructor({ question, user, theme, onEvent = null }) {
    this.id = `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.name = 'DataAgent Standard Workflow';
    this.version = '1.0';
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
    }));
    this.stageMap = new Map(this.stages.map((stage) => [stage.code, stage]));
    this.start('INTENT');
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

  finish(summary = '') {
    this.status = this.status === 'FAILED' ? 'FAILED' : 'COMPLETED';
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
    const completedCount = this.stages.filter(
      (stage) => stage.status === 'SUCCESS',
    ).length;
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      question: this.question,
      user: this.user,
      theme: this.theme,
      status: this.status,
      summary: this.summary ?? '',
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      durationMs: this.durationMs ?? null,
      progress: {
        completed: completedCount,
        total: this.stages.length,
        percent: Math.round((completedCount / this.stages.length) * 100),
      },
      stages: this.stages.map((stage) => ({ ...stage })),
    };
  }
}

export { STAGE_DEFINITIONS };
