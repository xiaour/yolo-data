import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApplication } from '../src/application.js';
import { createAgentApplication } from './fixtures/agentDataset.js';
import { assertGateCoverage, getGate, summarizeGateIssues } from '../src/gateRegistry.js';
import { STAGE_DEFINITIONS } from '../src/workflow.js';
import { describeIndicatorSource } from '../src/indicatorSource.js';
import { reviewGeneratedCode, validateCode } from '../src/codeExecution.js';
import { CONTRACT_COMPILER_VERSION } from '../src/contractVersion.js';
import { buildQueryContract } from '../src/queryContract.js';
import { getCounter, resetMetrics } from '../src/metrics.js';
import { createTraceId } from '../src/trace.js';

function testConfig() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-capability-'));
  return {
    projectRoot: process.cwd(),
    port: 0,
    dbPath: path.join(directory, 'test.db'),
    deepseek: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      timeoutMs: 5_000,
      maxToolRounds: 3,
    },
    chatMemoryMessageLimit: 20,
    datasourceSecretKey: '',
    datasourceSecretKeyPath: path.join(directory, '.credential-key'),
    bootstrapDatasource: { enabled: false },
  };
}

test('P0-7 every workflow stage owns a gate and coverage self-check is enforced', () => {
  const stageCodes = STAGE_DEFINITIONS.map((stage) => stage.code);
  assert.doesNotThrow(() => assertGateCoverage(stageCodes));
  assert.throws(
    () => assertGateCoverage([...stageCodes, 'BRAND_NEW_STAGE']),
    /BRAND_NEW_STAGE/,
  );
  // The two gates the architecture review missed.
  assert.equal(getGate('SEMANTIC-003').phase, 'SEMANTIC_RESOLVE');
  assert.equal(getGate('RESULT-002').phase, 'RESULT_ANALYST');
  // The two explicitly requested gates.
  assert.equal(getGate('CODE-001').blocking, true);
  assert.equal(getGate('SOURCE-002').blocking, true);
});

test('P0-7 gate blocks are counted per gateId/phase/blocking', () => {
  resetMetrics();
  summarizeGateIssues([
    { level: 'ERROR', code: 'FILTER_THRESHOLD_NOT_BOUND', message: 'x' },
    { level: 'WARN', code: 'RESULT_TRUNCATED', message: 'y' },
  ]);
  assert.equal(
    getCounter('gate_block_total', {
      gateId: 'CONTRACT-006',
      phase: 'PLAN',
      blocking: 'true',
    }),
    1,
  );
});

test('P0-7 frozen contracts carry the compiler version', () => {
  const contract = buildQueryContract({ indicatorId: '2', metrics: ['sale_amt'] });
  assert.equal(contract.compilerVersion, CONTRACT_COMPILER_VERSION);
});

test('P0-1 indicator source is explicitly classified', () => {
  assert.equal(describeIndicatorSource({ local: true }).source, 'LOCAL');
  assert.equal(
    describeIndicatorSource({ live: { available: true }, snapshot: { count: 5 } }).source,
    'LIVE',
  );
  assert.deepEqual(
    describeIndicatorSource({ live: { available: false }, snapshot: { count: 3, freshAt: 'T' } }),
    { source: 'SNAPSHOT', freshAt: 'T', snapshotCount: 3 },
  );
  assert.equal(
    describeIndicatorSource({ live: { available: false }, snapshot: { count: 0 } }).source,
    'UNAVAILABLE',
  );
});

test('P0-1 startup preserves the persisted local indicator catalog', async () => {
  const config = testConfig();
  let application = await createApplication(config);
  try {
    await application.init();
    assert.equal(await application.database.localIndicators.countAsync(), 0);
    const indicator = await application.database.localIndicators.save({
      name: '销售额', bizName: 'sales_amount', businessCaliber: '已完成订单的金额合计',
    });
    await application.database.closeAsync();
    application = await createApplication(config);
    await application.init();
    assert.equal(await application.database.localIndicators.countAsync(), 1);
    assert.deepEqual(await application.database.localIndicators.getAsync(indicator.id), indicator);
    await application.init();
    assert.deepEqual(await application.database.localIndicators.getAsync(indicator.id), indicator);
    const health = await application.currentHealth();
    assert.equal(health.source.indicatorSource, 'LOCAL');
    assert.equal(health.source.localIndicatorCount, 1);
  } finally {
    await application.database.closeAsync();
  }
});

test('P0-1 local catalog serves metadata without fabricating query results', async () => {
  const application = await createApplication(testConfig());
  try {
    await application.init();
    const indicator = await application.database.localIndicators.save({
      name: '销售额', bizName: 'sales_amount', typeId: 'sales', typeName: '经营指标',
    });
    const read = await application.indicatorService.listCatalog({ keyword: '销售' });
    assert.deepEqual(read.list, [indicator]);
    assert.equal(read.total, 1);
    assert.deepEqual(await application.indicatorService.getIndicator(indicator.id), indicator);
    assert.equal((await application.indicatorService.listTypes())[0].id, 'sales');
    await assert.rejects(application.indicatorService.queryIndicator({ indicatorId: indicator.id }),
      (error) => error.code === 'LOCAL_INDICATOR_QUERY_UNSUPPORTED');
    assert.deepEqual(await application.indicatorService.queryIndicatorPresentationEvidence({ indicatorId: indicator.id }),
      { columns: [], rows: [] });
  } finally {
    await application.database.closeAsync();
  }
});

test('P0-4 traceId threads through plan, audit and emitted events', async () => {
  const application = await createAgentApplication(testConfig());
  try {
    await application.init();
    const user = application.database.getUserByUsername('east_manager');
    const theme = application.database.listThemes().find((item) => item.name === '经营总览');
    const traceId = createTraceId();
    const events = [];
    const answer = await application.agent.answer({
      userId: user.id,
      themeId: theme.id,
      question: '近7天华东销售额趋势',
      traceId,
      onEvent: (event) => events.push(event),
    });
    assert.equal(answer.traceId, traceId);
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.traceId === traceId));
    const evidence = application.database.getTraceEvidence(traceId);
    assert.ok(evidence.counts.queryPlans >= 1);
    assert.ok(evidence.counts.audit >= 1);
    assert.ok(evidence.queryPlans.every((plan) => plan.compilerVersion));
  } finally {
    await application.database.closeAsync();
  }
});

test('CODE-001 generated code cannot hold datasource access', () => {
  const blocked = reviewGeneratedCode("import pymysql\npymysql.connect(host='db')");
  assert.equal(blocked.valid, false);
  assert.equal(blocked.issues[0].code, 'CODE_DATASOURCE_ACCESS_FORBIDDEN');
  assert.equal(reviewGeneratedCode("import pandas as pd\nprint('ok')").valid, true);
  assert.throws(
    () => validateCode('import sqlite3'),
    (error) => error.gateId === 'CODE-001'
      && error.code === 'CODE_DATASOURCE_ACCESS_FORBIDDEN',
  );
  assert.throws(
    () => validateCode("conn = 'mysql://user:pass@host/db'"),
    /blocked/,
  );
});
