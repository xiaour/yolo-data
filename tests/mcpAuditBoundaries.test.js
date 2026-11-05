import assert from 'node:assert/strict';
import test from 'node:test';
import { auditToolCall, MCP_ERROR } from '../src/mcp/audit.js';
import { resolveToolContext } from '../src/mcp/tools/resolveToolContext.js';

for (const asyncStore of [false, true]) {
  test(`MCP audit redacts nested credentials without mutating parameters (async=${asyncStore})`, async () => {
    const entries = [];
    const database = asyncStore
      ? { addAuditLogAsync: async entry => entries.push(entry) }
      : { addAuditLog: entry => entries.push(entry) };
    const parameters = { nested: [{ password: 'hidden', label: 'x'.repeat(220) }], apiKey: 'hidden', values: Array.from({ length: 25 }, (_, i) => i) };
    const result = { content: [{ type: 'text', text: 'y'.repeat(320) }] };
    assert.equal(await auditToolCall(database, { toolName: 'get_policy', parameters }, async () => result), result);
    const detail = entries[0].detail;
    assert.equal(detail.outcome, 'success');
    assert.equal(detail.parameters.apiKey, '***');
    assert.equal(detail.parameters.nested[0].password, '***');
    assert.equal(detail.parameters.nested[0].label.length, 201);
    assert.equal(detail.parameters.values.length, 20);
    assert.equal(detail.resultSummary.length, 301);
    assert.equal(parameters.nested[0].password, 'hidden');
    assert.equal(parameters.values.length, 25);
  });
}

test('MCP audit write failures preserve tool return values and original errors', async () => {
  const database = { addAuditLogAsync: async () => { throw new Error('audit unavailable'); } };
  const result = { content: [] };
  assert.equal(await auditToolCall(database, { toolName: 'get_policy' }, async () => result), result);
  const original = Object.assign(new Error('denied'), { code: MCP_ERROR.FORBIDDEN });
  await assert.rejects(auditToolCall(database, { toolName: 'get_policy' }, async () => { throw original; }), error => error === original);
});

for (const asyncContext of [false, true]) {
  test(`MCP context preserves provider receiver and translates errors (async=${asyncContext})`, async () => {
    const name = asyncContext ? 'resolveContextAsync' : 'resolveContext';
    const scope = { allowed: false, reason: 'scope denied' };
    const agent = { scope, [name](userId, themeId) {
      assert.equal(userId, 7);
      assert.equal(themeId, 9);
      return asyncContext ? Promise.resolve({ scope: this.scope }) : { scope: this.scope };
    } };
    assert.deepEqual(await resolveToolContext(agent, 7, 9), { scope });
    agent[name] = () => {
      if (asyncContext) return Promise.reject(new Error('provider denied'));
      throw new Error('provider denied');
    };
    await assert.rejects(resolveToolContext(agent, 7, 9), { code: MCP_ERROR.FORBIDDEN, message: 'provider denied' });
  });
}
