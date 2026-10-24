import assert from 'node:assert/strict';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import { getMcpConfig, getMcpConfigAsync, setMcpConfig, setMcpConfigAsync,
  _resetMcpConfigCache } from '../src/mcp/config.js';

function fixture(t) {
  const database = new PlatformDatabase(':memory:');
  t.after(() => database.closeAsync());
  _resetMcpConfigCache();
  t.after(_resetMcpConfigCache);
  return database;
}

for (const asyncOnly of [false, true]) {
  test(`MCP config cache isolates ${asyncOnly ? 'async-only' : 'synchronous'} databases`, async t => {
    const a = fixture(t);
    const b = fixture(t);
    const wrap = database => asyncOnly ? {
      isAsyncPlatformStore: true,
      async getPlatformSettingAsync(...args) { return database.getPlatformSetting(...args); },
      async savePlatformSettingAsync(...args) { return database.savePlatformSetting(...args); },
    } : database;
    const first = wrap(a), second = wrap(b);
    const read = asyncOnly ? getMcpConfigAsync : getMcpConfig;
    const save = asyncOnly ? setMcpConfigAsync : setMcpConfig;
    await save(first, { enabled: true, mode: 'full', tenantScope: ['first'] });
    assert.equal((await read(second)).enabled, false);
    await save(second, { enabled: true, mode: 'read', tenantScope: ['second'] });
    assert.deepEqual((await read(first)).tenantScope, ['first']);
    assert.deepEqual((await read(second)).tenantScope, ['second']);
  });
}

test('an older async config read cannot overwrite a completed administrator save', async t => {
  const database = fixture(t);
  database.savePlatformSetting('mcp', { enabled: true, mode: 'full' });
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const adapter = {
    isAsyncPlatformStore: true,
    async getPlatformSettingAsync(...args) {
      const snapshot = database.getPlatformSetting(...args);
      started(); await gate; return snapshot;
    },
    async savePlatformSettingAsync(...args) { return database.savePlatformSetting(...args); },
  };
  const pending = getMcpConfigAsync(adapter);
  await ready;
  await setMcpConfigAsync(adapter, { enabled: false, mode: 'disabled' });
  release();
  assert.equal((await pending).enabled, false);
  assert.equal((await getMcpConfigAsync(adapter)).mode, 'disabled');
  assert.equal(database.getPlatformSetting('mcp').value.enabled, false);
});

test('config cache expires after five seconds and reset invalidates every database', t => {
  const database = fixture(t);
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  setMcpConfig(database, { enabled: true, mode: 'full' });
  database.savePlatformSetting('mcp', { enabled: false, mode: 'disabled' });
  now = 5999;
  assert.equal(getMcpConfig(database).enabled, true);
  now = 6000;
  assert.equal(getMcpConfig(database).enabled, false);
  database.savePlatformSetting('mcp', { enabled: true, mode: 'read' });
  _resetMcpConfigCache();
  assert.equal(getMcpConfig(database).enabled, true);
});

test('failed config saves leave the last successful cached policy intact', async t => {
  const database = fixture(t);
  const failure = new Error('settings write failed');
  const adapter = {
    isAsyncPlatformStore: true,
    async getPlatformSettingAsync(...args) { return database.getPlatformSetting(...args); },
    async savePlatformSettingAsync() { throw failure; },
  };
  database.savePlatformSetting('mcp', { enabled: false, mode: 'disabled' });
  await getMcpConfigAsync(adapter);
  await assert.rejects(setMcpConfigAsync(adapter, { enabled: true, mode: 'full' }), error => error === failure);
  assert.equal((await getMcpConfigAsync(adapter)).enabled, false);
});
