export async function withSessionExecutionLock({
  lock,
  sessionId,
  owner,
  operation,
  ttlMs = 600_000,
  refreshMs = 20_000,
} = {}) {
  if (!lock?.enabled || !sessionId) return operation();
  const key = `chat-session:${Number(sessionId)}`;
  const acquired = await lock.acquire(key, owner, ttlMs);
  if (!acquired) {
    throw Object.assign(new Error('当前会话正在执行另一个问题，请等待完成后再试'), {
      code: 'SESSION_BUSY',
      statusCode: 409,
    });
  }
  const timer = setInterval(() => {
    void lock.refresh(key, owner, ttlMs).catch(() => {});
  }, Math.max(5_000, refreshMs));
  timer.unref?.();
  try {
    return await operation();
  } finally {
    clearInterval(timer);
    await lock.release(key, owner).catch(() => {});
  }
}
