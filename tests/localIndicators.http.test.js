import assert from 'node:assert/strict';
import test from 'node:test';
import { withSkillServer } from './fixtures/skillServer.js';

const valid = { name: '销售额', bizName: 'sales_amount', indicatorLevel: 'ATOMIC' };

test('local indicator writes reject malformed payloads without changing catalog or audit history', async () => {
  await withSkillServer(async ({ application, request, login }) => {
    const cookie = await login('admin');
    const created = await request('/api/local-indicators', { cookie, method: 'POST', body: valid });
    assert.equal(created.response.status, 200);
    const route = `/api/local-indicators/${encodeURIComponent(created.data.id)}`;
    const before = await application.database.localIndicators.getAsync(created.data.id);
    const auditCount = () => application.database.db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count;
    const originalAudits = auditCount();
    const malformed = [null, [], 'text', 123, {},
      { ...valid, name: {} }, { ...valid, bizName: [] }, { ...valid, name: '  ' },
      { ...valid, description: {} }, { ...valid, typeId: [] },
      { ...valid, indicatorLevel: 'UNKNOWN' }, { ...valid, indicatorLevel: null },
      ...[null, true, false, 2, 'false', {}, []].map((status) => ({ ...valid, status })),
      ...['metrics', 'dimensions', 'models'].flatMap((key) => [
        { ...valid, [key]: {} }, { ...valid, [key]: [null] }, { ...valid, [key]: ['text'] },
      ]),
      { ...valid, raw: [] },
    ];
    for (const body of malformed) {
      for (const [url, method] of [['/api/local-indicators', 'POST'], [route, 'PUT']]) {
        const result = await request(url, { cookie, method, body });
        assert.equal(result.response.status, 400, `${method}: ${JSON.stringify(body)}`);
        assert.equal(await application.database.localIndicators.countAsync(), 1);
        assert.deepEqual(await application.database.localIndicators.getAsync(created.data.id), before);
        assert.equal(auditCount(), originalAudits);
      }
    }
  });
});

test('local indicator lifecycle normalizes numeric statuses and enforces session ACL in the always-local catalog', async () => {
  await withSkillServer(async ({ application, request, login }) => {
    const admin = await login('admin');
    const analyst = await login('east_manager');
    const created = await request('/api/local-indicators', {
      cookie: admin, method: 'POST', body: { ...valid, status: '0', indicatorLevel: 'derived' },
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.data.status, 0);
    assert.equal(created.data.indicatorLevel, 'DERIVED');
    const route = `/api/local-indicators/${encodeURIComponent(created.data.id)}`;
    for (const [url, method] of [['/api/local-indicators', 'POST'], [route, 'PUT'], [route, 'DELETE']]) {
      const anonymous = await request(url, { method, body: valid, headers: { 'x-user-id': '1' } });
      assert.equal(anonymous.response.status, 401);
      const denied = await request(url, { cookie: analyst, method, body: valid, headers: { 'x-user-id': '1' } });
      assert.equal(denied.response.status, 403);
    }
    assert.equal((await application.database.localIndicators.getAsync(created.data.id)).status, 0);
    for (const status of [1, '0', '1', 0]) {
      const updated = await request(route, { cookie: admin, method: 'PUT', body: { ...valid, status } });
      assert.equal(updated.response.status, 200);
      assert.equal(updated.data.status, Number(status));
    }
    assert.equal((await request(route, { cookie: admin, method: 'DELETE' })).response.status, 200);
    assert.equal(await application.database.localIndicators.countAsync(), 0);
    assert.equal((await request(route, { cookie: admin, method: 'PUT', body: valid })).response.status, 404);
  });
});

test('mounting an existing indicator only updates theme indicatorIds', async () => {
  await withSkillServer(async ({ application, request, login }) => {
    const admin = await login('admin');
    const created = await request('/api/local-indicators', {
      cookie: admin, method: 'POST', body: valid,
    });
    assert.equal(created.response.status, 200);

    const theme = application.database.getTheme(1);
    const mounted = await request(`/api/themes/${theme.id}`, {
      cookie: admin,
      method: 'PUT',
      body: { indicatorIds: [created.data.id] },
    });

    assert.equal(mounted.response.status, 200, JSON.stringify(mounted.data));
    assert.deepEqual(mounted.data.indicatorIds, [created.data.id]);
    assert.equal(mounted.data.name, theme.name);
    assert.equal(mounted.data.description, theme.description);
    assert.equal(mounted.data.systemPrompt, theme.systemPrompt);
    assert.deepEqual(mounted.data.businessDatasetIds, theme.businessDatasetIds);
    assert.deepEqual(mounted.data.modelIds, theme.modelIds);
    assert.deepEqual(
      application.database.getTheme(theme.id).indicatorIds,
      [created.data.id],
    );
  });
});
