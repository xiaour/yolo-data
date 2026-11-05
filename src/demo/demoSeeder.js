// 演示数据落库：建表（若不存在）→ 灌入演示行 → 注册数据源/数据集 → 同步字段语义。
// 只在 DEMO_DATA_ENABLED=true 时被调用；每一步都幂等，重复启动不会重复灌数。
// 失败不阻断启动：由调用方兜住异常，只在日志里留痕。
// 业务词（数据集名、来源名、维度取值）一律放在 config/demo/ 下，src/ 不放业务词表。

import fs from 'node:fs';
import { buildCreateTableSql, buildInsertStatements, loadDemoSchema } from './demoSql.js';
import { generateSalesRows } from '../../config/demo/salesDemoData.mjs';

const META_URL = new URL('../../config/demo/demo.json', import.meta.url);

function loadDemoMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_URL, 'utf8'));
  } catch {
    return {};
  }
}

const DEMO_META = loadDemoMeta();
export const DEMO_DATASET_CODE = DEMO_META.datasetCode ?? 'ads_sale_detail_demo';
export const DEMO_SOURCE_CODE = DEMO_META.sourceCode ?? 'demo_sales_source';

async function findSource(businessDatasets, code) {
  if (!code) return null;
  try {
    return await businessDatasets.getDataSourceByCodeAsync(code);
  } catch {
    return null;
  }
}

async function resolveSource(demo, businessDatasets) {
  const preferred = String(demo.datasourceCode ?? '').trim();
  if (preferred) {
    const existing = await findSource(businessDatasets, preferred);
    if (existing) return { source: existing, reason: '' };
    if (!demo.host) {
      return {
        source: null,
        reason: `找不到数据源 ${preferred}：平台库不是 MySQL 后端时不会自动创建该数据源，`
          + '请改用 DEMO_DB_* 指定演示库，或把 PLATFORM_DB_BACKEND 设为 mysql。',
      };
    }
  }
  const existing = await findSource(businessDatasets, DEMO_SOURCE_CODE);
  if (existing) {
    return { source: existing, reason: '' };
  }
  const source = await businessDatasets.saveDataSourceAsync({
    code: DEMO_SOURCE_CODE,
    name: String(demo.sourceName ?? DEMO_META.sourceName ?? '演示库').trim(),
    dbType: demo.dbType ?? 'MYSQL',
    host: demo.host,
    port: demo.port,
    databaseName: demo.schemaName,
    username: demo.username,
    password: demo.password ?? '',
    options: { readonly: false, maxRows: 5000, queryTimeoutMs: 30_000 },
    status: 1,
  });
  return { source, reason: '' };
}

async function ensureTable(pool, schema, dbType) {
  const [countRows] = await pool.query({
    sql: `SELECT COUNT(*) AS rowCount FROM \`${schema.table}\``,
    timeout: 20_000,
  }).catch(() => [null]);
  const rowCount = Number(countRows?.[0]?.rowCount ?? countRows?.[0]?.ROW_COUNT ?? NaN);
  if (Number.isFinite(rowCount)) {
    return { exists: true, rowCount };
  }
  await pool.query(buildCreateTableSql(schema, { dbType }));
  return { exists: false, rowCount: 0 };
}

/**
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, dataset?:object,
 *   inserted?:number, rowCount?:number}>}
 */
export async function seedDemoSales({
  demo = {},
  businessDatasets,
  database,
  logger = console,
} = {}) {
  const schema = loadDemoSchema();
  const dbType = String(demo.dbType ?? 'MYSQL').toUpperCase();
  const resolved = await resolveSource(demo, businessDatasets);
  if (!resolved.source) {
    return { ok: false, skipped: true, reason: resolved.reason };
  }
  const source = resolved.source;
  const schemaName = String(demo.schemaName ?? source.databaseName ?? '').trim();
  if (!schemaName) {
    return { ok: false, skipped: true, reason: '演示数据缺少库名（schemaName）' };
  }

  if (demo.loadData === false) {
    logger.log?.('[demo] DEMO_DATA_LOAD=false，只注册数据集，不写入演示行');
  }

  let inserted = 0;
  let rowCount = 0;
  if (demo.loadData !== false) {
    const pool = businessDatasets.createPool(source);
    try {
      const table = await ensureTable(pool, schema, dbType);
      rowCount = table.rowCount;
      const target = Math.max(1, Number(demo.rows) || 5000);
      if (rowCount === 0) {
        const rows = generateSalesRows({
          rows: target,
          startDate: demo.startDate,
          endDate: demo.endDate,
          seed: demo.seed,
        });
        const statements = buildInsertStatements(schema, rows, { dbType, batchSize: 200 });
        for (const statement of statements) {
          await pool.query({ sql: statement, timeout: 60_000 });
        }
        inserted = rows.length;
        rowCount = rows.length;
        logger.log?.(`[demo] 已写入 ${inserted} 行演示数据到 ${schemaName}.${schema.table}`);
      } else if (rowCount < target && demo.appendToExisting !== true) {
        logger.log?.(`[demo] ${schemaName}.${schema.table} 已有 ${rowCount} 行，跳过灌数（如需补齐请手工执行 npm run demo:export）`);
      }
    } finally {
      await pool.end?.().catch(() => {});
    }
  }

  const datasets = await database.listBusinessDatasetsAsync({ includeDisabled: true });
  let dataset = datasets.find((item) => item.code === DEMO_DATASET_CODE);
  const config = {
    readonly: true,
    maxRows: 5000,
    queryTimeoutMs: 30_000,
    requireDateRange: false,
    autoLatestDateRange: true,
    autoRangeDays: 30,
  };
  if (!dataset) {
    dataset = await businessDatasets.createDataset({
      code: DEMO_DATASET_CODE,
      name: String(demo.datasetName ?? DEMO_META.datasetName ?? '演示数据集').trim(),
      description: String(demo.datasetDescription ?? DEMO_META.datasetDescription ?? '').trim(),
      datasourceId: source.id,
      schemaName,
      primaryTable: schema.table,
      config,
      status: 1,
    });
  } else {
    // Bootstrap is create-only: an administrator may have changed the dataset,
    // field semantics or status after the first start. Reuse it verbatim.
    dataset = await businessDatasets.getDatasetAsync(dataset.id) ?? dataset;
  }
  return { ok: true, dataset, inserted, rowCount };
}

export default seedDemoSales;
