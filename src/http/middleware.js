// Middleware pipeline for the route table (P0-8). Each entry is a factory that
// returns a (ctx, next) handler so routes can parametrize them, e.g.
// `timeout:180s`, `rateLimit:chat`.

import { incrementCounter } from '../metrics.js';
import { getRequestUser, requireAdmin, sendError } from './support.js';

function readLimit(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createTokenBucket({ capacity, refillPerSecond }) {
  const buckets = new Map();
  return (key) => {
    const now = Date.now();
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

function limiterFor(profile) {
  const key = RATE_LIMIT_PROFILES[profile] ? profile : 'default';
  if (!limiters.has(key)) {
    limiters.set(key, RATE_LIMIT_PROFILES[key]());
  }
  return { key, limit: limiters.get(key) };
}

function parseSeconds(text, fallbackSeconds) {
  const match = String(text ?? '').match(/^(\d+)(ms|s|m)?$/);
  if (!match) {
    return fallbackSeconds;
  }
  const value = Number(match[1]);
  switch (match[2]) {
    case 'ms': return value / 1000;
    case 'm': return value * 60;
    default: return value;
  }
}

export function createMiddlewareRegistry() {
  return {
    // Framework-level boundary: every route runs behind this (see router.js),
    // so a thrown handler can never escape as an unhandled rejection. It sends
    // the exact same error envelope as the dispatcher fallback did before.
    errorBoundary: () => async (ctx, next) => {
      try {
        return await next();
      } catch (error) {
        if (!ctx.response.headersSent) {
          sendError(ctx.response, error);
        } else {
          ctx.response.end();
        }
        return undefined;
      }
    },

    // Resolves the caller once and shares it with downstream middleware/handler.
    auth: () => async (ctx, next) => {
      ctx.user = getRequestUser(ctx.request, ctx.database);
      return next();
    },

    admin: () => async (ctx, next) => {
      ctx.user = ctx.user ?? getRequestUser(ctx.request, ctx.database);
      requireAdmin(ctx.user);
      return next();
    },

    // Hard ceiling for non-streaming requests. Never applied to NDJSON streams
    // because a long analysis stream is a legitimate, expected duration.
    timeout: (arg) => async (ctx, next) => {
      const seconds = parseSeconds(arg, 120);
      let timer = null;
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(
            new Error(`request timed out after ${seconds}s`),
            { statusCode: 504, code: 'REQUEST_TIMEOUT' },
          ));
        }, seconds * 1000);
        timer.unref?.();
      });
      // The handler keeps running after the timeout fires, so swallow its late
      // completion/rejection instead of crashing the process with an
      // unhandled rejection once we have already answered with 504.
      const work = next();
      work.catch(() => {});
      try {
        return await Promise.race([work, timeout]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },

    // Token bucket keyed by user + theme (P0-5 foundation).
    rateLimit: (arg) => async (ctx, next) => {
      if (!ctx.user) {
        ctx.user = getRequestUser(ctx.request, ctx.database);
      }
      // themeId is only readable from the query string here: the JSON body is
      // consumed by the handler. Body-based routes therefore fall back to a
      // per-user bucket (see docs/capability-gaps.md).
      const themeKey = ctx.query.get('themeId');
      const key = themeKey
        ? `user:${ctx.user.id}:theme:${themeKey}`
        : `user:${ctx.user.id}`;
      const { key: profile, limit } = limiterFor(arg ?? 'default');
      if (!limit(key)) {
        incrementCounter('rate_limit_reject_total', { profile });
        const error = new Error('请求过于频繁，请稍后再试');
        error.statusCode = 429;
        error.code = 'RATE_LIMITED';
        throw error;
      }
      return next();
    },
  };
}
