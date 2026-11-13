import { callPlatformDatabase } from './platformDatabaseAccess.js';

// 长期记忆沉淀是旁路：失败、超时或未配置模型都不影响本轮回答。
export function distillAfterTurn(store, { sessionId, userId, content, result }) {
  // 失败轮次没有可沉淀的结论，直接跳过，避免无意义的模型调用。
  if (!store.distiller || result?.error || !String(content ?? '').trim()) {
    return;
  }
  try {
    const session = store.database.getChatSession(sessionId);
    const question = store.database.listChatMessages(sessionId, userId, store.contextLimit)
      .filter((message) => message.role === 'user')
      .at(-1)?.content ?? '';
    void store.distiller.ingest({
      userId,
      themeId: session?.themeId ?? null,
      sessionId,
      question,
      answer: content,
    }).catch(() => {});
  } catch {
    // 沉淀失败不影响主流程
  }
}

export async function distillAfterTurnAsync(store, { sessionId, userId, content, result }) {
  if (!store.distiller || result?.error || !String(content ?? '').trim()) return;
  try {
    const session = await callPlatformDatabase(store.database, 'getChatSessionAsync', 'getChatSession', sessionId, userId);
    const messages = await callPlatformDatabase(store.database, 'listChatMessagesAsync', 'listChatMessages', sessionId, userId, store.contextLimit);
    const question = messages
      .filter((message) => message.role === 'user')
      .at(-1)?.content ?? '';
    await store.distiller.ingest({
      userId,
      themeId: session?.themeId ?? null,
      sessionId,
      question,
      answer: content,
    });
  } catch {
    // Memory distillation is best-effort and must not affect the answer.
  }
}


export function appendUserMessage(store, sessionId, userId, content, result = {}) {
  return store.database.appendChatMessage({
    sessionId,
    userId,
    role: 'user',
    content,
    result,
  });
}

export function appendAssistantMessage(store, sessionId, userId, content, result) {
  const message = store.database.appendChatMessage({
    sessionId,
    userId,
    role: 'assistant',
    content,
    result,
  });
  store.distillAfterTurn({ sessionId, userId, content, result });
  return message;
}


export async function listMessagesAsync(store, sessionId, userId, limit = 100) {
  const messages = await callPlatformDatabase(store.database, 'listChatMessagesAsync', 'listChatMessages', sessionId, userId, limit);
  if (messages === null) throw new Error('chat session not found');
  return messages;
}

export async function appendUserMessageAsync(store, sessionId, userId, content, result = {}) {
  return callPlatformDatabase(store.database, 'appendChatMessageAsync', 'appendChatMessage', { sessionId, userId, role: 'user', content, result });
}
export async function appendAssistantMessageAsync(store, sessionId, userId, content, result) {
  const message = await callPlatformDatabase(store.database, 'appendChatMessageAsync', 'appendChatMessage', { sessionId, userId, role: 'assistant', content, result });
  void store.distillAfterTurnAsync({ sessionId, userId, content, result });
  return message;
}

export function listMessages(store, sessionId, userId, limit = 100) {
  const messages = store.database.listChatMessages(sessionId, userId, limit);
  if (messages === null) {
    throw new Error('chat session not found');
  }
  return messages;
}
