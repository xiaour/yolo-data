import assert from 'node:assert/strict';
import test from 'node:test';
import { createTokenBucket } from '../src/http/rateLimitBucket.js';

test('token bucket evicts fully refilled entries so the map stays bounded', async () => {
  const limit = createTokenBucket({
    capacity: 1,
    refillPerSecond: 1000,
    sweepIntervalMs: 0,
  });
  for (let i = 0; i < 50; i += 1) {
    assert.equal(limit(`user:${i}`), true);
  }
  // Let every bucket refill past capacity, then probe: the sweep must drop
  // the 50 idle buckets instead of keeping one map entry per key forever.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(limit('probe'), true);
  assert.ok(
    limit.size() <= 2,
    `expected idle buckets to be evicted, size=${limit.size()}`,
  );
});

test('token bucket never evicts a bucket that is still limiting', () => {
  const limit = createTokenBucket({
    capacity: 1,
    refillPerSecond: 0.001,
    sweepIntervalMs: 0,
  });
  assert.equal(limit('user:a'), true);
  assert.equal(limit('user:a'), false);
  // A call for another key triggers a sweep; the blocked bucket must survive
  // it, otherwise eviction would silently lift an active rate limit.
  assert.equal(limit('user:b'), true);
  assert.equal(limit('user:a'), false);
  assert.equal(limit('user:a'), false);
});

test('token bucket keeps classic allow-then-deny semantics', () => {
  const limit = createTokenBucket({
    capacity: 2,
    refillPerSecond: 0.001,
    sweepIntervalMs: 0,
  });
  assert.equal(limit('k'), true);
  assert.equal(limit('k'), true);
  assert.equal(limit('k'), false);
  assert.equal(limit('other'), true);
});
