import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { dockerEnvironmentArgs } from './fixtures/dockerEnvironment.js';
import { dockerPersistedStateScript } from './fixtures/dockerPersistedState.js';

const enabled = process.env.YOLO_DOCKER_TEST === '1';
const PASSWORD = 'docker-acceptance-password';
const SOURCE_PASSWORD = 'disposable-datasource-password';

test('Docker image supports sessions and preserves SQLite and encryption keys across recreation', {
  skip: !enabled, timeout: 240_000,
}, async t => {
  const name = `yolo-smoke-${randomUUID()}`;
  const volume = `${name}-data`;
  const image = process.env.YOLO_DOCKER_IMAGE || 'yolo-data:smoke';
  const docker = (...args) => execFileSync('docker', args, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 5 * 1024 * 1024,
  }).trim();
  t.after(() => {
    try { t.diagnostic(docker('logs', name)); } catch { /* The container may not have started. */ }
    try { docker('rm', '-f', name); }
    finally { docker('volume', 'rm', volume); }
  });
  docker('volume', 'create', volume);

  async function start(defaultPassword) {
    docker('run', '-d', '--name', name, '-p', '127.0.0.1::8088',
      '-v', `${volume}:/app/data`, ...dockerEnvironmentArgs(defaultPassword), image);
    const port = docker('port', name, '8088/tcp').split(':').at(-1);
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', name));
      if (!state.Running) assert.fail(`container exited: ${docker('logs', name)}`);
      if (state.Health?.Status === 'healthy') return base;
      await delay(1000);
    }
    assert.fail(`container did not become healthy: ${docker('logs', name)}`);
  }

  async function request(base, route, { cookie, method = 'GET', body } = {}) {
    const response = await fetch(`${base}${route}`, { method, signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, data: await response.json() };
  }

  async function login(base) {
    const { response, data } = await request(base, '/api/auth/login', {
      method: 'POST', body: { username: 'admin', password: PASSWORD },
    });
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.authMode, 'session');
    return response.headers.get('set-cookie').split(';')[0];
  }

  function persistedState() {
    return JSON.parse(docker('exec', name, 'node', '--input-type=module', '-e',
      dockerPersistedStateScript('/app/data', SOURCE_PASSWORD)));
  }

  const firstBase = await start(PASSWORD);
  assert.notEqual(docker('exec', name, 'id', '-u'), '0', 'application must run as a non-root user');
  assert.equal(
    docker('exec', name, 'python3', '-c', 'import pandas, openpyxl; print("analysis-ready")'),
    'analysis-ready',
  );
  const pgPresent = docker('exec', name, 'node', '-e', `
    try { require.resolve('pg'); console.log('true'); }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; console.log('false'); }
  `);
  assert.equal(pgPresent, process.env.YOLO_DOCKER_EXPECT_PG || 'false', 'optional PostgreSQL driver availability');
  const health = await request(firstBase, '/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.data.status, 'ok');
  assert.equal((await request(firstBase, '/api/data-sources')).response.status, 401);
  const cookie = await login(firstBase);
  const created = await request(firstBase, '/api/data-sources', { cookie, method: 'POST', body: {
    code: 'docker_smoke', name: 'Docker acceptance', dbType: 'MYSQL',
    host: '127.0.0.1', port: 3306, databaseName: 'disposable', username: 'reader', password: SOURCE_PASSWORD,
  } });
  assert.equal(created.response.status, 200, JSON.stringify(created.data));
  const before = persistedState();
  assert.match(before.ciphertext, /^ENC:/);
  assert.notEqual(before.ciphertext, SOURCE_PASSWORD);

  docker('stop', '-t', '10', name);
  docker('rm', name);
  // A new container with the same volume must preserve existing accounts and state.
  const secondBase = await start('different-bootstrap-password');
  assert.deepEqual(persistedState(), before);
  assert.equal((await request(secondBase, '/api/data-sources')).response.status, 401);
  const freshCookie = await login(secondBase);
  for (const sessionCookie of [cookie, freshCookie]) {
    const listed = await request(secondBase, '/api/data-sources', { cookie: sessionCookie });
    assert.equal(listed.response.status, 200);
    assert.ok(listed.data.some(source => source.id === created.data.id && source.code === 'docker_smoke'));
  }
});
