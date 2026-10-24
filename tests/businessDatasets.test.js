import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApplication } from '../src/application.js';
import { DatasourceCrypto } from '../src/datasourceCrypto.js';

function testConfig() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-business-'));
  return {
    projectRoot: process.cwd(),
    port: 0,
    dbPath: path.join(directory, 'test.db'),
    datasourceSecretKeyPath: path.join(directory, '.key'),
    deepseek: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      timeoutMs: 5_000,
      maxToolRounds: 3,
    },
    chatMemoryMessageLimit: 20,
    bootstrapDatasource: { enabled: false },
  };
}

function createBusinessDataset(application, user, { attachToTheme = true, dbType = 'DORIS' } = {}) {
  const crypto = new DatasourceCrypto({
    keyFilePath: path.join(path.dirname(application.config.dbPath), '.key'),
  });
  const source = application.database.saveDataSource({
    code: 'test_doris',
    name: '测试 Doris',
    dbType,
    host: 'localhost',
    port: 9030,
    databaseName: 'dev',
    username: 'root',
    encryptedPassword: crypto.encrypt('secret'),
    options: { readonly: true },
  });
  const dataset = application.database.saveBusinessDataset({
    code: 'sales_performance',
    name: '销售经营分析',
    description: '测试销售数据集',
    datasourceId: source.id,
    schemaName: 'dev',
    primaryTable: 'ads_sales',
    config: {
      policyFieldMap: { region: 'performance_region_name' },
      policyValueMap: {
        performance_region_name: { 华东: '华东大区' },
      },
    },
  });
  application.database.replaceDatasetFields(dataset.id, [
    {
      fieldName: 'sales_date',
      displayName: '销售日期',
      dataType: 'date',
      semanticType: 'DATE',
      role: 'TIME',
      aggregator: 'NONE',
      allowedOperators: ['BETWEEN'],
    },
    {
      fieldName: 'performance_region_name',
      displayName: '销售大区',
      dataType: 'varchar',
      semanticType: 'STRING',
      role: 'DIMENSION',
      aggregator: 'NONE',
      allowedOperators: ['IN', 'LIKE'],
    },
    {
      fieldName: 'order_code',
      displayName: '销售单号',
      dataType: 'varchar',
      semanticType: 'STRING',
      role: 'IDENTIFIER',
      aggregator: 'NONE',
      allowedOperators: ['=', 'LIKE'],
    },
    {
      fieldName: 'sale_amt',
      displayName: '销售额',
      dataType: 'decimal',
      semanticType: 'NUMBER',
      role: 'METRIC',
      aggregator: 'SUM',
      allowedOperators: ['>', 'BETWEEN'],
    },
  ]);
  application.database.grantDatasetAccess(user.id, dataset.id, true);
  if (attachToTheme) {
    const theme = application.database.listThemes().find((item) => item.name === '经营总览');
    application.database.saveTheme({
      ...theme,
      businessDatasetIds: [dataset.id],
    }, theme.id);
  }
  return dataset;
}

test('business dataset query is compiled from semantic fields without raw SQL', async () => {
  const application = await createApplication(testConfig());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const dataset = createBusinessDataset(application, user);
  const fields = application.database.listDatasetFields(dataset.id, { enabledOnly: true });
  const compiled = application.businessDatasets.buildQuery(dataset.id, {
    metrics: [{ field: 'sale_amt', aggregator: 'SUM' }],
    dimensions: ['performance_region_name'],
    filters: [{ field: 'performance_region_name', operator: 'IN', value: ['华东大区'] }],
    limit: 50,
  });
  assert.match(compiled.sql, /SUM\(`sale_amt`\)/);
  assert.match(compiled.sql, /GROUP BY `performance_region_name`/);
  assert.equal(fields.length, 4);
  assert.equal('rawSql' in compiled, false);
});

test('business dataset query groups time dimensions at the requested grain', async () => {
  const application = await createApplication(testConfig());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const dataset = createBusinessDataset(application, user);
  const fields = application.database.listDatasetFields(dataset.id, {
    enabledOnly: true,
  });
  application.database.replaceDatasetFields(dataset.id, [
    ...fields,
    {
      fieldName: 'sale_time',
      displayName: '销售时间',
      dataType: 'datetime',
      semanticType: 'DATE',
      role: 'TIME',
      aggregator: 'NONE',
      allowedOperators: ['BETWEEN'],
    },
  ]);
  const compiled = application.businessDatasets.buildQuery(dataset.id, {
    metrics: [{ field: 'sale_amt', aggregator: 'SUM' }],
    dimensions: ['sales_date'],
    timeGrain: 'MONTH',
    dateRange: {
      field: 'sales_date',
      startDate: '2026-01-01',
      endDate: '2026-09-22',
    },
    order: [{ field: 'sale_time', direction: 'ASC' }],
    limit: 12,
  });

  assert.match(
    compiled.sql,
    /DATE_FORMAT\(`sales_date`, '%Y-%m'\) AS `sales_date`/,
  );
  assert.match(
    compiled.sql,
    /GROUP BY DATE_FORMAT\(`sales_date`, '%Y-%m'\)/,
  );
  assert.match(
    compiled.sql,
    /ORDER BY DATE_FORMAT\(`sales_date`, '%Y-%m'\) ASC/,
  );
  assert.equal(compiled.timeGrain, 'MONTH');
});

test('business dataset query orders grouped metrics by their output alias', async () => {
  const application = await createApplication(testConfig());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const dataset = createBusinessDataset(application, user);
  const compiled = application.businessDatasets.buildQuery(dataset.id, {
    metrics: [{
      field: 'sale_amt',
      aggregator: 'SUM',
      outputField: 'sale_amt_sum',
    }],
    dimensions: ['performance_region_name'],
    order: [{ field: 'sale_amt', direction: 'DESC' }],
    limit: 200,
  });

  assert.match(compiled.sql, /SUM\(`sale_amt`\) AS `sale_amt_sum`/);
  assert.match(compiled.sql, /ORDER BY `sale_amt_sum` DESC/);
  assert.doesNotMatch(compiled.sql, /ORDER BY `sale_amt` DESC/);
});

test('business dataset query separates row filters from aggregate filters', async () => {
  const application = await createApplication(testConfig());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const dataset = createBusinessDataset(application, user);
  const compiled = application.businessDatasets.buildQuery(dataset.id, {
    metrics: [{ field: 'sale_amt', aggregator: 'SUM' }],
    dimensions: ['performance_region_name'],
    filters: [
      {
        field: 'performance_region_name',
        operator: 'LIKE',
        value: '华东',
        sourceText: '名称包含华东',
        scope: 'ROW',
      },
      {
        field: 'sale_amt',
        operator: '>',
        value: 500000,
        sourceText: '销售额不低于50万',
        scope: 'AGGREGATE',
      },
    ],
    limit: 50,
  });

  assert.match(compiled.sql, /`performance_region_name` LIKE \?/);
  assert.match(compiled.sql, /HAVING SUM\(`sale_amt`\) > \?/);
  assert.ok(compiled.values.includes('%华东%'));
  assert.ok(compiled.values.includes(500000));
});

test('business dataset query renders scoped metrics with per-metric conditional filters', async () => {
  const application = await createApplication(testConfig());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const dataset = createBusinessDataset(application, user);
  const compiled = application.businessDatasets.buildQuery(dataset.id, {
    metrics: [
      {
        field: 'sale_amt',
        aggregator: 'SUM',
        outputField: 'oem_sale_amt',
        predicateFilters: [{
          field: 'performance_region_name',
          operator: 'LIKE',
          value: 'OEM',
          sourceText: 'OEM',
        }],
      },
      {
        field: 'sale_amt',
        aggregator: 'SUM',
        outputField: 'total_sale_amt',
      },
    ],
    limit: 50,
  });

  assert.match(
    compiled.sql,
    /SUM\(CASE WHEN `performance_region_name` LIKE \? THEN `sale_amt` ELSE 0 END\) AS `oem_sale_amt`/,
  );
  assert.match(
    compiled.sql,
    /SUM\(`sale_amt`\) AS `total_sale_amt`/,
  );
  assert.ok(compiled.values.includes('%OEM%'));
});

test('business dataset can load distinct values for enum-like fields', async () => {
  const application = await createApplication(testConfig());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const dataset = createBusinessDataset(application, user);
  let captured = null;
  application.businessDatasets.getPoolById = () => ({
    query: async (request) => {
      captured = request;
      return [[
        { value: '华东大区' },
        { value: '华南大区' },
        { value: '华东大区' },
      ], []];
    },
  });

  const values = await application.businessDatasets.listDistinctFieldValues(
    dataset.id,
    'performance_region_name',
    { limit: 50 },
  );
  assert.deepEqual(values, ['华东大区', '华南大区']);
  assert.match(captured.sql, /SELECT DISTINCT `performance_region_name`/);
  assert.equal(captured.values[0], 50);
});

test('semantic value preview follows draft dataset selection without saving it', async () => {
  const application = await createApplication(testConfig());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const dataset = createBusinessDataset(application, user, { attachToTheme: false });
  application.database.replaceDatasetFields(dataset.id, [
    {
      fieldName: 'business_type_name',
      displayName: '业务分类',
      dataType: 'varchar',
      semanticType: 'STRING',
      role: 'DIMENSION',
      aggregator: 'NONE',
      allowedOperators: ['IN'],
    },
  ]);
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  const before = application.database.getTheme(theme.id).businessDatasetIds;

  const preview = await application.agent.listSemanticValueFields(theme.id, {
    indicatorIds: theme.indicatorIds,
    businessDatasetIds: [dataset.id],
    semanticValueConfig: {
      enabled: true,
      autoDiscover: true,
      fields: {},
    },
    systemPrompt: '业务分类枚举：Standard、Alpha',
  });

  assert.ok(preview.fields.some(
    (field) => field.key === `DATASET:${dataset.id}:business_type_name`,
  ));
  assert.deepEqual(
    application.database.getTheme(theme.id).businessDatasetIds,
    before,
  );
});

test('agent rejects indicator execution when the theme has a business dataset', async () => {
  const application = await createApplication(testConfig());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const dataset = createBusinessDataset(application, user);
  let blockedError = null;
  let exposedTools = [];
  application.agent.harnessFactory = {
    forTheme: () => ({
      mode: 'test-agent',
      model: 'test-model',
      capabilities: {},
      run: async ({ executeTool, tools }) => {
        exposedTools = tools.map((tool) => tool.function?.name);
        try {
          await executeTool('compile_query_contract', {
            sourceType: 'INDICATOR',
            indicatorId: '2',
            conditions: [{
              id: 'metric',
              sourceText: '销售额',
              kind: 'METRIC',
              status: 'RESOLVED',
            }],
            metricFields: [{
              field: 'sale_amt',
              sourceText: '销售额',
            }],
          });
        } catch (error) {
          blockedError = error;
        }
        return {
          content: blockedError?.message ?? 'unexpected success',
          trace: [],
        };
      },
    }),
  };

  const answer = await application.agent.answer({
    userId: user.id,
    themeId: application.database.listThemes()
      .find((item) => item.name === '经营总览').id,
    question: '本月销售额是多少',
  });

  assert.equal(blockedError?.code, 'LOCAL_INDICATOR_QUERY_UNSUPPORTED');
  assert.equal(blockedError?.terminal, undefined);
  assert.equal(blockedError?.recoverable, true);
  assert.equal(exposedTools.includes('query_indicator'), false);
  assert.equal(answer.message, blockedError.message);
  assert.equal(dataset.id, application.database.getTheme(
    application.database.listThemes().find((item) => item.name === '经营总览').id,
  ).businessDatasetIds[0]);
});

for (const dbType of ['DORIS', 'MYSQL', 'TIDB', 'POSTGRESQL']) {
test(`agent routes and labels the authorized ${dbType} dataset executor`, async () => {
  const application = await createApplication(testConfig());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const dataset = createBusinessDataset(application, user, { dbType });
  application.businessDatasets.executeQuery = async ({ request }) => ({
    columns: [
      { name: 'performance_region_name', bizName: 'performance_region_name', showType: 'CATEGORY' },
      { name: 'sale_amt', bizName: 'sale_amt', showType: 'NUMBER' },
    ],
    rows: [{ performance_region_name: '华东大区', sale_amt: 123456 }],
    sql: 'SELECT performance_region_name, SUM(sale_amt) FROM dev.ads_sales GROUP BY performance_region_name',
    dataset,
    dimensions: request.dimensions,
    metrics: request.metrics,
    filters: request.filters,
    latencyMs: 12,
  });
  const events = [];
  const answer = await application.agent.answer({
    userId: user.id,
    themeId: application.database.listThemes().find((item) => item.name === '经营总览').id,
    question: '最近30天各大区销售额明细',
    onEvent: (event) => events.push(event),
  });
  assert.equal(answer.dataset.code, 'sales_performance');
  const adapter = `${dbType.toLowerCase()}-dataset`;
  assert.equal(answer.semanticParse.execution.adapter, adapter);
  assert.equal(answer.runtime.executionAdapter, adapter);
  assert.equal(events.find((event) => event.type === 'execution_selected').source.mode, adapter);
  const executionStage = answer.workflow.stages.find((stage) => stage.code === 'EXECUTE');
  assert.ok(executionStage.evidence.some((item) => item.adapter === adapter));
  const artifact = application.workspace.getArtifact({
    artifactId: answer.executionResults[0].artifactId, userId: user.id,
  });
  assert.equal(artifact.metadata.source.adapter, adapter);
  assert.equal(application.database.getQueryPlan(answer.semanticParse.planId, user.id).evidence.execution.adapter, adapter);
  assert.equal(answer.workflow.status, 'COMPLETED');
  assert.deepEqual(
    answer.workflow.stages
      .filter((stage) => ['SEMANTIC_DISCOVERY', 'SEMANTIC_CONFIRM', 'EXECUTE'].includes(stage.code))
      .map((stage) => stage.status),
    ['SUCCESS', 'SUCCESS', 'SUCCESS'],
  );
  assert.equal(answer.data.rows.length, 1);
  assert.deepEqual(
    answer.semanticParse.filters[0].value,
    ['华东大区'],
  );
  application.database.saveBusinessDataset({ ...dataset, status: 0 }, dataset.id);
  const restyled = await application.agent.answer({
    userId: user.id, sessionId: answer.sessionId, question: '换成柱状图展示',
  });
  assert.equal(restyled.executionResults[0].kind, 'chart_restyle');
  assert.equal(restyled.executionResults[0].artifactId, artifact.id);
  assert.equal(restyled.semanticParse.execution.adapter, adapter);
  assert.equal(restyled.runtime.executionAdapter, adapter);
  application.database.saveBusinessDataset({ ...dataset, status: 1 }, dataset.id);
  const source = application.database.getDataSource(dataset.datasourceId);
  application.database.saveDataSource({ ...source, dbType: dbType === 'DORIS' ? 'MYSQL' : 'DORIS' }, source.id);
  const afterSourceEdit = await application.agent.answer({
    userId: user.id, sessionId: answer.sessionId, question: '换成折线图展示',
  });
  assert.equal(afterSourceEdit.executionResults[0].artifactId, artifact.id);
  assert.equal(afterSourceEdit.runtime.executionAdapter, adapter);
  assert.equal(afterSourceEdit.dataset.id, answer.dataset.id);
  application.database.saveDataSource(source, source.id);
  application.businessDatasets.executeQuery = async () => { throw new Error('execution label fixture failure'); };
  const failures = [];
  const recordGap = application.growth.record.bind(application.growth);
  application.growth.record = (gap) => { failures.push(gap); return recordGap(gap); };
  await application.agent.answer({
    userId: user.id, themeId: answer.theme.id, question: '最近60天各大区销售额明细',
  }).catch((error) => assert.match(error.message, /execution label fixture failure/));
  assert.ok(failures.some((gap) => gap.kind === 'DATASET_EXECUTION' && gap.source === `${dbType}_DATASET`));
  await application.businessDatasets.close();
  await application.database.closeAsync();
});
}

test('agent does not execute a guessed aggregate when the model only clarifies', async () => {
  const application = await createApplication(testConfig());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const dataset = createBusinessDataset(application, user);
  let capturedRequest = null;
  application.businessDatasets.executeQuery = async ({ request }) => {
    capturedRequest = request;
    return {
      columns: [
        { name: '销售大区名称', bizName: 'performance_region_name', showType: 'CATEGORY' },
        { name: '含税销售额', bizName: 'sale_amt', showType: 'NUMBER' },
      ],
      rows: [
        { performance_region_name: '华东大区', sale_amt: 12 },
        { performance_region_name: '华南大区', sale_amt: 9 },
      ],
      sql: 'SELECT performance_region_name, SUM(sale_amt) AS sale_amt FROM dev.ads_sales GROUP BY performance_region_name',
      dataset,
      dimensions: request.dimensions,
      metrics: request.metrics,
      filters: request.filters,
      latencyMs: 10,
    };
  };
  application.agent.harnessFactory = {
    forTheme: () => ({
      mode: 'test-agent',
      model: 'test-model',
      capabilities: {},
      run: async () => ({
        content: '请继续补充查询条件。',
        trace: [],
      }),
    }),
  };
  application.indicatorService.mode = 'unconfigured';

  const answer = await application.agent.answer({
    userId: user.id,
    themeId: application.database.listThemes().find(
      (item) => item.name === '经营总览',
    ).id,
    question: '本月销售大区含税销售额',
  });

  assert.equal(capturedRequest, null);
  assert.equal(answer.dataset, null);
  assert.equal(answer.data.rows.length, 0);
  assert.match(answer.message, /请继续补充查询条件/);
});

test('data source creation generates a readable unique code without user input', async () => {
  const application = await createApplication(testConfig());
  await application.init();
  const payload = {
    name: 'Doris 开发测试库',
    dbType: 'DORIS',
    host: 'localhost',
    port: 9030,
    databaseName: 'dev',
    username: 'root',
    password: 'secret',
  };
  const first = application.businessDatasets.saveDataSource({ ...payload });
  const second = application.businessDatasets.saveDataSource({ ...payload });
  assert.equal(first.code, 'doris');
  assert.equal(second.code, 'doris_2');
  assert.notEqual(first.encryptedPassword, 'secret');

  const renamed = application.businessDatasets.saveDataSource(
    { name: '重命名后的库', host: 'localhost', port: 9030, databaseName: 'dev', username: 'root' },
    first.id,
  );
  assert.equal(renamed.code, first.code);

  const fallback = application.businessDatasets.saveDataSource({
    ...payload,
    name: '销售生产库',
  });
  assert.match(fallback.code, /^ds_[a-z0-9]+$/);
});

test('aliased metric output columns keep metric semantics', async () => {
  const application = await createApplication(testConfig());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const dataset = createBusinessDataset(application, user, { attachToTheme: false });
  application.businessDatasets.getPoolById = () => ({
    query: async () => [
      [{ sales_date: '2026-10-06', amt_total: '10.500000' }],
      [
        { name: 'sales_date', type: 'STRING' },
        { name: 'amt_total', type: 246 },
      ],
    ],
  });

  const result = await application.businessDatasets.executeQuery({
    datasetId: dataset.id,
    request: {
      metrics: [{ field: 'sale_amt', aggregator: 'SUM', outputField: 'amt_total' }],
      dimensions: ['sales_date'],
      timeGrain: 'DAY',
      dateRange: {
        field: 'sales_date',
        startDate: '2026-10-01',
        endDate: '2026-10-07',
      },
    },
    userId: user.id,
  });

  const metric = result.columns.find((column) => column.bizName === 'amt_total');
  assert.equal(metric.showType, 'NUMBER');
  assert.equal(metric.role, 'METRIC');
  assert.equal(metric.semanticType, 'NUMBER');
  const timeColumn = result.columns.find((column) => column.bizName === 'sales_date');
  assert.equal(timeColumn.role, 'TIME');
});

test('business dataset execution probes one extra row without false truncation', async () => {
  const application = await createApplication(testConfig());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const dataset = createBusinessDataset(application, user, { attachToTheme: false });
  const requestedLimits = [];
  let nextRowCount = 10;
  application.businessDatasets.getPoolById = () => ({
    query: async ({ values = [] }) => {
      if (values.length === 0) {
        return [[{ maxDate: '2026-10-07' }], []];
      }
      const probe = Number(values.at(-1));
      requestedLimits.push(probe);
      const rowCount = nextRowCount;
      return [
        Array.from({ length: rowCount }, (_, index) => ({
          performance_region_name: `区域${index + 1}`,
          sale_amt: String(100 + index),
        })),
        [
          { name: 'performance_region_name', type: 'STRING' },
          { name: 'sale_amt', type: 246 },
        ],
      ];
    },
  });

  const exact = await application.businessDatasets.executeQuery({
    datasetId: dataset.id,
    request: {
      metrics: [{ field: 'sale_amt', aggregator: 'SUM' }],
      dimensions: ['performance_region_name'],
      limit: 10,
    },
    userId: user.id,
  });
  assert.equal(exact.limit, 10);
  assert.equal(exact.rows.length, 10);
  assert.equal(exact.truncated, false);

  nextRowCount = 11;
  const truncated = await application.businessDatasets.executeQuery({
    datasetId: dataset.id,
    request: {
      metrics: [{ field: 'sale_amt', aggregator: 'SUM' }],
      dimensions: ['performance_region_name'],
      limit: 10,
    },
    userId: user.id,
  });
  assert.equal(truncated.limit, 10);
  assert.equal(truncated.rows.length, 10);
  assert.equal(truncated.truncated, true);
  assert.deepEqual(requestedLimits, [11, 11]);
});
