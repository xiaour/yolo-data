import { PlatformDatabase } from './database.js';
import { createKnexPlatformStore } from './knexPlatformStore.js';
import { attachAsyncRepositories } from './platformAsyncRepositories.js';
import { seedMysqlPlatformDefaults } from './platformBootstrap.js';
import { normalizePlatformDatabaseConfig, createMysqlPlatformStore } from './platformBackend.js';
export { PLATFORM_DATABASE_BACKENDS, normalizePlatformDatabaseConfig, createMysqlPlatformStore } from './platformBackend.js';

// MySQL 适配器将在平台数据库接口完成异步化后启用。这里先把后端选择
// 收口到一个工厂，避免业务数据源配置误切换平台元数据库。
export function createPlatformDatabase(config = {}) {
  const normalized = normalizePlatformDatabaseConfig(config);
  if (normalized.backend === 'mysql') {
    throw new Error(
      'PLATFORM_DB_BACKEND=mysql 尚未启用：请先完成平台存储迁移，当前版本仅支持 sqlite。',
    );
  }
  return new PlatformDatabase(normalized.path, {
    seedBootstrapResources: normalized.seedResources === true,
    initSqlPath: normalized.initSqlPath,
  });
}

// Async entry point for application code that supports both platform backends.
// SQLite keeps the existing synchronous facade for compatibility; MySQL always
// returns the initialized Knex-backed store and never exposes a SQLite handle.
export async function createPlatformDatabaseAsync(config = {}) {
  return initializePlatformDatabase(config);
}

export { createKnexPlatformStore };

export async function initializePlatformDatabase(
  config = {},
  { mysqlStoreFactory = createMysqlPlatformStore } = {},
) {
  const normalized = normalizePlatformDatabaseConfig(config);
  if (normalized.backend === 'sqlite') {
    const database = createPlatformDatabase(normalized);
    return { backend: 'sqlite', database, close: () => database.closeAsync() };
  }

  const store = mysqlStoreFactory(normalized);
  try {
    await store.connect();
    const statementCount = normalized.mysql?.initialize === false
      ? 0
      : await store.initialize(normalized.initSqlPath);
    const database = attachAsyncRepositories(store);
    await seedMysqlPlatformDefaults(database);
    return {
      backend: 'mysql',
      database,
      statementCount,
      close: () => store.close(),
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}
