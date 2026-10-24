import { createKnexPlatformStore } from './knexPlatformStore.js';

export const PLATFORM_DATABASE_BACKENDS = new Set(['sqlite', 'mysql']);

export function normalizePlatformDatabaseConfig(config = {}) {
  const backend = String(config.backend ?? 'sqlite').trim().toLowerCase() || 'sqlite';
  if (!PLATFORM_DATABASE_BACKENDS.has(backend)) {
    throw new Error(`不支持的平台数据库后端：${backend}。可选值为 sqlite 或 mysql。`);
  }
  const initSqlPath = config.initSqlPath
    ?? (backend === 'mysql'
      ? config.mysql?.initSqlPath ?? './config/platform/mysql-init.sql'
      : './config/platform/sqlite-init.sql');
  return { ...config, backend, initSqlPath };
}

export function createMysqlPlatformStore(config = {}) {
  const mysqlConfig = config.mysql ?? config;
  const normalized = normalizePlatformDatabaseConfig({
    ...config,
    backend: 'mysql',
    initSqlPath: config.initSqlPath ?? mysqlConfig.initSqlPath,
  });
  return createKnexPlatformStore({
    ...normalized,
    ...mysqlConfig,
    backend: 'mysql',
    initSqlPath: normalized.initSqlPath,
  });
}
