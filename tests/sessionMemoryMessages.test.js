import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionMemoryStore } from '../src/memory.js';

for (const asyncOnly of [false, true]) {
  const label = asyncOnly ? 'async-only' : 'synchronous';
  test(`${label} message persistence returns before background distillation completes`, async () => {
    const reads = [];
    const written = [];
    const ingested = [];
    const append = input => { const message = { id: 23, ...input }; written.push(message); return message; };
    const session = (...args) => { reads.push(args); return { themeId: 4 }; };
    const history = (...args) => { reads.push(args); return [
      { role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'current question' },
    ]; };
    const forbidden = () => { throw new Error('sync fallback forbidden'); };
    const database = asyncOnly ? {
      isAsyncPlatformStore: true,
      appendChatMessage: forbidden, getChatSession: forbidden, listChatMessages: forbidden,
      appendChatMessageAsync: async input => append(input),
      getChatSessionAsync: async (...args) => session(...args),
      listChatMessagesAsync: async (...args) => history(...args),
    } : { appendChatMessage: append, getChatSession: session, listChatMessages: history };
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const memory = new SessionMemoryStore(database, { contextLimit: 5 }).attachDistiller({
      ingest: input => { ingested.push(input); return pending; },
    });
    try {
      const message = asyncOnly
        ? await memory.appendAssistantMessageAsync(7, 3, 'answer', {})
        : memory.appendAssistantMessage(7, 3, 'answer', {});
      assert.equal(message, written[0]);
      assert.equal(message.role, 'assistant');
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(ingested, [{ userId: 3, themeId: 4, sessionId: 7,
        question: 'current question', answer: 'answer' }]);
      assert.deepEqual(reads.at(-1), [7, 3, 5]);
    } finally { finish(); }
  });

  test(`${label} failed/empty turns skip distillation and rejected ingestion stays best-effort`, async () => {
    let calls = 0;
    const memory = new SessionMemoryStore({
      getChatSession: () => ({ themeId: 4 }), listChatMessages: () => [],
      getChatSessionAsync: async () => ({ themeId: 4 }), listChatMessagesAsync: async () => [],
      isAsyncPlatformStore: asyncOnly,
    }).attachDistiller({ ingest: async () => { calls++; throw new Error('distillation unavailable'); } });
    const run = input => asyncOnly ? memory.distillAfterTurnAsync(input) : memory.distillAfterTurn(input);
    await run({ sessionId: 7, userId: 3, content: 'failed', result: { error: true } });
    await run({ sessionId: 7, userId: 3, content: '  ', result: {} });
    assert.equal(calls, 0);
    await run({ sessionId: 7, userId: 3, content: 'answer', result: {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
  });
}
