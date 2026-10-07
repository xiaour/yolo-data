// 会话记忆负责短期上下文（最近若干轮对话）；用户长期记忆通过 userMemories 注入，
// 沉淀由 distiller 在回答结束后异步完成，二者都不感知任何业务口径。
export class SessionMemoryStore {
  constructor(database, { contextLimit = 20, userMemories = null } = {}) {
    this.database = database;
    this.contextLimit = contextLimit;
    this.userMemories = userMemories;
    this.distiller = null;
  }

  attachDistiller(distiller) {
    this.distiller = distiller;
    return this;
  }

  createSession({ userId, themeId, title, modelId = null }) {
    return this.database.createChatSession({ userId, themeId, title, modelId });
  }

  listSessions(userId) {
    return this.database.listChatSessions(userId);
  }

  getSession(sessionId, userId) {
    const session = this.database.getChatSession(sessionId, userId);
    if (!session) {
      throw new Error('chat session not found');
    }
    return session;
  }

  listMessages(sessionId, userId, limit = 100) {
    const messages = this.database.listChatMessages(sessionId, userId, limit);
    if (messages === null) {
      throw new Error('chat session not found');
    }
    return messages;
  }

  deleteSession(sessionId, userId) {
    return this.database.deleteChatSession(sessionId, userId);
  }

  appendUserMessage(sessionId, userId, content, result = {}) {
    return this.database.appendChatMessage({
      sessionId,
      userId,
      role: 'user',
      content,
      result,
    });
  }

  appendAssistantMessage(sessionId, userId, content, result) {
    const message = this.database.appendChatMessage({
      sessionId,
      userId,
      role: 'assistant',
      content,
      result,
    });
    this.distillAfterTurn({ sessionId, userId, content, result });
    return message;
  }

  buildModelContext(sessionId, userId) {
    const session = this.getSession(sessionId, userId);
    const history = this.database.listChatMessages(sessionId, userId, this.contextLimit)
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));
    const memoryMessage = this.userMemories?.buildContextMessage(userId, session.themeId);
    return memoryMessage ? [memoryMessage, ...history] : history;
  }

  // 长期记忆沉淀是旁路：失败、超时或未配置模型都不影响本轮回答。
  distillAfterTurn({ sessionId, userId, content, result }) {
    // 失败轮次没有可沉淀的结论，直接跳过，避免无意义的模型调用。
    if (!this.distiller || result?.error || !String(content ?? '').trim()) {
      return;
    }
    try {
      const session = this.database.getChatSession(sessionId);
      const question = this.database.listChatMessages(sessionId, userId, this.contextLimit)
        .filter((message) => message.role === 'user')
        .at(-1)?.content ?? '';
      this.distiller.ingest({
        userId,
        themeId: session?.themeId ?? null,
        sessionId,
        question,
        answer: content,
      });
    } catch {
      // 沉淀失败不影响主流程
    }
  }

  maybeSetInitialTitle(sessionId, content) {
    const session = this.database.getChatSession(sessionId);
    if (!session || session.title !== '新会话') {
      return session;
    }
    const title = String(content ?? '').trim().replace(/\s+/g, ' ').slice(0, 24) || '新会话';
    return this.database.updateChatSession(sessionId, { title });
  }
}
