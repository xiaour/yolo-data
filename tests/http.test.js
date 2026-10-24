import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildRouteTable, startServer } from '../src/server.js';
import { configureAgentDataset } from './fixtures/agentDataset.js';
import { createMiddlewareRegistry } from '../src/http/middleware.js';
import { createRouteTable, runRoute } from '../src/http/router.js';

function testConfig(directory, overrides = {}) {
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
    ...overrides,
  };
}

async function withServer(run, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-http-'));
  const { server, application } = await startServer(
    testConfig(directory, overrides),
  );
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run({ baseUrl, application });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await application.database.closeAsync();
  }
}

function sessionCookieOf(response) {
  const raw = response.headers.getSetCookie?.()[0] ?? '';
  return raw.split(';')[0];
}

test('P0-8 route table round-trips params and honours numeric constraints', () => {
  const table = createRouteTable();
  table.add({ id: 'a', method: 'GET', path: '/api/things/:id(\\d+)', handler: async () => {} });
  table.add({ id: 'b', method: 'GET', path: '/api/slugs/:slug', handler: async () => {} });

  assert.deepEqual(table.match('GET', '/api/things/42').params, ['42']);
  assert.equal(table.match('GET', '/api/things/abc'), null);
  assert.deepEqual(table.match('GET', '/api/slugs/hello%20world').params, ['hello world']);
  assert.equal(table.match('POST', '/api/things/42'), null);
  assert.equal(table.match('GET', '/api/things/42/nested'), null);
  assert.throws(
    () => table.add({ id: 'dup', method: 'GET', path: '/api/things/:id(\\d+)', handler: async () => {} }),
    /duplicate route/,
  );
});

test('P0-8 OpenAPI is generated from the route table and cannot drift', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/openapi.json`, {
      headers: { 'x-user-id': '1' },
    });
    assert.equal(response.status, 200);
    const doc = await response.json();
    assert.equal(doc.openapi, '3.1.0');

    const tablePaths = new Set(buildRouteTable().list().map((route) => route.path));
    assert.deepEqual(new Set(Object.keys(doc.paths)), tablePaths);

    const stream = doc.paths['/api/chat/query/stream'].post;
    assert.equal(stream.operationId, 'chat.queryStream');
    assert.ok(doc.paths['/api/chat/query'].post);
    assert.ok(doc.paths['/api/traces/{traceId}'].get);
    assert.deepEqual(
      doc.paths['/api/users/{id}/permissions'].get.parameters.map((p) => p.name),
      ['id'],
    );
  });
});

test('P0-8 middleware chain resolves auth errors through a single error boundary', async () => {
  const registry = createMiddlewareRegistry();
  const calls = [];
  const response = {
    headersSent: false,
    statusCode: null,
    payload: null,
    writeHead(statusCode) {
      this.statusCode = statusCode;
      this.headersSent = true;
    },
    end(body) {
      this.payload = body ? JSON.parse(body) : null;
    },
  };
  const ctx = {
    request: { url: '/x', headers: {} },
    response,
    database: { userRepository: { getUserAsync: async () => null } },
  };
  const route = {
    middleware: ['auth'],
    handler: async () => { calls.push('handler'); },
  };
  await runRoute(ctx, route, registry);
  // getRequestUser throws before the handler runs: the boundary turns it into
  // a 401 envelope instead of letting the exception escape runRoute.
  assert.deepEqual(calls, []);
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.payload, { code: 401, message: 'user not found' });
});

test('P0-8 timeout middleware rejects slow handlers without leaking late failures', async () => {
  const registry = createMiddlewareRegistry();
  const timeout = registry.timeout('1ms');
  await assert.rejects(
    timeout({}, () => new Promise((resolve) => setTimeout(resolve, 30))),
    (error) => error.statusCode === 504 && error.code === 'REQUEST_TIMEOUT',
  );
  // Fast handlers still pass through untouched.
  await assert.doesNotReject(async () => {
    const result = await registry.timeout('1s')({}, async () => 'ok');
    assert.equal(result, 'ok');
  });
});

test('local catalog HTTP reads are available without an external platform', async () => {
  await withServer(async ({ baseUrl }) => {
    const headers = { 'x-user-id': '1' };
    const settings = await (await fetch(`${baseUrl}/api/settings`, { headers })).json();
    assert.deepEqual(settings, { localIndicatorCount: 0 });
    const health = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.equal(health.source.mode, 'local');
    assert.equal(health.source.localIndicatorManagement, true);
    assert.equal(health.source.indicatorSource, 'LOCAL');
    for (const [suffix, userId] of [['', '1'], ['?themeId=1', '2']]) {
      const response = await fetch(`${baseUrl}/api/indicators${suffix}`, {
        headers: { 'x-user-id': userId },
      });
      assert.equal(response.status, 200);
      const catalog = await response.json();
      assert.equal(catalog.localMode, true);
      assert.equal(catalog.source.source, 'LOCAL');
      assert.deepEqual(catalog.items, []);
    }
  });
});

test('local catalog sync confirms metadata and management writes remain available', async () => {
  await withServer(async ({ baseUrl, application }) => {
    const admin = { 'x-user-id': '1', 'content-type': 'application/json' };
    const types = await fetch(`${baseUrl}/api/indicator-types`, { headers: admin });
    assert.equal(types.status, 200);
    assert.deepEqual(await types.json(), []);
    const sync = await fetch(`${baseUrl}/api/indicators/sync`, { method: 'POST', headers: admin });
    assert.equal(sync.status, 200);
    assert.deepEqual(await sync.json(), {
      localMode: true, localCount: 0, persisted: false, message: '本地指标管理已启用',
    });
    const themeSave = await fetch(`${baseUrl}/api/themes/1`, {
      method: 'PUT', headers: admin,
      body: JSON.stringify({ name: '经营总览', description: '本地可编辑' }),
    });
    assert.equal(themeSave.status, 200);
    const indicator = await application.database.localIndicators.save({
      name: '销售额', bizName: 'sales_amount', typeId: 'sales', typeName: '经营指标',
    });
    const relationSave = await fetch(`${baseUrl}/api/indicators/${encodeURIComponent(indicator.id)}/themes`, {
      method: 'PUT', headers: admin, body: JSON.stringify({ themeIds: [1, 999999] }),
    });
    assert.equal(relationSave.status, 200);
    assert.deepEqual(await relationSave.json(), { indicatorId: indicator.id, themeIds: [1] });
    assert.deepEqual(application.database.listThemeIndicatorIds(1), [indicator.id]);
    const catalog = await (await fetch(`${baseUrl}/api/indicators?limit=2000`, { headers: admin })).json();
    assert.deepEqual(catalog.items.map((item) => item.id), [indicator.id]);
    assert.equal(catalog.source.source, 'LOCAL');
    const detail = await fetch(`${baseUrl}/api/indicators/${encodeURIComponent(indicator.id)}/detail`, { headers: admin });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).indicator.id, indicator.id);
    const missing = await fetch(`${baseUrl}/api/indicators/missing/detail`, { headers: admin });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { code: 404, message: 'indicator not found' });
    const confirmation = await (await fetch(`${baseUrl}/api/indicators/sync`, { method: 'POST', headers: admin })).json();
    assert.equal(confirmation.localCount, 1);
    assert.equal(confirmation.persisted, false);
    assert.deepEqual(await application.database.localIndicators.getAsync(indicator.id), catalog.items[0]);
  });
});

test('P0-8 HTTP contract is unchanged: errors, static fallback, NDJSON stream', async () => {
  await withServer(async ({ baseUrl, application }) => {
    configureAgentDataset(application);
    const admin = { 'content-type': 'application/json', 'x-user-id': '1' };
    const analyst = { 'content-type': 'application/json', 'x-user-id': '2' };

    const forbidden = await fetch(`${baseUrl}/api/models`, { headers: analyst });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), {
      code: 403,
      message: 'admin permission required',
    });

    const missing = await fetch(`${baseUrl}/api/themes/999999/prompt`, {
      method: 'PUT',
      headers: admin,
      body: JSON.stringify({ systemPrompt: 'x' }),
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { code: 404, message: 'theme not found' });

    const malformed = await fetch(`${baseUrl}/api/chat/query`, {
      method: 'POST',
      headers: analyst,
      body: '{not json',
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { code: 400, message: 'invalid JSON body' });

    const unknown = await fetch(`${baseUrl}/api/definitely/not/a/route`);
    assert.equal(unknown.status, 200);
    assert.match(unknown.headers.get('content-type'), /text\/html/);

    // Numeric route params keep rejecting non-numeric ids and fall back to the SPA.
    const nonNumeric = await fetch(`${baseUrl}/api/users/abc/permissions`, { headers: admin });
    assert.match(nonNumeric.headers.get('content-type'), /text\/html/);

    const streamResponse = await fetch(`${baseUrl}/api/chat/query/stream`, {
      method: 'POST',
      headers: analyst,
      body: JSON.stringify({ themeId: 1, question: '近7天华东销售额趋势' }),
    });
    assert.equal(streamResponse.status, 200);
    assert.equal(
      streamResponse.headers.get('content-type'),
      'application/x-ndjson; charset=utf-8',
    );
    const lines = (await streamResponse.text()).trim().split('\n');
    const events = lines.map((line) => JSON.parse(line));
    assert.ok(events.length >= 2);
    assert.equal(events.at(-1).type, 'stream_done');
    assert.equal(events.at(-2).type, 'final');
    assert.ok(events.at(-2).answer);
    assert.ok(events.at(-1).messageId);
    assert.ok(events.some((event) => (
      event.type === 'assistant_progress' && event.status === 'running'
    )));
    const answerStartIndex = events.findIndex((event) => event.type === 'assistant_answer_start');
    const answerDoneIndex = events.findIndex((event) => event.type === 'assistant_answer_done');
    assert.ok(answerStartIndex >= 0);
    assert.ok(answerDoneIndex > answerStartIndex);
    const streamedText = events.filter((event) => event.type === 'assistant_delta')
      .map((event) => event.text)
      .join('');
    const replacementText = events
      .filter((event) => event.type === 'assistant_answer_replace')
      .at(-1)?.text;
    assert.equal(replacementText ?? streamedText, events.at(-2).answer.message);
  });
});

test('dataset profiling API suggests and applies field roles without MySQL', async () => {
  await withServer(async ({ baseUrl, application }) => {
    const admin = { 'content-type': 'application/json', 'x-user-id': '1' };
    const analyst = { 'content-type': 'application/json', 'x-user-id': '2' };
    const source = application.businessDatasets.saveDataSource({
      code: 'profiling-test',
      name: 'Profiling test',
      host: '127.0.0.1',
      port: 9030,
      databaseName: 'demo',
      username: 'reader',
      password: 'secret',
    });
    const dataset = application.database.saveBusinessDataset({
      code: 'profiling_orders',
      name: '订单明细',
      datasourceId: source.id,
      schemaName: 'demo',
      primaryTable: 'orders',
      config: {},
    });
    application.database.replaceDatasetFields(dataset.id, [
      { fieldName: 'order_date', semanticType: 'DATE', dataType: 'date', role: 'DIMENSION', aggregator: 'NONE' },
      { fieldName: 'sale_amt', semanticType: 'NUMBER', dataType: 'decimal(12,2)', role: 'DIMENSION', aggregator: 'NONE' },
      { fieldName: 'region', semanticType: 'STRING', dataType: 'varchar(20)', role: 'DIMENSION', aggregator: 'NONE' },
    ]);
    // Simulated sample data: the profiler must work detached from MySQL.
    application.businessDatasets.sampleForProfiling = async () => ({
      columns: ['order_date', 'sale_amt', 'region'],
      rows: [
        { order_date: '2026-09-01', sale_amt: 1200.5, region: '华东' },
        { order_date: '2026-09-02', sale_amt: 980.25, region: '华南' },
        { order_date: '2026-09-03', sale_amt: 1530.75, region: '华东' },
        { order_date: '2026-09-04', sale_amt: 720.4, region: '华北' },
      ],
    });
    application.businessDatasets.listFieldRanges = async () => ({
      order_date: { min: '2026-01-01', max: '2026-09-08' },
    });

    const denied = await fetch(`${baseUrl}/api/business-datasets/${dataset.id}/profile`, {
      method: 'POST',
      headers: analyst,
      body: JSON.stringify({}),
    });
    assert.equal(denied.status, 403);

    const analyzeResponse = await fetch(
      `${baseUrl}/api/business-datasets/${dataset.id}/profile`,
      { method: 'POST', headers: admin, body: JSON.stringify({ sampleSize: 20 }) },
    );
    assert.equal(analyzeResponse.status, 200);
    const profile = await analyzeResponse.json();
    const roleOf = (name) => profile.fields.find((item) => item.fieldName === name).suggestedRole;
    assert.equal(roleOf('order_date'), 'TIME');
    assert.equal(roleOf('sale_amt'), 'METRIC');
    assert.equal(roleOf('region'), 'DIMENSION');
    assert.equal(profile.timeCondition.field, 'order_date');
    assert.equal(profile.timeCondition.autoRangeDays, 30);
    assert.equal(profile.summary.changedCount, 2);

    const unknownResponse = await fetch(
      `${baseUrl}/api/business-datasets/${dataset.id}/profile`,
      {
        method: 'PUT',
        headers: admin,
        body: JSON.stringify({ fields: [{ fieldName: 'nope', role: 'METRIC', aggregator: 'SUM' }] }),
      },
    );
    assert.equal(unknownResponse.status, 400);

    const applyResponse = await fetch(
      `${baseUrl}/api/business-datasets/${dataset.id}/profile`,
      {
        method: 'PUT',
        headers: admin,
        body: JSON.stringify({
          fields: [
            { fieldName: 'order_date', role: 'TIME', aggregator: 'NONE' },
            { fieldName: 'sale_amt', role: 'METRIC', aggregator: 'SUM' },
          ],
          config: { autoLatestDateRange: true, autoRangeDays: 30 },
        }),
      },
    );
    assert.equal(applyResponse.status, 200);
    const saved = application.database.listDatasetFields(dataset.id);
    assert.equal(saved.find((field) => field.fieldName === 'order_date').role, 'TIME');
    assert.equal(saved.find((field) => field.fieldName === 'sale_amt').role, 'METRIC');
    assert.equal(saved.find((field) => field.fieldName === 'sale_amt').aggregator, 'SUM');
    // Untouched fields keep their previous definition.
    assert.equal(saved.find((field) => field.fieldName === 'region').role, 'DIMENSION');
    assert.equal(
      application.database.getBusinessDataset(dataset.id).config.autoRangeDays,
      30,
    );
  });
});

test('dataset profiling degrades gracefully when the datasource is unreachable', async () => {
  await withServer(async ({ baseUrl, application }) => {
    const admin = { 'content-type': 'application/json', 'x-user-id': '1' };
    const source = application.businessDatasets.saveDataSource({
      code: 'profiling-degraded',
      name: 'Profiling degraded',
      host: '127.0.0.1',
      port: 9030,
      databaseName: 'demo',
      username: 'reader',
      password: 'secret',
    });
    const dataset = application.database.saveBusinessDataset({
      code: 'profiling_degraded',
      name: '订单明细降级',
      datasourceId: source.id,
      schemaName: 'demo',
      primaryTable: 'orders',
      config: {},
    });
    application.database.replaceDatasetFields(dataset.id, [
      { fieldName: 'biz_date', semanticType: 'DATE', dataType: 'date', role: 'DIMENSION', aggregator: 'NONE' },
      { fieldName: 'sale_amt', semanticType: 'NUMBER', dataType: 'decimal(12,2)', role: 'DIMENSION', aggregator: 'NONE' },
    ]);
    // Simulate an unreachable MySQL/Doris source without touching a real DB.
    application.businessDatasets.sampleForProfiling = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:9030');
    };

    const response = await fetch(
      `${baseUrl}/api/business-datasets/${dataset.id}/profile`,
      { method: 'POST', headers: admin, body: JSON.stringify({}) },
    );
    assert.equal(response.status, 200);
    const profile = await response.json();
    assert.equal(profile.degraded, true);
    assert.match(profile.degradedReason, /ECONNREFUSED/);
    assert.equal(profile.sampleSize, 0);
    const roleOf = (name) => profile.fields.find((item) => item.fieldName === name).suggestedRole;
    assert.equal(roleOf('biz_date'), 'TIME');
    assert.equal(roleOf('sale_amt'), 'METRIC');
    assert.equal(profile.timeCondition.field, 'biz_date');
    assert.equal(profile.timeCondition.autoRangeDays, 30);
  });
});

test('dataset fields can be disabled and become unreachable in the query flow', async () => {
  await withServer(async ({ baseUrl, application }) => {
    const admin = { 'content-type': 'application/json', 'x-user-id': '1' };
    const analyst = { 'content-type': 'application/json', 'x-user-id': '2' };
    const source = application.businessDatasets.saveDataSource({
      code: 'field-toggle',
      name: 'Field toggle',
      host: '127.0.0.1',
      port: 9030,
      databaseName: 'demo',
      username: 'reader',
      password: 'secret',
    });
    const dataset = application.database.saveBusinessDataset({
      code: 'field_toggle_orders',
      name: '字段开关订单',
      datasourceId: source.id,
      schemaName: 'demo',
      primaryTable: 'orders',
      config: {},
    });
    const fields = application.database.replaceDatasetFields(dataset.id, [
      { fieldName: 'order_date', semanticType: 'DATE', dataType: 'date', role: 'TIME', aggregator: 'NONE' },
      { fieldName: 'sale_amt', semanticType: 'NUMBER', dataType: 'decimal(12,2)', role: 'METRIC', aggregator: 'SUM' },
      { fieldName: 'region', semanticType: 'STRING', dataType: 'varchar(20)', role: 'DIMENSION', aggregator: 'NONE' },
    ]);
    // Every field defaults to enabled.
    assert.deepEqual(fields.map((field) => field.enabled), [true, true, true]);
    assert.equal(
      application.database.listBusinessDatasets()[0].enabledFieldCount,
      3,
    );

    const denied = await fetch(
      `${baseUrl}/api/business-datasets/${dataset.id}/fields/sale_amt`,
      { method: 'PUT', headers: analyst, body: JSON.stringify({ enabled: false }) },
    );
    assert.equal(denied.status, 403);

    const badBody = await fetch(
      `${baseUrl}/api/business-datasets/${dataset.id}/fields/sale_amt`,
      { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: 'no' }) },
    );
    assert.equal(badBody.status, 400);

    const missingField = await fetch(
      `${baseUrl}/api/business-datasets/${dataset.id}/fields/nope`,
      { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) },
    );
    assert.equal(missingField.status, 404);

    const disable = await fetch(
      `${baseUrl}/api/business-datasets/${dataset.id}/fields/sale_amt`,
      { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: false }) },
    );
    assert.equal(disable.status, 200);
    const disabled = await disable.json();
    assert.equal(disabled.field.enabled, false);
    assert.deepEqual(disabled.summary, { total: 3, enabled: 2 });

    // The admin console still sees the field, marked as disabled.
    const listed = await (await fetch(
      `${baseUrl}/api/business-datasets/${dataset.id}/fields`,
      { headers: admin },
    )).json();
    assert.equal(listed.find((field) => field.fieldName === 'sale_amt').enabled, false);
    assert.equal(listed.length, 3);

    // Every agent/query path reads with enabledOnly, so the field is unreachable.
    const queryable = application.database
      .listDatasetFields(dataset.id, { enabledOnly: true })
      .map((field) => field.fieldName);
    assert.deepEqual(queryable, ['order_date', 'region']);
    assert.throws(
      () => application.businessDatasets.buildQuery(dataset.id, { metrics: ['sale_amt'] }),
      /dataset metric field not found: sale_amt/,
    );
    assert.doesNotThrow(
      () => application.businessDatasets.buildQuery(
        dataset.id,
        { metrics: [{ field: 'region', aggregator: 'COUNT' }] },
      ),
    );

    // A schema re-sync keeps the explicit disable; new columns default to enabled.
    application.businessDatasets.listColumns = async () => [
      { columnName: 'order_date', dataType: 'date' },
      { columnName: 'sale_amt', dataType: 'decimal(12,2)' },
      { columnName: 'region', dataType: 'varchar(20)' },
      { columnName: 'channel', dataType: 'varchar(20)' },
    ];
    await application.businessDatasets.syncDatasetFields(dataset.id);
    const afterSync = application.database.listDatasetFields(dataset.id);
    assert.equal(afterSync.find((field) => field.fieldName === 'sale_amt').enabled, false);
    assert.equal(afterSync.find((field) => field.fieldName === 'channel').enabled, true);

    // Re-enabling restores it for the query flow.
    const enable = await fetch(
      `${baseUrl}/api/business-datasets/${dataset.id}/fields/sale_amt`,
      { method: 'PUT', headers: admin, body: JSON.stringify({ enabled: true }) },
    );
    assert.equal(enable.status, 200);
    assert.equal((await enable.json()).field.enabled, true);
    assert.doesNotThrow(
      () => application.businessDatasets.buildQuery(dataset.id, { metrics: ['sale_amt'] }),
    );
  });
});

test('theme status toggle really enables and disables the agent', async () => {
  await withServer(async ({ baseUrl }) => {
    const adminHeaders = { 'x-user-id': '1', 'content-type': 'application/json' };
    const themeId = 1;

    const disable = await fetch(`${baseUrl}/api/themes/${themeId}/status`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ status: 0 }),
    });
    assert.equal(disable.status, 200);
    assert.equal((await disable.json()).status, 0);

    // 停用后：管理端仍可见（便于重新启用），问数入口与直接携带 themeId 都被拒绝。
    const bootstrap = await (
      await fetch(`${baseUrl}/api/bootstrap`, { headers: { 'x-user-id': '1' } })
    ).json();
    assert.equal(bootstrap.themes.some((theme) => Number(theme.id) === themeId), false);
    assert.equal(
      bootstrap.managedThemes.find((theme) => Number(theme.id) === themeId)?.status,
      0,
    );
    const chat = await fetch(`${baseUrl}/api/chat/query`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ themeId, question: '近 7 天销售额' }),
    });
    assert.equal(chat.status, 409);

    const invalid = await fetch(`${baseUrl}/api/themes/${themeId}/status`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ status: 2 }),
    });
    assert.equal(invalid.status, 400);

    const analyst = await fetch(`${baseUrl}/api/themes/${themeId}/status`, {
      method: 'PUT',
      headers: { 'x-user-id': '2', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 1 }),
    });
    assert.equal(analyst.status, 403);

    const enable = await fetch(`${baseUrl}/api/themes/${themeId}/status`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ status: 1 }),
    });
    assert.equal(enable.status, 200);
    const restored = await (
      await fetch(`${baseUrl}/api/bootstrap`, { headers: { 'x-user-id': '1' } })
    ).json();
    assert.equal(restored.themes.some((theme) => Number(theme.id) === themeId), true);
  });
});

test('roles are normalized and analysts only receive their granted scope', async () => {
  await withServer(async ({ baseUrl }) => {
    const adminHeaders = { 'x-user-id': '1', 'content-type': 'application/json' };

    const created = await fetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ username: 'sales_lead', displayName: '销售负责人', role: 'admin' }),
    });
    assert.equal(created.status, 200);
    const createdUser = await created.json();
    assert.equal(createdUser.role, 'ADMIN');

    // 无法识别的角色一律按最低权限处理，避免越权。
    const fallback = await fetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ username: 'guest', displayName: '访客', role: 'superuser' }),
    });
    assert.equal((await fallback.json()).role, 'ANALYST');

    // 停用后的用户不能再访问任何接口。
    const disabled = await fetch(`${baseUrl}/api/users/${createdUser.id}`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ ...createdUser, role: 'ANALYST', status: 0 }),
    });
    assert.equal(disabled.status, 200);
    const blocked = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { 'x-user-id': String(createdUser.id) },
    });
    assert.equal(blocked.status, 401);

    // 分析员只拿到已授权主题，并且没有管理端数据。
    const analyst = await (
      await fetch(`${baseUrl}/api/bootstrap`, { headers: { 'x-user-id': '2' } })
    ).json();
    assert.equal(analyst.currentUser.role, 'ANALYST');
    assert.deepEqual(analyst.managedThemes, []);
    assert.deepEqual(analyst.models, []);
    assert.deepEqual(analyst.dataSources, []);
    assert.deepEqual(analyst.indicatorTypes, []);
    assert.equal(Object.hasOwn(analyst, 'users'), false);
    assert.equal(analyst.themes.length > 0, true);
    assert.equal(analyst.themes.every((theme) => theme.canManage === false), true);

    const analystUsers = await fetch(`${baseUrl}/api/users`, { headers: { 'x-user-id': '2' } });
    assert.equal(analystUsers.status, 403);
  });
});

test('session mode requires login and issues a revocable cookie', async () => {
  await withServer(async ({ baseUrl }) => {
    const anonymous = await fetch(`${baseUrl}/api/bootstrap`);
    assert.equal(anonymous.status, 401);

    const wrong = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'not-the-password' }),
    });
    assert.equal(wrong.status, 401);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'yolo123456' }),
    });
    assert.equal(login.status, 200);
    const cookie = sessionCookieOf(login);
    assert.match(cookie, /^yolo_session=/);
    assert.equal((await login.json()).user.role, 'ADMIN');

    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
    assert.equal((await me.json()).authenticated, true);

    const scoped = await fetch(`${baseUrl}/api/bootstrap`, { headers: { cookie } });
    assert.equal(scoped.status, 200);
    assert.equal((await scoped.json()).currentUser.username, 'admin');

    // x-user-id 在会话模式下不再具备认证能力。
    const spoofed = await fetch(`${baseUrl}/api/bootstrap`, { headers: { 'x-user-id': '1' } });
    assert.equal(spoofed.status, 401);

    const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    assert.equal(logout.status, 200);
    const afterLogout = await fetch(`${baseUrl}/api/bootstrap`, { headers: { cookie } });
    assert.equal(afterLogout.status, 401);
  }, { authMode: 'session' });
});

test('disabled accounts cannot log in and password changes rotate the session', async () => {
  await withServer(async ({ baseUrl }) => {
    const adminCookie = sessionCookieOf(await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'yolo123456' }),
    }));

    const disabled = await fetch(`${baseUrl}/api/users/2`, {
      method: 'PUT',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'east_manager', displayName: '华东区域经理', role: 'ANALYST', status: 0 }),
    });
    assert.equal(disabled.status, 200);
    const blocked = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'east_manager', password: 'yolo123456' }),
    });
    assert.equal(blocked.status, 403);

    const wrongCurrent = await fetch(`${baseUrl}/api/auth/password`, {
      method: 'PUT',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'nope', newPassword: 'newpassword' }),
    });
    assert.equal(wrongCurrent.status, 400);

    const changed = await fetch(`${baseUrl}/api/auth/password`, {
      method: 'PUT',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'yolo123456', newPassword: 'newpassword' }),
    });
    assert.equal(changed.status, 200);
    const oldPassword = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'yolo123456' }),
    });
    assert.equal(oldPassword.status, 401);
    const newPassword = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'newpassword' }),
    });
    assert.equal(newPassword.status, 200);

    // 管理员重置他人密码后旧会话立即失效。
    const analystCookie = sessionCookieOf(await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'channel_analyst', password: 'yolo123456' }),
    }));
    const reset = await fetch(`${baseUrl}/api/users/3/password`, {
      method: 'PUT',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'analystpass' }),
    });
    assert.equal(reset.status, 200);
    const stale = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: analystCookie } });
    assert.equal((await stale.json()).authenticated, false);
  }, { authMode: 'session' });
});

test('theme opening suggestions follow bindings, config, history and scope', async () => {
  await withServer(async ({ baseUrl, application }) => {
    const admin = { 'content-type': 'application/json', 'x-user-id': '1' };
    const analyst = { 'content-type': 'application/json', 'x-user-id': '2' };
    const theme = application.database.listThemes().find((item) => item.name === '经营总览');
    const otherTheme = application.database.listThemes().find((item) => item.name === '财务分析');
    const suggestionsUrl = (id) => `${baseUrl}/api/themes/${id}/suggestions`;
    const readSuggestions = async (id, headers = admin) => {
      const response = await fetch(suggestionsUrl(id), { headers });
      return { status: response.status, body: await response.json() };
    };

    // 主题没有任何绑定与配置时，回落到平台通用示例，首屏不留白。
    const generic = await readSuggestions(theme.id);
    assert.equal(generic.status, 200);
    assert.equal(generic.body.source, 'GENERIC');
    assert.ok(generic.body.cards.length >= 3);
    assert.equal(generic.body.resume, null);
    assert.deepEqual(generic.body.stats, {
      metricCount: 0,
      dimensionCount: 0,
      datasetName: null,
    });

    // 未授权的主题对分析员不可见。
    assert.equal((await readSuggestions(otherTheme.id, analyst)).status, 404);
    assert.equal((await readSuggestions(theme.id, analyst)).status, 200);

    const source = application.businessDatasets.saveDataSource({
      code: 'opening-suggestions',
      name: 'Opening suggestions',
      host: '127.0.0.1',
      port: 9030,
      databaseName: 'demo',
      username: 'reader',
      password: 'secret',
    });
    const dataset = application.database.saveBusinessDataset({
      code: 'opening_suggestions_orders',
      name: '开场建议订单',
      datasourceId: source.id,
      schemaName: 'demo',
      primaryTable: 'orders',
      config: {},
    });
    application.database.replaceDatasetFields(dataset.id, [
      { fieldName: 'order_date', semanticType: 'DATE', dataType: 'date', role: 'TIME', aggregator: 'NONE' },
      { fieldName: 'sale_amt', displayName: '含税销售额', role: 'METRIC', aggregator: 'SUM' },
      { fieldName: 'muted_amt', displayName: '停用指标', role: 'METRIC', aggregator: 'SUM', enabled: false },
      { fieldName: 'region', displayName: '销售大区名称', role: 'DIMENSION', aggregator: 'NONE' },
    ]);
    application.database.saveTheme({
      ...application.database.getTheme(theme.id),
      businessDatasetIds: [dataset.id],
      primaryBusinessDatasetId: dataset.id,
    }, theme.id);

    // 绑定字段后按业务名自动拼装，禁用的字段不参与。
    const auto = await readSuggestions(theme.id);
    assert.equal(auto.body.source, 'AUTO_SEMANTIC');
    assert.deepEqual(auto.body.stats, {
      metricCount: 1,
      dimensionCount: 1,
      datasetName: '开场建议订单',
    });
    assert.ok(auto.body.cards.some((card) => card.question.includes('含税销售额')));
    assert.ok(auto.body.cards.some((card) => card.question.includes('销售大区名称')));
    assert.ok(!auto.body.cards.some((card) => card.question.includes('停用指标')));

    // 未显式绑定主题时，可见数据集等于「权限内全部数据集」——与问数链路一致。
    application.database.saveTheme({
      ...application.database.getTheme(theme.id),
      businessDatasetIds: [],
      primaryBusinessDatasetId: null,
    }, theme.id);
    const unbound = await readSuggestions(theme.id);
    assert.equal(unbound.body.source, 'AUTO_SEMANTIC');
    assert.equal(unbound.body.stats.datasetName, '开场建议订单');
    assert.ok(unbound.body.cards.some((card) => card.question.includes('含税销售额')));

    // 手工配置的示例优先于自动拼装，并带上能力分组。
    application.database.saveTheme({
      ...application.database.getTheme(theme.id),
      examples: ['近 7 天含税销售额趋势', '按销售大区名称看含税销售额排行'],
    }, theme.id);
    const configured = await readSuggestions(theme.id);
    assert.equal(configured.body.source, 'THEME_EXAMPLES');
    assert.deepEqual(configured.body.cards, [
      { group: '趋势', question: '近 7 天含税销售额趋势' },
      { group: '排行', question: '按销售大区名称看含税销售额排行' },
    ]);

    // 「继续上次」取该主题最近会话的最后几个问题。
    const session = application.agent.createSession({
      userId: 1,
      themeId: theme.id,
      title: '开场建议会话',
    });
    for (const question of ['第一个问题', '第二个问题', '第三个问题', '第四个问题']) {
      application.memory.appendUserMessage(session.id, 1, question, {});
    }
    const resumed = await readSuggestions(theme.id);
    assert.ok(resumed.body.resume, 'expected a resume entry');
    assert.equal(resumed.body.resume.sessionId, session.id);
    assert.equal(resumed.body.resume.title, '开场建议会话');
    assert.deepEqual(
      resumed.body.resume.questions,
      ['第二个问题', '第三个问题', '第四个问题'],
    );

    // 分析员只看得到自己的历史，管理员看得到自己的。
    const analystView = await readSuggestions(theme.id, analyst);
    assert.equal(analystView.body.resume, null);

    assert.equal((await readSuggestions(999999)).status, 404);
  });
});
