import assert from 'node:assert/strict';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import { FeedbackService } from '../src/feedback.js';
import { GrowthService } from '../src/growth.js';

for (const fails of [false, true]) {
  test(`negative async feedback ${fails ? 'propagates growth persistence failure' : 'waits for its knowledge gap'}`, async t => {
    const database = new PlatformDatabase(':memory:');
    t.after(() => database.closeAsync());
    const failure = new Error('knowledge gap insert failed');
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    const adapter = {
      isAsyncPlatformStore: true,
      async saveFeedbackAsync(input) { return database.saveFeedback(input); },
      recordKnowledgeGapAsync(input) {
        const write = (async () => {
          entered(); await gate;
          if (fails) throw failure;
          return database.recordKnowledgeGap(input);
        })();
        // Observe the injected driver's promise even on the broken implementation.
        write.catch(() => {});
        return write;
      },
    };
    const service = new FeedbackService(adapter, new GrowthService(adapter));
    const args = { userId: database.getUserByUsername('admin').id, themeId: 1,
      question: 'Which sales measure?', correct: false, comment: 'Use signed sales' };
    let completed = false;
    const pending = service.submitAsync(args);
    const outcome = pending.then(value => { completed = true; return { value }; },
      error => { completed = true; return { error }; });
    await ready;
    await new Promise(setImmediate);
    try { assert.equal(completed, false, 'submission must remain pending until growth persistence finishes'); }
    finally { release(); await outcome; }
    const result = await outcome;
    assert.equal(database.listFeedback().length, 1);
    if (fails) {
      assert.equal(result.error, failure);
      assert.equal(database.listKnowledgeGaps().length, 0);
    } else {
      assert.equal(result.value.correct, false);
      const gap = database.listKnowledgeGaps()[0];
      assert.equal(gap.kind, 'FEEDBACK');
      assert.equal(gap.source, 'USER_FEEDBACK');
      assert.equal(gap.term, args.question);
      assert.equal(gap.context.comment, args.comment);
    }
  });
}

test('positive async feedback does not create a knowledge gap', async t => {
  const database = new PlatformDatabase(':memory:');
  t.after(() => database.closeAsync());
  const adapter = { isAsyncPlatformStore: true,
    async saveFeedbackAsync(input) { return database.saveFeedback(input); },
    recordKnowledgeGapAsync() { throw new Error('positive feedback must not enter growth persistence'); },
  };
  const service = new FeedbackService(adapter, new GrowthService(adapter));
  const result = await service.submitAsync({ userId: database.getUserByUsername('admin').id,
    themeId: 1, question: 'Sales?', correct: true });
  assert.equal(result.correct, true);
  assert.equal(database.listFeedback().length, 1);
  assert.equal(database.listKnowledgeGaps().length, 0);
});
