// MCP 速率限制：复用 http/middleware.js 的令牌桶实现，不重写算法。
// 按 tenantId:keyId 限流，超出返回 false（上层转 429）。

import { createTokenBucket } from '../http/rateLimitBucket.js';

export function createMcpRateLimiter({ rpm = 60, burst = 10 } = {}) {
  const bucket = createTokenBucket({
    capacity: Math.max(1, Number(burst) || 10),
    refillPerSecond: Math.max(0.01, (Number(rpm) || 60) / 60),
  });
  return {
    check(key) {
      return bucket(String(key));
    },
  };
}
