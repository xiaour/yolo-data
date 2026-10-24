// 分布式会话锁骨架（P0-1 的一部分）。
//
// 现状：SQLite 单节点 + Node 单进程，会话编辑/执行没有跨请求互斥。多实例部署时
// 需要真正的分布式锁（Redis 等）。这里给出统一接口 + 两种后端：
//   - 'sqlite'（默认）：基于租约表的进程级互斥，跨进程能力受限于 SQLite 单写者，
//     但比"无锁"强，且零依赖，可直接用于单节点生产。
//   - 'redis'：接口占位，需接入 Redis 客户端（ioredis/redis）与 REDIS_URL。
//     真正的分布式互斥依赖这里，故在未提供客户端时明确报错，而不是假装成功。

export function createDistributedLock({ backend = 'sqlite', database = null, redis = null } = {}) {
  if (backend === 'redis') {
    if (!redis) {
      // 诚实失败：不伪造一个非分布式的锁。
      return {
        backend: 'redis',
        enabled: false,
        async acquire() {
          throw new Error('分布式锁 backend=redis 但未提供 Redis 客户端，请配置 REDIS_URL 并注入客户端');
        },
        async release() { return false; },
        async refresh() { return false; },
      };
    }
    return createRedisLock(redis);
  }

  // 租约存储通过平台数据库接口操作，避免依赖 DatabaseSync。
  if (!database) {
    throw new Error('distributedLock 需要 platform database 实例');
  }
  return createPlatformLock(database);
}

function createPlatformLock(database) {
  return {
    backend: database.knexStore?.backend ?? 'platform',
    enabled: true,
    async acquire(key, owner, ttlMs = 30_000) {
      const now = Date.now();
      const expiresAt = new Date(now + ttlMs).toISOString();
      if (database.knexStore?.backend === 'mysql') {
        const rows = await database.query('SELECT owner, expires_at AS expiresAt FROM session_locks WHERE `key` = ?', [String(key)]);
        const current = rows[0];
        if (current && Date.parse(current.expiresAt) > now) return false;
        if (current) {
          const result = await database.execute('UPDATE session_locks SET owner=?, expires_at=? WHERE `key`=? AND expires_at<=?', [String(owner), expiresAt, String(key), new Date(now).toISOString()]);
          return Number(result.affectedRows) > 0;
        }
        try {
          await database.execute('INSERT INTO session_locks (`key`, owner, expires_at) VALUES (?, ?, ?)', [String(key), String(owner), expiresAt]);
          return true;
        } catch (error) {
          if (/duplicate|unique/i.test(error.message)) return false;
          throw error;
        }
      }
      try {
        await database.execute(`INSERT INTO session_locks (
          "key", owner, expires_at
        ) VALUES (?, ?, ?) ON CONFLICT("key") DO UPDATE SET
          owner = excluded.owner, expires_at = excluded.expires_at
          WHERE session_locks.expires_at <= ?`,
        [String(key), String(owner), expiresAt, new Date(now).toISOString()]);
        const rows = await database.query('SELECT owner FROM session_locks WHERE `key` = ?', [String(key)]);
        return rows[0]?.owner === String(owner);
      } catch (error) { throw error; }
    },
    async release(key, owner) {
      const result = await database.execute('DELETE FROM session_locks WHERE `key` = ? AND owner = ?', [String(key), String(owner)]);
      return Number(result.affectedRows) > 0;
    },
    async refresh(key, owner, ttlMs = 30_000) {
      const result = await database.execute('UPDATE session_locks SET expires_at = ? WHERE `key` = ? AND owner = ?', [new Date(Date.now() + ttlMs).toISOString(), String(key), String(owner)]);
      return Number(result.affectedRows) > 0;
    },
  };
}

function createRedisLock(redis) {
  // redis 需提供 set(key, val, { nx: true, px }) / del / pexpire 语义的客户端。
  // 这里用最小接口约定，避免引入具体客户端依赖。
  const LOCK_PREFIX = 'yolo:lock:';
  return {
    backend: 'redis',
    enabled: true,
    async acquire(key, owner, ttlMs = 30_000) {
      const ok = await redis.set(LOCK_PREFIX + key, owner, { nx: true, px: ttlMs });
      return Boolean(ok);
    },
    async release(key, owner) {
      const full = LOCK_PREFIX + key;
      const script = `if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end`;
      const result = await redis.eval?.(script, 1, full, owner);
      return Number(result) === 1;
    },
    async refresh(key, owner, ttlMs = 30_000) {
      const full = LOCK_PREFIX + key;
      const current = await redis.get(full);
      if (current !== owner) return false;
      await redis.pexpire(full, ttlMs);
      return true;
    },
  };
}
