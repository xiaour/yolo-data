import assert from 'node:assert/strict';
import test from 'node:test';
import { withSkillServer } from './fixtures/skillServer.js';

test('local indicator bindings intersect user grants and exclude disabled or deleted entries', async () => {
  await withSkillServer(async ({ application, request, login }) => {
    const admin = await login('admin');
    const analyst = await login('east_manager');
    const user = application.database.getUserByUsername('east_manager');
    const theme = application.database.getTheme(1);
    const create = async (name) => {
      const result = await request('/api/local-indicators', {
        cookie: admin, method: 'POST', body: { name, bizName: name },
      });
      assert.equal(result.response.status, 200);
      return result.data;
    };
    const allowed = await create('allowed_sales');
    const notGranted = await create('private_cost');
    const notBound = await create('other_theme_profit');
    assert.equal((await request('/api/themes/1', { cookie: admin, method: 'PUT',
      body: { ...theme, indicatorIds: [allowed.id, notGranted.id] },
    })).response.status, 200);
    const profile = application.database.getPermissionProfile(user.id);
    const permissions = { ...profile,
      themeGrants: [{ themeId: 1, canQuery: true, canManage: false }],
      indicatorGrants: [allowed, notBound].map(({ id }) => ({ indicatorId: id, canQuery: true })),
    };
    const savePermissions = async (body) => {
      assert.equal((await request(`/api/users/${user.id}/permissions`, {
        cookie: admin, method: 'PUT', body,
      })).response.status, 200);
    };
    await savePermissions(permissions);
    const list = async () => request('/api/indicators?themeId=1', { cookie: analyst });
    const detail = (id) => `/api/indicators/${encodeURIComponent(id)}/detail?themeId=1`;
    assert.deepEqual((await list()).data.items.map(({ id }) => id), [allowed.id]);
    assert.equal((await request(detail(allowed.id), { cookie: analyst })).response.status, 200);
    for (const indicator of [notGranted, notBound]) {
      const denied = await request(detail(indicator.id), { cookie: analyst });
      assert.equal(denied.response.status, 403);
      assert.ok(!JSON.stringify(denied.data).includes(indicator.name));
    }
    const writePath = `/api/local-indicators/${encodeURIComponent(allowed.id)}`;
    assert.equal((await request(writePath, { cookie: admin, method: 'PUT',
      body: { ...allowed, status: 0 },
    })).response.status, 200);
    assert.deepEqual((await list()).data.items, []);
    assert.equal((await request(detail(allowed.id), { cookie: analyst })).response.status, 403);
    const management = await request('/api/indicators', { cookie: admin });
    assert.equal(management.data.items.find(({ id }) => id === allowed.id).status, 0);
    assert.equal((await request(writePath, { cookie: admin, method: 'PUT',
      body: { ...allowed, status: 1 },
    })).response.status, 200);
    assert.deepEqual((await list()).data.items.map(({ id }) => id), [allowed.id]);
    assert.equal((await request(writePath, { cookie: admin, method: 'DELETE' })).response.status, 200);
    assert.deepEqual((await list()).data.items, []);
    assert.equal((await request(detail(allowed.id), { cookie: analyst })).response.status, 403);
    // Retain the binding as a restriction: deleting the last entry must not open the scope.
    assert.ok(application.database.getTheme(1).indicatorIds.includes(allowed.id));
  });
});

test('revoked theme grants block catalogs, new queries and existing session access with HTTP 403', async () => {
  await withSkillServer(async ({ application, request, login }) => {
    const admin = await login('admin');
    const analyst = await login('east_manager');
    const user = application.database.getUserByUsername('east_manager');
    const session = await request('/api/chat/sessions', { cookie: analyst, method: 'POST',
      body: { themeId: 1, title: '撤权验证' },
    });
    assert.equal(session.response.status, 200);
    const profile = application.database.getPermissionProfile(user.id);
    assert.equal((await request(`/api/users/${user.id}/permissions`, {
      cookie: admin, method: 'PUT', body: { ...profile, themeGrants: [] },
    })).response.status, 200);
    assert.equal((await request('/api/indicators?themeId=1', { cookie: analyst })).response.status, 403);
    assert.equal((await request(`/api/chat/sessions/${session.data.id}/messages`, {
      cookie: analyst,
    })).response.status, 403);
    for (const body of [{ themeId: 1, question: '销售额是多少' },
      { sessionId: session.data.id, question: '继续上次查询' }]) {
      assert.equal((await request('/api/chat/query', {
        cookie: analyst, method: 'POST', body,
      })).response.status, 403);
    }
  });
});

test('local metadata cannot execute indicator tools or fabricate business query results', async () => {
  await withSkillServer(async ({ application, request, login }) => {
    const admin = await login('admin');
    const analyst = await login('east_manager');
    const created = await request('/api/local-indicators', { cookie: admin, method: 'POST',
      body: { name: '销售额', bizName: 'sales_amount' },
    });
    assert.equal(created.response.status, 200);
    const theme = application.database.getTheme(1);
    application.database.saveTheme({ ...theme, indicatorIds: [created.data.id], businessDatasetIds: [] }, 1);
    let toolChecks = 0;
    application.agent.harnessFactory = { forTheme: () => ({
      mode: 'local-rule', model: 'test-rule', capabilities: {},
      run: async ({ tools, executeTool }) => {
        const names = tools.map((tool) => tool.function.name);
        for (const name of ['search_indicators', 'get_indicator', 'query_indicator']) {
          assert.ok(!names.includes(name));
          await assert.rejects(executeTool(name, { indicatorId: created.data.id }), /指标.*停用/);
          toolChecks += 1;
        }
        await assert.rejects(executeTool('compile_query_contract', {
          sourceType: 'INDICATOR', sourceId: created.data.id,
        }), (error) => error.code === 'LOCAL_INDICATOR_QUERY_UNSUPPORTED');
        toolChecks += 1;
        return { content: '请先绑定可查询的业务数据集。', toolTrace: [] };
      },
    }) };
    const query = await request('/api/chat/query', { cookie: analyst, method: 'POST',
      body: { themeId: 1, question: '销售额是多少' },
    });
    assert.equal(query.response.status, 200);
    assert.equal(toolChecks, 4);
    assert.equal(query.data.runtime.executionAdapter, 'local-indicator-catalog');
    assert.deepEqual(query.data.executionResults, []);
    assert.equal(query.data.deterministic, false);
  });
});
