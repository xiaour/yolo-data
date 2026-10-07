// 长期记忆的自动维护巡检。
//
// 职责只有调度与并发保护：按固定间隔找出“有待合并笔记或正文过长”的作用域，
// 交给 UserMemoryDistiller 做合并与压缩。阈值判断、模型调用和版本落库都在 distiller 里，
// 这里不感知任何业务口径，也不直接读写记忆表。
//
// 设计约束：
// - 定时器 unref，不阻塞进程退出；测试里传入 intervalMs<=0 即为关闭。
// - 同一时刻只跑一轮，避免慢模型下任务叠加。
// - 失败只记数不抛出：后台任务不应该影响问数主流程。
export function startMemoryMaintenance({
  distiller,
  intervalMs = 0,
  startupDelayMs = 60_000,
  batchSize = 20,
  onError = null,
  now = () => Date.now(),
} = {}) {
  const state = {
    enabled: false,
    intervalMs: Number(intervalMs) || 0,
    lastRunAt: null,
    lastDurationMs: null,
    lastProcessed: 0,
    lastChanged: 0,
    totalRuns: 0,
    totalChanged: 0,
    errors: 0,
  };
  let running = false;
  let intervalHandle = null;
  let kickoffHandle = null;
  // 初始未停止：没有开启定时器时也允许手动 runOnce()，stop() 之后才拒绝执行。
  let stopped = false;

  async function sweep() {
    const store = distiller?.store;
    if (!store || typeof store.listMaintenanceTargets !== 'function') {
      return { processed: 0, changed: 0, skipped: true };
    }
    const compactThreshold = typeof distiller.compactThreshold === 'function'
      ? distiller.compactThreshold({ contentBudget: store.contentBudget })
      : 0;
    const targets = store.listMaintenanceTargets({ compactThreshold, limit: batchSize });
    let processed = 0;
    let changed = 0;
    const reasons = [];
    for (const target of targets) {
      try {
        const result = await distiller.maintain({
          userId: target.userId,
          themeId: target.themeId,
          auto: true,
          minPending: 1,
        });
        processed += 1;
        if (result?.changed) {
          changed += 1;
        }
        reasons.push({
          scopeKey: target.scopeKey,
          consolidated: result?.consolidated?.reason ?? null,
          compacted: result?.compacted?.reason ?? null,
        });
      } catch (error) {
        state.errors += 1;
        onError?.(error, target);
      }
    }
    return { processed, changed, reasons };
  }

  async function runOnce() {
    if (running || stopped) {
      return { processed: 0, changed: 0, skipped: true };
    }
    running = true;
    const startedAt = now();
    try {
      const result = await sweep();
      state.lastRunAt = new Date(startedAt).toISOString();
      state.lastDurationMs = now() - startedAt;
      state.lastProcessed = result.processed ?? 0;
      state.lastChanged = result.changed ?? 0;
      state.totalRuns += 1;
      state.totalChanged += result.changed ?? 0;
      return result;
    } catch (error) {
      state.errors += 1;
      onError?.(error, null);
      return { processed: 0, changed: 0, error: error.message };
    } finally {
      running = false;
    }
  }

  function start() {
    if (state.enabled || !distiller) {
      return false;
    }
    state.enabled = true;
    stopped = false;
    const interval = Math.max(1_000, state.intervalMs);
    kickoffHandle = setTimeout(() => {
      runOnce();
      intervalHandle = setInterval(runOnce, interval);
      intervalHandle.unref?.();
    }, Math.max(0, Number(startupDelayMs) || 0));
    kickoffHandle.unref?.();
    return true;
  }

  function stop() {
    stopped = true;
    state.enabled = false;
    if (kickoffHandle) {
      clearTimeout(kickoffHandle);
      kickoffHandle = null;
    }
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  function stats() {
    return {
      enabled: state.enabled,
      intervalMs: state.intervalMs,
      batchSize,
      lastRunAt: state.lastRunAt,
      lastDurationMs: state.lastDurationMs,
      lastProcessed: state.lastProcessed,
      lastChanged: state.lastChanged,
      totalRuns: state.totalRuns,
      totalChanged: state.totalChanged,
      errors: state.errors,
    };
  }

  const enabled = state.intervalMs > 0 && Boolean(distiller);
  if (enabled) {
    start();
  }

  return {
    start,
    stop,
    runOnce,
    stats,
    get enabled() {
      return state.enabled;
    },
  };
}
