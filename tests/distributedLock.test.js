import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createKnexPlatformStore } from '../src/knexPlatformStore.js';
import { createDistributedLock } from '../src/distributedLock.js';

test('platform leases exclude another connection and preserve owner checks', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-lock-'));
  const filename = path.join(directory, 'locks.db');
  const firstStore = createKnexPlatformStore({ backend: 'sqlite', path: filename });
  const secondStore = createKnexPlatformStore({ backend: 'sqlite', path: filename });
  try {
    await firstStore.execute('CREATE TABLE session_locks ("key" TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at TEXT NOT NULL)');
    const first = createDistributedLock({ database: firstStore });
    const second = createDistributedLock({ database: secondStore });
    assert.deepEqual(await Promise.all([
      first.acquire('session:1', 'first'), second.acquire('session:1', 'second'),
    ]), [true, false]);
    assert.equal(await second.refresh('session:1', 'second'), false);
    assert.equal(await second.release('session:1', 'second'), false);
    assert.equal(await first.refresh('session:1', 'first'), true);
    assert.equal(await second.acquire('session:2', 'second'), true);
    await firstStore.execute('UPDATE session_locks SET expires_at=? WHERE "key"=?',
      ['2000-01-01T00:00:00.000Z', 'session:1']);
    assert.equal(await second.acquire('session:1', 'second'), true);
    assert.equal(await first.release('session:1', 'first'), false);
    assert.equal(await second.release('session:1', 'second'), true);
    assert.equal(await first.acquire('session:1', 'first'), true);
  } finally {
    await secondStore.close();
    await firstStore.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Redis mode without a supplied client fails explicitly', async () => {
  const lock = createDistributedLock({ backend: 'redis' });
  assert.equal(lock.enabled, false);
  await assert.rejects(lock.acquire('session:1', 'owner'), /Redis/);
  assert.equal(await lock.release('session:1', 'owner'), false);
});
