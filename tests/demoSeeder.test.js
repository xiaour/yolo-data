import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemoSales, DEMO_DATASET_CODE } from '../src/demo/demoSeeder.js';

// 用一个记录 SQL 的假连接池 + 最小平台库桩，验证「建表 → 分批灌数 → 注册数据集」的编排。
function createHarness({ tableExists = false, existingRows = 500, existingDataset = null } = {}) {
  const executed = [];
  const source = {
    id: 7,
    code: 'platform_mysql',
    name: '平台 MySQL 数据源',
    dbType: 'MYSQL',
    databaseName: 'yolo_data',
  };
  const pool = {
    query: async (input) => {
      const sql = typeof input === 'string' ? input : input.sql;
      if (/^SELECT COUNT\(\*\)/.test(sql.trim())) {
        if (!tableExists) throw new Error("Table 'ads_sale_detail' doesn't exist");
        return [[{ rowCount: existingRows }], []];
      }
      executed.push(sql);
      return [{ affectedRows: 1 }, []];
    },
    end: async () => {},
  };
  const created = [];
  const saved = [];
  const synced = [];
  const businessDatasets = {
    getDataSourceByCodeAsync: async (code) => (code === source.code ? source : null),
    saveDataSourceAsync: async (payload) => ({ id: 99, ...payload }),
    createPool: () => pool,
    createDataset: async (payload) => {
      created.push(payload);
      return { id: 11, ...payload };
    },
    syncDatasetFields: async (id) => { synced.push(id); return []; },
    getDatasetAsync: async (id) => existingDataset ?? ({ id, code: DEMO_DATASET_CODE }),
  };
  const database = {
    listBusinessDatasetsAsync: async () => existingDataset ? [existingDataset] : [],
    saveBusinessDatasetAsync: async (payload, id) => {
      saved.push({ payload, id });
      return { id, ...payload };
    },
  };
  return { executed, businessDatasets, database, created, saved, synced, source };
}

const silentLogger = { log() {}, warn() {} };

test('演示数据落库：表不存在时建表并分批灌数', async () => {
  const harness = createHarness();
  const result = await seedDemoSales({
    demo: {
      enabled: true,
      loadData: true,
      rows: 500,
      datasourceCode: 'platform_mysql',
      schemaName: 'yolo_data',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
    },
    businessDatasets: harness.businessDatasets,
    database: harness.database,
    logger: silentLogger,
  });

  assert.equal(result.ok, true);
  assert.equal(result.inserted, 500);
  assert.equal(harness.created.length, 1);
  assert.equal(harness.created[0].code, DEMO_DATASET_CODE);
  assert.equal(harness.created[0].schemaName, 'yolo_data');
  assert.equal(harness.created[0].primaryTable, 'ads_sale_detail');

  const ddl = harness.executed.filter((sql) => sql.startsWith('CREATE TABLE'));
  const inserts = harness.executed.filter((sql) => sql.startsWith('INSERT INTO'));
  assert.equal(ddl.length, 1, '只应建一次表');
  assert.match(ddl[0], /ENGINE=InnoDB/);
  assert.equal(inserts.length, 3, '500 行按每批 200 行应切成 3 条 INSERT');
});

test('演示数据落库：表已有数据时不重复灌数', async () => {
  const harness = createHarness({ tableExists: true });
  const result = await seedDemoSales({
    demo: { enabled: true, rows: 500, datasourceCode: 'platform_mysql', schemaName: 'yolo_data' },
    businessDatasets: harness.businessDatasets,
    database: harness.database,
    logger: silentLogger,
  });
  assert.equal(result.ok, true);
  assert.equal(result.inserted, 0);
  const writes = harness.executed.filter((sql) => /^(CREATE TABLE|INSERT INTO)/.test(sql));
  assert.deepEqual(writes, [], '已有表时不应再建表或写数据');
});

test('演示数据落库：数据源缺失时跳过而不是抛错', async () => {
  const harness = createHarness();
  const result = await seedDemoSales({
    demo: { enabled: true, datasourceCode: 'not_exists' },
    businessDatasets: harness.businessDatasets,
    database: harness.database,
    logger: silentLogger,
  });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /not_exists/);
});

test('演示数据落库：DEMO_DATA_LOAD=false 时只注册数据集', async () => {
  const harness = createHarness();
  const result = await seedDemoSales({
    demo: {
      enabled: true,
      loadData: false,
      datasourceCode: 'platform_mysql',
      schemaName: 'yolo_data',
    },
    businessDatasets: harness.businessDatasets,
    database: harness.database,
    logger: silentLogger,
  });
  assert.equal(result.ok, true);
  assert.equal(harness.created.length, 1);
  assert.deepEqual(harness.executed, [], '不应执行任何建表/写入语句');
});

test('演示数据落库：已有数据集配置和字段不会在启动时被覆盖', async () => {
  const existingDataset = {
    id: 11,
    code: DEMO_DATASET_CODE,
    name: '管理员自定义名称',
    status: 0,
    config: { maxRows: 77, requireDateRange: true },
  };
  const harness = createHarness({ existingDataset });
  const result = await seedDemoSales({
    demo: { enabled: true, loadData: false, datasourceCode: 'platform_mysql', schemaName: 'yolo_data' },
    businessDatasets: harness.businessDatasets,
    database: harness.database,
    logger: silentLogger,
  });

  assert.equal(result.dataset.name, '管理员自定义名称');
  assert.deepEqual(result.dataset.config, { maxRows: 77, requireDateRange: true });
  assert.deepEqual(harness.created, []);
  assert.deepEqual(harness.saved, []);
  assert.deepEqual(harness.synced, []);
});
