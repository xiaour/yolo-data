export function submitFeedback(service, {
    userId,
    themeId,
    sessionId,
    messageId,
    question,
    correct,
    comment,
    corrected,
  }) {
    const message = messageId
      ? service.database.getChatMessage(messageId, userId)
      : null;
    if (messageId && !message) {
      throw new Error('assistant message not found');
    }
    const resolvedThemeId = themeId
      ?? message?.result?.theme?.id
      ?? service.database.getChatSession(sessionId, userId)?.themeId;
    if (!userId || !resolvedThemeId) {
      throw new Error('user and theme are required');
    }
    const id = service.database.saveFeedback({
      userId,
      themeId: resolvedThemeId,
      sessionId: sessionId ?? message?.sessionId,
      messageId,
      question: question || message?.result?.question || '',
      correct: Boolean(correct),
      comment,
      corrected,
    });
    if (!correct) {
      service.growth?.record({
        term: question || message?.result?.question || `message-${messageId}`,
        kind: 'FEEDBACK',
        source: 'USER_FEEDBACK',
        context: {
          userId,
          themeId: resolvedThemeId,
          sessionId: sessionId ?? message?.sessionId,
          messageId,
          comment,
          corrected,
        },
      });
    }
    return {
      id,
      correct: Boolean(correct),
      message: '反馈已记录',
    };
  }

export async function submitFeedbackAsync(service, args) {
    if (!service.database.isAsyncPlatformStore) return submitFeedback(service, args);
    const { userId, themeId, sessionId, messageId, question, correct, comment, corrected } = args;
    const message = messageId ? await service.database.getChatMessageAsync(messageId, userId) : null;
    if (messageId && !message) throw new Error('assistant message not found');
    const session = !themeId && !message ? await service.database.getChatSessionAsync(sessionId, userId) : null;
    const resolvedThemeId = themeId ?? message?.result?.theme?.id ?? session?.themeId;
    if (!userId || !resolvedThemeId) throw new Error('user and theme are required');
    const id = await service.database.saveFeedbackAsync({ userId, themeId: resolvedThemeId, sessionId: sessionId ?? message?.sessionId,
      messageId, question: question || message?.result?.question || '', correct: Boolean(correct), comment, corrected });
    if (!correct) await service.growth?.record({ term: question || message?.result?.question || `message-${messageId}`, kind: 'FEEDBACK', source: 'USER_FEEDBACK',
      context: { userId, themeId: resolvedThemeId, sessionId: sessionId ?? message?.sessionId, messageId, comment, corrected } });
    return { id, correct: Boolean(correct), message: '反馈已记录' };
  }
