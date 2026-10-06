export class SessionMemoryStore {
  constructor(database, { contextLimit = 20 } = {}) {
    this.database = database;
    this.contextLimit = contextLimit;
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
    return this.database.appendChatMessage({
      sessionId,
      userId,
      role: 'assistant',
      content,
      result,
    });
  }

  buildModelContext(sessionId, userId) {
    this.getSession(sessionId, userId);
    return this.database.listChatMessages(sessionId, userId, this.contextLimit)
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));
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
