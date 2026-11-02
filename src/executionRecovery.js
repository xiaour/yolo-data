export { buildReplanCarryForward } from './replanCarryForward.js';

const NON_RECOVERABLE_PATTERNS = [
  /permission denied|权限|无权|禁止访问/i,
  /api key|密钥|调用权限|没有调用权限/i,
  /not configured|未配置|未启用|不可用/i,
  /request_clarification|需要.*(确认|补充)|口径.*(缺失|确认)/i,
  /user.*cancel|aborted|用户.*取消/i,
];

export function classifyRecoveryError(error, { signal = null } = {}) {
  if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return { retryable: false, category: 'CANCELLED', reason: '用户或请求已取消' };
  }
  if (Number(error?.statusCode) === 401 || Number(error?.statusCode) === 403) {
    return { retryable: false, category: 'PERMISSION', reason: '权限或密钥错误' };
  }
  const message = String(error?.message ?? '');
  const matched = NON_RECOVERABLE_PATTERNS.find((pattern) => pattern.test(message));
  if (matched) {
    return { retryable: false, category: 'NON_RECOVERABLE', reason: '需要配置、权限或用户确认' };
  }
  if (error?.code === 'REQUEST_TIMEOUT' || /超时|timed out|timeout/i.test(message)) {
    return { retryable: true, category: 'TIMEOUT', reason: '执行超时，可更换计划或降低范围' };
  }
  if (/429|请求过于频繁|访问量过大|rate.?limit|temporarily unavailable|上游.*不可用/i.test(message)) {
    return { retryable: true, category: 'TRANSIENT_UPSTREAM', reason: '上游服务暂时不可用' };
  }
  return { retryable: true, category: 'EXECUTION', reason: '查询或工具执行失败，可重新规划' };
}

export function recoverySignature(error, context = {}) {
  const phase = context.phase ?? error?.recoveryContext?.phase ?? '';
  const message = String(error?.message ?? '').slice(0, 240);
  return `${phase}|${message}`;
}
