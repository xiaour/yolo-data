import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();
const TRACE_ID_PATTERN = /^[A-Za-z0-9_.:-]{4,128}$/;

export function createTraceId() {
  return `tr_${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
}

export function normalizeTraceId(value) {
  const candidate = String(value ?? '').trim();
  return TRACE_ID_PATTERN.test(candidate) ? candidate : null;
}

// Runs fn with a trace context so every downstream audit/plan/LLM/dataset write
// can attach the same traceId without threading it through each signature.
export function runWithTrace(traceId, fn) {
  const normalized = normalizeTraceId(traceId) ?? createTraceId();
  return storage.run({ traceId: normalized }, fn);
}

export function currentTraceId() {
  return storage.getStore()?.traceId ?? null;
}
