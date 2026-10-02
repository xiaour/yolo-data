import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApplication } from '../src/application.js';
import { FakeIndicatorClient } from './fixtures/fakeIndicatorClient.js';
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
    supersonic: { baseUrl: '', token: '', timeoutMs: 5_000 },
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

test('P0-1 startup neither clears nor writes the indicator catalog', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  const calls = [];
  const originalClear = application.database.clearIndicatorCatalog.bind(application.database);
  application.database.clearIndicatorCatalog = (...args) => {
    calls.push('clearIndicatorCatalog');
    return originalClear(...args);
  };
  const originalSync = application.database.syncIndicators.bind(application.database);
  application.database.syncIndicators = (...args) => {
    calls.push('syncIndicators');
    return originalSync(...args);
  };
  try {
    await application.init();
    assert.deepEqual(calls, []);
    assert.equal(application.database.indicatorCacheStats().count, 0);
    const health = application.currentHealth();
    assert.ok(['LIVE', 'SNAPSHOT', 'UNAVAILABLE'].includes(health.source.indicatorSource));
    assert.equal(health.source.indicatorSource, 'LIVE');
  } finally {
    application.database.close();
  }
});

test('P0-1 explicit sync persists a snapshot and snapshot reads are marked', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  try {
    await application.init();
    const result = await application.syncIndicators({ persist: true });
    assert.equal(result.persisted, true);
    assert.ok(application.database.indicatorCacheStats().count > 0);
    const read = application.database.listIndicators({ limit: 5 });
    assert.equal(read.source, 'SNAPSHOT');
    assert.ok(read.freshAt);
    const options = application.database.listDatasetOptions();
    assert.equal(options.source, 'SNAPSHOT');
  } finally {
    application.database.close();
  }
});

test('P0-4 traceId threads through plan, audit and emitted events', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
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
    application.database.close();
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
