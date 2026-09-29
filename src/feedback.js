export class FeedbackService {
  constructor(database, growth = null) {
    this.database = database;
    this.growth = growth;
  }

  submit({
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
      ? this.database.getChatMessage(messageId, userId)
      : null;
    if (messageId && !message) {
      throw new Error('assistant message not found');
    }
    const resolvedThemeId = themeId
      ?? message?.result?.theme?.id
      ?? this.database.getChatSession(sessionId, userId)?.themeId;
    if (!userId || !resolvedThemeId) {
      throw new Error('user and theme are required');
    }
    const id = this.database.saveFeedback({
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
      this.growth?.record({
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

  list({ themeId = null, correct = null, limit = 100 } = {}) {
    return this.database.listFeedback({ themeId, correct, limit });
  }

  promptHints(themeId, limit = 8) {
    return this.database.listFeedback({ themeId, correct: false, limit })
      .map((item) => {
        const corrected = item.corrected ?? {};
        const correction = corrected.indicatorId
          ? `；修正指标：${corrected.indicatorId}`
          : '';
        return `- 问题「${item.question}」${item.comment ? `，反馈：${item.comment}` : ''}${correction}`;
      });
  }
}
