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
