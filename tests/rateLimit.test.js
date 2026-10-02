process.env.RATE_LIMIT_CHAT_CAPACITY = '1';
process.env.RATE_LIMIT_CHAT_REFILL_PER_SECOND = '0.001';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer } from '../src/server.js';
import { FakeIndicatorClient } from './fixtures/fakeIndicatorClient.js';

function testConfig(directory) {
  return {
    projectRoot: process.cwd(),
    port: 0,
    dbPath: path.join(directory, 'test.db'),
    supersonic: { baseUrl: '', token: '', timeoutMs: 5_000 },
    deepseek: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      timeoutMs: 5_000,
      maxToolRounds: 3,
    },
    chatMemoryMessageLimit: 20,
    datasourceSecretKey: '',
    datasourceSecretKeyPath: path.join(directory, '.credential-key'),
    bootstrapDatasource: { enabled: false },
  };
}

test('P0-8 rateLimit:chat buckets per user and rejects with a 429 envelope', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-rate-'));
  const { server, application } = await startServer(
    testConfig(directory),
    new FakeIndicatorClient(),
  );
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const analyst = { 'content-type': 'application/json', 'x-user-id': '2' };
  try {
    const first = await fetch(`${baseUrl}/api/chat/query`, {
      method: 'POST',
      headers: analyst,
      body: '{not json',
    });
    // The limiter admits the first call; the handler then rejects the body.
    assert.equal(first.status, 400);

    const second = await fetch(`${baseUrl}/api/chat/query`, {
      method: 'POST',
      headers: analyst,
      body: '{not json',
    });
    assert.equal(second.status, 429);
    assert.deepEqual(await second.json(), {
      code: 429,
      message: '请求过于频繁，请稍后再试',
    });

    // A different user has an independent bucket.
    const otherUser = await fetch(`${baseUrl}/api/chat/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': '3' },
      body: '{not json',
    });
    assert.equal(otherUser.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    application.database.close();
  }
});
