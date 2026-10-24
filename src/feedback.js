import { submitFeedback, submitFeedbackAsync } from './feedbackSubmission.js';

export class FeedbackService {
  constructor(database, growth = null) {
    this.database = database;
    this.growth = growth;
  }

  submit(args) { return submitFeedback(this, args); }

  submitAsync(args) { return submitFeedbackAsync(this, args); }

  list({ themeId = null, correct = null, limit = 100 } = {}) {
    return this.database.listFeedback({ themeId, correct, limit });
  }

  async listAsync(options = {}) {
    return this.database.isAsyncPlatformStore
      ? this.database.listFeedbackAsync(options)
      : this.list(options);
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

  async promptHintsAsync(themeId, limit = 8) {
    const items = this.database.isAsyncPlatformStore
      ? await this.database.listFeedbackAsync({ themeId, correct: false, limit })
      : this.database.listFeedback({ themeId, correct: false, limit });
    return items.map((item) => {
      const corrected = item.corrected ?? {};
      const correction = corrected.indicatorId ? `；修正指标：${corrected.indicatorId}` : '';
      return `- 问题「${item.question}」${item.comment ? `，反馈：${item.comment}` : ''}${correction}`;
    });
  }
}
