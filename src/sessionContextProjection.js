import { serializeTaskForContract } from './turnContext.js';

export function projectUnderstandingContext(session, rows, memoryMessage) {
  const turns = rows.map((message) => {
    const taskState = message.result?.taskState ?? null;
    return {
      id: message.id,
      role: message.role,
      content: String(message.content ?? ''),
      question: message.result?.question ?? String(message.content ?? ''),
      taskState,
      artifactId: message.result?.artifactId ?? null,
      runtimeMode: message.result?.runtime?.mode ?? null,
      computeMode: message.result?.runtime?.computeMode ?? null,
      createdAt: message.createdAt ?? message.created_at ?? null,
      messageId: message.id,
    };
  });
  const messages = turns.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const lastTaskState = [...turns].reverse().find((message) => message.taskState)?.taskState ?? null;
  return {
    messages,
    turns,
    memoryMessage,
    lastTaskState,
    historyMessageCount: messages.length,
    themeId: session.themeId,
  };
}

export function buildExecutionContext({ taskState = null, question = '' } = {}) {
  const sourceContext = serializeTaskForContract(taskState, question);
  const systemMessage = taskState
    ? {
      role: 'system',
      content: [
        '本轮执行契约（唯一可用的会话上下文）：',
        sourceContext,
        '执行约束：只能使用上面的显式条件和继承槽位；不得自行引用原始聊天历史、长期记忆或其他任务的指标、时间、筛选和结果。',
      ].join('\n'),
    }
    : null;
  return {
    messages: [],
    systemMessage,
    sourceContext,
    taskState,
  };
}

