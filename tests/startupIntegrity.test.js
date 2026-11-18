import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildRouteTable } from '../src/server.js';

test('split route modules register bootstrap and model connection exactly once', () => {
  const routes = buildRouteTable().list();
  for (const [method, routePath] of [['GET', '/api/bootstrap'], ['POST', '/api/models/test']]) {
    assert.equal(routes.filter(route => route.method === method && route.routePath === routePath).length, 1);
  }
});

for (const file of ['scripts/setup.mjs', 'scripts/generate-mysql-init.mjs']) {
  test(file + ' parses before any dependency installation or database initialization', () => {
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL('../' + file, import.meta.url))],
      { stdio: 'pipe', timeout: 10_000 });
  });
}
