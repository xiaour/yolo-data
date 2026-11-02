import { appendUserMessage, appendAssistantMessage, appendUserMessageAsync, appendAssistantMessageAsync, listMessages, listMessagesAsync, distillAfterTurn, distillAfterTurnAsync } from './sessionMemoryMessages.js';
import { buildExecutionContext, buildLegacyModelContext, buildUnderstandingContext, buildUnderstandingContextAsync, updateInitialTitle, updateInitialTitleAsync } from './sessionMemoryContext.js';
import { callPlatformDatabase } from './platformDatabaseAccess.js';

// 会话记忆只负责“理解上下文”；执行阶段通过结构化任务状态单独装配，
// 避免原始聊天记录和长期记忆直接污染查询契约。
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

  async createSessionAsync(args) {
    return callPlatformDatabase(this.database, 'createChatSessionAsync', 'createChatSession', args);
  }
  async listSessionsAsync(userId) {
    return callPlatformDatabase(this.database, 'listChatSessionsAsync', 'listChatSessions', userId);
  }
  async getSessionAsync(sessionId, userId) {
    const session = await callPlatformDatabase(this.database, 'getChatSessionAsync', 'getChatSession', sessionId, userId);
    if (!session) throw new Error('chat session not found');
    return session;
  }
  async listMessagesAsync(sessionId, userId, limit = 100) {
    return listMessagesAsync(this, sessionId, userId, limit);
  }

  async deleteSessionAsync(sessionId, userId) { return callPlatformDatabase(this.database, 'deleteChatSessionAsync', 'deleteChatSession', sessionId, userId); }
  async appendUserMessageAsync(sessionId, userId, content, result = {}) {
    return appendUserMessageAsync(this, sessionId, userId, content, result);
  }
  async appendAssistantMessageAsync(sessionId, userId, content, result) {
    return appendAssistantMessageAsync(this, sessionId, userId, content, result);
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
    return listMessages(this, sessionId, userId, limit);
  }

  deleteSession(sessionId, userId) {
    return this.database.deleteChatSession(sessionId, userId);
  }

  appendUserMessage(sessionId, userId, content, result = {}) {
    return appendUserMessage(this, sessionId, userId, content, result);
  }

  appendAssistantMessage(sessionId, userId, content, result) {
    return appendAssistantMessage(this, sessionId, userId, content, result);
  }

  buildUnderstandingContext(sessionId, userId) {
    return buildUnderstandingContext(this, sessionId, userId);
  }

  buildUnderstandingContextAsync(sessionId, userId) {
    return buildUnderstandingContextAsync(this, sessionId, userId);
  }

  buildExecutionContext({ taskState = null, question = '' } = {}) {
    return buildExecutionContext({ taskState, question });
  }

  // 兼容旧调用：旧入口只返回理解上下文，不再承担执行契约装配。
  buildModelContext(sessionId, userId) {
    return buildLegacyModelContext(this, sessionId, userId);
  }

  distillAfterTurn(args) {
    return distillAfterTurn(this, args);
  }

  async distillAfterTurnAsync(args) {
    return distillAfterTurnAsync(this, args);
  }

  maybeSetInitialTitle(sessionId, content) {
    return updateInitialTitle(this, sessionId, content);
  }

  async maybeSetInitialTitleAsync(sessionId, content) {
    return updateInitialTitleAsync(this, sessionId, content);
  }
}
