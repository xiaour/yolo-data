import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildRouteTable, startServer } from '../src/server.js';
import { createMiddlewareRegistry } from '../src/http/middleware.js';
import { createRouteTable, runRoute } from '../src/http/router.js';
import { FakeIndicatorClient } from './fixtures/fakeIndicatorClient.js';

function testConfig(directory) {
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

async function withServer(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-http-'));
  const { server, application } = await startServer(
    testConfig(directory),
    new FakeIndicatorClient(),
  );
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run({ baseUrl, application });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    application.database.close();
  }
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
    database: { getUser: () => null },
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

test('Supersonic is optional: indicator reads degrade to the local snapshot', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-offline-'));
  const { server, application } = await startServer(testConfig(directory), null);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const admin = { 'x-user-id': '1' };
  const analyst = { 'x-user-id': '2' };
  try {
    // Admin global list is what the theme/permission editors load; it used to
    // return 400 when Supersonic was enabled but unconfigured.
    const empty = await fetch(`${baseUrl}/api/indicators?limit=2000`, { headers: admin });
    assert.equal(empty.status, 200);
    const emptyBody = await empty.json();
    assert.deepEqual(emptyBody.items, []);
    assert.equal(emptyBody.offline, true);
    assert.equal(emptyBody.source.source, 'UNAVAILABLE');

    const scoped = await fetch(`${baseUrl}/api/indicators?themeId=1`, { headers: analyst });
    assert.equal(scoped.status, 200);
    assert.ok(Array.isArray((await scoped.json()).items));

    const types = await fetch(`${baseUrl}/api/indicator-types`, { headers: admin });
    assert.equal(types.status, 200);
    assert.deepEqual(await types.json(), []);

    // Explicit sync also degrades instead of returning an error.
    const sync = await fetch(`${baseUrl}/api/indicators/sync`, {
      method: 'POST',
      headers: admin,
    });
    assert.equal(sync.status, 200);
    const syncBody = await sync.json();
    assert.equal(syncBody.skipped, true);
    assert.equal(syncBody.reason, 'SUPERSONIC_NOT_CONFIGURED');

    // Management writes are not blocked by the missing indicator platform.
    const themeSave = await fetch(`${baseUrl}/api/themes/1`, {
      method: 'PUT',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '经营总览', description: '离线可编辑' }),
    });
    assert.equal(themeSave.status, 200);

    // Once a snapshot exists it is served with an explicit SNAPSHOT marker.
    application.database.syncIndicators([
      { id: '42', name: '销售额', bizName: '销售额', metrics: [], dimensions: [] },
    ]);
    const snapshotResponse = await fetch(`${baseUrl}/api/indicators?limit=2000`, {
      headers: admin,
    });
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.items.length, 1);
    assert.equal(snapshot.items[0].id, '42');
    assert.equal(snapshot.source.source, 'SNAPSHOT');

    const detail = await fetch(`${baseUrl}/api/indicators/42/detail`, { headers: admin });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).indicator.id, '42');

    const missingDetail = await fetch(`${baseUrl}/api/indicators/9999/detail`, {
      headers: admin,
    });
    assert.equal(missingDetail.status, 404);
    assert.deepEqual(await missingDetail.json(), {
      code: 404,
      message: 'indicator not found',
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    application.database.close();
  }
});

test('P0-8 HTTP contract is unchanged: errors, static fallback, NDJSON stream', async () => {
  await withServer(async ({ baseUrl }) => {
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
    assert.equal(analyst.users.length, 1);
    assert.equal(analyst.themes.length > 0, true);
    assert.equal(analyst.themes.every((theme) => theme.canManage === false), true);

    const analystUsers = await fetch(`${baseUrl}/api/users`, { headers: { 'x-user-id': '2' } });
    assert.equal(analystUsers.status, 403);
  });
});
