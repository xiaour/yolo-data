import assert from 'node:assert/strict';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import { PlatformLogRepository } from '../src/platformLogRepository.js';
import { runWithTrace } from '../src/trace.js';

for (const asyncOnly of [false, true]) {
  test(`async logs persist and aggregate on ${asyncOnly ? 'async-only adapter' : 'in-memory SQLite'}`, async t => {
    const database = new PlatformDatabase(':memory:');
    t.after(() => database.closeAsync());
    const store = {
      async query(sql, bindings = []) { return database.db.prepare(sql).all(...bindings); },
      async execute(sql, bindings = []) {
        const result = database.db.prepare(sql).run(...bindings);
        return { insertId: Number(result.lastInsertRowid), changes: Number(result.changes) };
      },
    };
    const repo = asyncOnly ? new PlatformLogRepository(null, store) : database.logRepository;
    assert.deepEqual(await repo.llmLogStatsAsync(), { total: 0, successCount: 0, successRate: 0, avgLatencyMs: 0 });
    assert.equal(await repo.sumTokenUsageAsync(), 0);
    const userId = database.getUserByUsername('admin').id;
    const first = await runWithTrace('async-log-trace', () => repo.logLlmCallAsync({
      userId, themeId: 1, callType: 'ANSWER', tokenUsage: { prompt_tokens: 3, completion_tokens: 4 },
      promptDigest: 'a'.repeat(600), latencyMs: 10, success: true,
    }));
    await repo.logLlmCallAsync({ themeId: 2, callType: 'ANSWER', tokenUsage: { total_tokens: 5 },
      latencyMs: 30, success: false, errorMessage: 'driver error' });
    const [row] = await repo.listLlmLogsAsync(1, { traceId: 'async-log-trace' });
    assert.equal(row.id, first);
    assert.equal(row.success, true);
    assert.equal(row.promptDigest.length, 500);
    assert.deepEqual(row.tokenUsage, { prompt_tokens: 3, completion_tokens: 4 });
    assert.deepEqual(await repo.llmLogStatsAsync(), { total: 2, successCount: 1, successRate: 50, avgLatencyMs: 20 });
    assert.equal(await repo.sumTokenUsageAsync(), 12);
    assert.equal(await repo.sumTokenUsageAsync({ userId, themeId: 1 }), 7);
    assert.equal(await repo.sumTokenUsageAsync({ sinceIso: '2999-01-01' }), 0);
    database.db.prepare('UPDATE llm_call_logs SET token_usage_json = ? WHERE id = ?').run('broken', first);
    assert.equal(await repo.sumTokenUsageAsync(), 5);
    assert.deepEqual((await repo.listLlmLogsAsync(1, { traceId: 'async-log-trace' }))[0].tokenUsage, {});
    const audit = await repo.addAuditLogAsync({ action: 'ASYNC', traceId: 'audit', detail: { items: [1] } });
    assert.equal((await repo.listAuditLogsAsync(1, { traceId: 'audit' }))[0].id, audit);
    assert.deepEqual((await repo.listAuditLogsAsync(1, { traceId: 'audit' }))[0].detail, { items: [1] });
  });
}

test('async log driver errors propagate to callers', async () => {
  const failure = new Error('driver unavailable');
  const reject = async () => { throw failure; };
  const repo = new PlatformLogRepository(null, { query: reject, execute: reject });
  await assert.rejects(repo.llmLogStatsAsync(), error => error === failure);
  await assert.rejects(repo.sumTokenUsageAsync(), error => error === failure);
  await assert.rejects(repo.logLlmCallAsync({ callType: 'ANSWER' }), error => error === failure);
});
