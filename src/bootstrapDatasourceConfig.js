import { readInt } from './envValues.js';

// 内置演示/引导数据源的配置解析：Doris 引导数据源与 config/demo/* 演示数据。
// 从 loadConfig 拆出，保持配置装配主体的可读性。

export function resolveBootstrapDatasourceConfig(env = {}) {
  return {
    enabled: String(env.DORIS_BOOTSTRAP_ENABLED ?? '').toLowerCase() === 'true',
    host: String(env.DORIS_BOOTSTRAP_HOST ?? '').trim(),
    port: readInt(env.DORIS_BOOTSTRAP_PORT, 9030),
    username: String(env.DORIS_BOOTSTRAP_USER ?? '').trim(),
    password: String(env.DORIS_BOOTSTRAP_PASSWORD ?? ''),
    database: String(env.DORIS_BOOTSTRAP_DATABASE ?? '').trim(),
    salesTable: String(env.DORIS_BOOTSTRAP_SALES_TABLE ?? '').trim(),
    goodsTable: String(env.DORIS_BOOTSTRAP_GOODS_TABLE ?? '').trim(),
    // 内置演示数据（config/demo/*）：开启后启动即建表、灌演示行并注册数据集。
    demo: {
      enabled: String(env.DEMO_DATA_ENABLED ?? '').toLowerCase() === 'true',
      loadData: String(env.DEMO_DATA_LOAD ?? 'true').toLowerCase() !== 'false',
      appendToExisting: String(env.DEMO_DATA_APPEND ?? '').toLowerCase() === 'true',
      rows: readInt(env.DEMO_DATA_ROWS, 5000),
      seed: readInt(env.DEMO_DATA_SEED, 20261022),
      startDate: String(env.DEMO_DATA_START ?? '2024-11-01').trim(),
      endDate: String(env.DEMO_DATA_END ?? '2026-10-20').trim(),
      // 默认复用平台 MySQL 数据源（后端为 mysql 时由 ensurePlatformMysqlDatasource 自动创建）。
      datasourceCode: String(env.DEMO_DATA_DATASOURCE ?? 'platform_mysql').trim(),
      dbType: String(env.DEMO_DB_TYPE ?? 'MYSQL').trim().toUpperCase(),
      host: String(env.DEMO_DB_HOST ?? '').trim(),
      port: readInt(env.DEMO_DB_PORT, 3306),
      // Blank demo database means reuse the platform database. The config
      // file loader materializes blank values as empty strings, so use ||.
      schemaName: String(env.DEMO_DB_DATABASE || env.PLATFORM_DB_NAME || '').trim(),
      username: String(env.DEMO_DB_USER ?? '').trim(),
      password: String(env.DEMO_DB_PASSWORD ?? ''),
    },
  };
}
