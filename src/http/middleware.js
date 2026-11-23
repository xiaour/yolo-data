// Middleware pipeline for the route table (P0-8). Each entry is a factory that
// returns a (ctx, next) handler so routes can parametrize them, e.g.
// `timeout:180s`, `rateLimit:chat`.

import { incrementCounter } from '../metrics.js';
import { getRequestUser, getRequestUserAsync, requireAdmin, sendError } from './support.js';
import { createTokenBucket, limiterFor, readLimit } from './rateLimitBucket.js';

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
      ctx.user = await getRequestUserAsync(ctx.request, ctx.database, ctx.config);
      return next();
    },

    admin: () => async (ctx, next) => {
      ctx.user = ctx.user ?? await getRequestUserAsync(ctx.request, ctx.database, ctx.config);
      requireAdmin(ctx.user);
      return next();
    },

    // 登录接口不能用 auth 版限流（那时还没有用户），改按来源 IP 限流。
    loginRateLimit: () => {
      const limit = createTokenBucket({
        capacity: readLimit('RATE_LIMIT_LOGIN_CAPACITY', 20),
        refillPerSecond: readLimit('RATE_LIMIT_LOGIN_REFILL_PER_SECOND', 0.5),
      });
      return async (ctx, next) => {
        const ip = ctx.request.socket?.remoteAddress ?? 'unknown';
        if (!limit(`login:${ip}`)) {
          incrementCounter('rate_limit_reject_total', { profile: 'login' });
          throw Object.assign(
            new Error('登录尝试过于频繁，请稍后再试'),
            { statusCode: 429, code: 'RATE_LIMITED' },
          );
        }
        return next();
      };
    },

    // Hard ceiling for non-streaming requests. Never applied to NDJSON streams
    // because a long analysis stream is a legitimate, expected duration.
    timeout: (arg) => async (ctx, next) => {
      const seconds = parseSeconds(arg, 120);
      const controller = new AbortController();
      const previousSignal = ctx.signal;
      const signal = previousSignal
        ? AbortSignal.any([previousSignal, controller.signal])
        : controller.signal;
      ctx.signal = signal;
      let timer = null;
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
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
        if (ctx.signal === signal) {
          ctx.signal = previousSignal;
        }
      }
    },

    // Token bucket keyed by user + theme (P0-5 foundation).
    rateLimit: (arg) => async (ctx, next) => {
      if (!ctx.user) {
        ctx.user = await getRequestUser(ctx.request, ctx.database, ctx.config);
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
