import { incrementCounter } from '../metrics.js';

// 令牌桶限流子系统：桶原语、环境变量容量配置与按档位的进程级共享桶。
// 中间件装配见 ../http/middleware.js 的 rateLimit/loginRateLimit。

export function readLimit(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createTokenBucket({ capacity, refillPerSecond, sweepIntervalMs = 60_000 }) {
  const buckets = new Map();
  let lastSweepAt = 0;
  const limit = (key) => {
    const now = Date.now();
    // Evict buckets that have fully refilled to capacity: such a bucket is
    // indistinguishable from a fresh one, so dropping it can never loosen an
    // active limit. Without this sweep the map grows with every unique
    // user / theme / IP key for the lifetime of the process.
    if (now - lastSweepAt >= sweepIntervalMs) {
      lastSweepAt = now;
      for (const [bucketKey, bucket] of buckets) {
        const refilled = bucket.tokens
          + ((now - bucket.updatedAt) / 1000) * refillPerSecond;
        if (refilled >= capacity) {
          buckets.delete(bucketKey);
        }
      }
    }
    const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: now };
    const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
    bucket.updatedAt = now;
    const allowed = bucket.tokens >= 1;
    if (allowed) {
      bucket.tokens -= 1;
    }
    buckets.set(key, bucket);
    return allowed;
  };
  limit.size = () => buckets.size;
  return limit;
}

const RATE_LIMIT_PROFILES = {
  chat: () => createTokenBucket({
    capacity: readLimit('RATE_LIMIT_CHAT_CAPACITY', 30),
    refillPerSecond: readLimit('RATE_LIMIT_CHAT_REFILL_PER_SECOND', 0.5),
  }),
  default: () => createTokenBucket({
    capacity: readLimit('RATE_LIMIT_DEFAULT_CAPACITY', 120),
    refillPerSecond: readLimit('RATE_LIMIT_DEFAULT_REFILL_PER_SECOND', 2),
  }),
};

const limiters = new Map();

export function limiterFor(profile) {
  const key = RATE_LIMIT_PROFILES[profile] ? profile : 'default';
  if (!limiters.has(key)) {
    limiters.set(key, RATE_LIMIT_PROFILES[key]());
  }
  return { key, limit: limiters.get(key) };
}
