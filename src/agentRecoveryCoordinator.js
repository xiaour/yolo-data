import { classifyRecoveryError, recoverySignature } from './executionRecovery.js';

export function createAgentRecoveryCoordinator({
  maxAttempts = 5,
  signal = null,
  onEvent = null,
  onTerminalFailure = null,
} = {}) {
  const limit = Math.max(5, Math.min(8, Number(maxAttempts) || 5));
  const signatures = new Set();
  let attempts = 0;
  let hint = '';

  return {
    get attempts() { return attempts; },
    get hint() { return hint; },
    async run(operation, { sessionId = null, userId = null } = {}) {
      try {
        return await operation(hint, attempts, { sessionId, userId });
      } catch (error) {
        const recovery = classifyRecoveryError(error, { signal });
        const context = error.recoveryContext ?? {};
        const signature = recoverySignature(error, context);
        const repeated = signatures.has(signature);
        if (attempts >= limit || !recovery.retryable || repeated) {
          error.recovery = { ...recovery, repeatedPlan: repeated, attempts };
          await onTerminalFailure?.(error, { sessionId, userId, attempts });
          throw error;
        }
        signatures.add(signature);
        attempts += 1;
        hint = [
          `第 ${attempts}/${limit} 次异常恢复规划（${recovery.category}）。上一轮在 ${context.phase ?? '未知阶段'} 失败：${error.message}`,
          `已完成/失败节点：${(context.completedStages ?? []).map((stage) => `${stage.code}:${stage.status}${stage.summary ? `(${stage.summary})` : ''}`).join('；') || '暂无'}`,
          `最近执行步骤：${(context.processSteps ?? []).map((step) => `${step.title}:${step.status}${step.detail ? `(${step.detail})` : ''}`).join('；') || '暂无'}`,
          '请依据当前智能体完整提示词、会话记忆、任务状态、工作流节点和用户原问题重新规划；明确更换失败路径，不要重复相同调用。可使用当前允许的查询契约工具或已配置的工作流/分析工具。不得绕过数据权限、字段口径、查询契约；代码沙箱只能处理已物化的工作区数据，不能直接访问数据库或伪造结果。',
        ].join('\n');
        try {
          onEvent?.({
            type: 'recovery_attempt',
            attempt: attempts,
            maxAttempts: limit,
            error: error.message,
            category: recovery.category,
            phase: context.phase ?? null,
          });
        } catch {
          // A disconnected stream must not interrupt recovery.
        }
        return this.run(operation, { sessionId: context.sessionId ?? sessionId, userId });
      }
    },
  };
}
