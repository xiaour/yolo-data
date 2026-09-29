import assert from 'node:assert/strict';
import test from 'node:test';
import { SupersonicIndicatorClient } from '../src/indicatorClient.js';
import { resolveRecentDateInfo } from '../src/timeSemantics.js';

test('Supersonic client normalizes indicator pages and forwards auth headers', async () => {
  const requests = [];
  const client = new SupersonicIndicatorClient({
    baseUrl: 'http://supersonic.local',
    token: 'test-token',
    appKey: 'test-app-key',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return new Response(JSON.stringify({
        code: 200,
        data: {
          list: [{ id: 7, name: '销售额' }],
          total: 1,
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const page = await client.listIndicators({ keyword: '销售', pageSize: 20 });
  assert.equal(client.mode, 'supersonic');
  assert.equal(page.total, 1);
  assert.equal(page.list[0].id, 7);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(requests[0].options.headers['login-token'], 'test-token');
  assert.equal(requests[0].options.headers['App-Key'], 'test-app-key');
  assert.match(requests[0].url, /\/api\/semantic\/asset\/indicator\/query$/);
});

test('Supersonic client only sends semantic query fields to the metric endpoint', async () => {
  let capturedBody = null;
  const client = new SupersonicIndicatorClient({
    baseUrl: 'http://supersonic.local',
    fetchImpl: async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        columns: [{ name: '销售额', bizName: 'sales_amount', showType: 'NUMBER' }],
        resultList: [{ sales_amount: 100 }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const result = await client.queryIndicator({
    metricNames: ['sales_amount'],
    dimensionNames: ['region'],
    filters: [{ bizName: 'region', operator: 'IN', value: ['华东'] }],
    dateInfo: { dateMode: 'RECENT', unit: 7, period: 'DAY' },
    limit: 50,
  });
  assert.equal(result.resultList[0].sales_amount, 100);
  assert.deepEqual(Object.keys(capturedBody).sort(), [
    'dateInfo',
    'dimensionNames',
    'filters',
    'limit',
    'metricNames',
  ]);
  assert.equal('sql' in capturedBody, false);
});

test('Supersonic formatted query reuses the existing metric endpoint and format metadata', async () => {
  let capturedUrl = '';
  const client = new SupersonicIndicatorClient({
    baseUrl: 'http://supersonic.local',
    fetchImpl: async (url) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({
        columns: [{
          name: '销售额',
          bizName: 'sale_amt',
          showType: 'NUMBER',
          dataFormatType: 'decimal',
          dataFormat: { decimalPlaces: 1, needMultiply100: false },
        }],
        resultList: [{ sale_amt: 470000 }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const result = await client.queryIndicatorFormatted({
    metricNames: ['sale_amt'],
    dimensionNames: [],
    filters: [],
    dateInfo: { dateMode: 'ALL' },
    limit: 50,
  });
  assert.match(capturedUrl, /\/api\/semantic\/query\/metric$/);
  assert.equal(result.columns[0].dataFormatType, 'decimal');
  assert.equal(result.columns[0].dataFormat.decimalPlaces, 1);
});

test('Supersonic client loads dimension values for the default semantic domain', async () => {
  let capturedBody = null;
  const client = new SupersonicIndicatorClient({
    baseUrl: 'http://supersonic.local',
    fetchImpl: async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        columns: [{ name: '行业', bizName: 'first_category_name' }],
        resultList: [
          { first_category_name: 'fresh' },
          { first_category_name: 'grocery' },
          { first_category_name: 'fresh' },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const values = await client.queryDimensionValues({
    elementId: 301,
    modelId: 48,
    bizName: 'first_category_name',
    dateField: 'sdt',
  });
  assert.deepEqual(values, ['fresh', 'grocery']);
  assert.equal(capturedBody.elementID, 301);
  assert.equal(capturedBody.modelId, 48);
  assert.equal(capturedBody.bizName, 'first_category_name');
  assert.equal(capturedBody.dateInfo.dateMode, 'ALL');
  assert.equal(capturedBody.dateInfo.dateField, 'sdt');
});

test('Supersonic client rejects application-level authentication failures', async () => {
  const client = new SupersonicIndicatorClient({
    baseUrl: 'http://supersonic.local',
    fetchImpl: async () => new Response(JSON.stringify({
      code: 403,
      msg: 'authentication failed, please login',
      data: null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  await assert.rejects(
    client.listTypes(),
    /Supersonic API error \(403\): authentication failed, please login/,
  );
});

test('Supersonic client reports an expired JWT before making a request', async () => {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) - 60,
  })).toString('base64url');
  let requested = false;
  const client = new SupersonicIndicatorClient({
    baseUrl: 'http://supersonic.local',
    token: `header.${payload}.signature`,
    fetchImpl: async () => {
      requested = true;
      return new Response('{}');
    },
  });

  await assert.rejects(client.listTypes(), /Supersonic Token 已于 .* 过期/);
  assert.equal(requested, false);
});

test('Supersonic client exchanges service credentials for a token', async () => {
  const requests = [];
  const client = new SupersonicIndicatorClient({
    baseUrl: 'http://supersonic.local',
    serviceClientId: 'yolo',
    serviceClientSecret: 'service-secret',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/api/auth/service/token')) {
        return new Response(JSON.stringify({
          code: 200,
          data: {
            token: 'service-token',
            appKey: 'supersonic',
            expireAt: Date.now() + 3_600_000,
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ code: 200, data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await client.listTypes();
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/api\/auth\/service\/token$/);
  assert.equal(
    JSON.parse(requests[0].options.body).clientId,
    'yolo',
  );
  assert.equal(
    requests[1].options.headers.Authorization,
    'Bearer service-token',
  );
  assert.equal(requests[1].options.headers['App-Key'], 'supersonic');
});

test('Supersonic catalog falls back to the legacy list endpoint', async () => {
  const requests = [];
  const client = new SupersonicIndicatorClient({
    baseUrl: 'http://supersonic.local',
    token: 'test-token',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/api/semantic/asset/indicator/catalog')) {
        return new Response('not found', { status: 404 });
      }
      return new Response(JSON.stringify({
        code: 200,
        data: { list: [{ id: 2, name: '含税销售金额' }], total: 1 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const catalog = await client.listCatalog({ pageSize: 100 });
  assert.equal(catalog.total, 1);
  assert.match(requests[1].url, /\/api\/semantic\/asset\/indicator\/query$/);
});

test('Supersonic client resolves recent dates before querying', async () => {
  const bodies = [];
  const client = new SupersonicIndicatorClient({
    baseUrl: 'http://supersonic.local',
    token: 'test-token',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return new Response(JSON.stringify({
        columns: [{ bizName: 'sale_amt', showType: 'NUMBER' }],
        resultList: [{ sdt: '2026-09-07', sale_amt: 2 }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await client.queryIndicator({
    metricNames: ['sale_amt'],
    dimensionNames: ['sdt'],
    filters: [],
    dateInfo: {
      dateMode: 'RECENT',
      unit: 7,
      period: 'DAY',
      dateField: 'sdt',
    },
  });

  const expected = resolveRecentDateInfo({
    unit: 7,
    period: 'DAY',
    detectWord: '',
  });
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].dateInfo, {
    ...expected,
    dateField: 'sdt',
  });
});
