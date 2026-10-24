import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import { WorkspaceService } from '../src/workspace.js';
import { createProcessArtifactRecorderAsync } from '../src/processArtifacts.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'process-concurrency-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  t.after(async () => {
    await database.closeAsync();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const service = new WorkspaceService(database);
  const userId = database.getUserByUsername('admin').id;
  const session = database.createChatSession({ userId, themeId: 1 });
  const workspace = service.ensureForSession({ userId, themeId: 1, sessionId: session.id });
  return { database, service, options: { workspaceId: workspace.id, userId, sessionId: session.id } };
}

const input = sequence => ({ tool: 'query', result: { columns: [{ name: 'sales' }], rows: [{ sales: sequence }] },
  step: { sequence, title: `Step ${sequence}` } });

for (const maxSteps of [2, 3]) {
  test(`overlapping process writes preserve ${maxSteps === 2 ? 'the step cap' : 'ordered lineage'}`, async t => {
    const { service, options } = fixture(t);
    let release, entered, writes = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    const adapter = { async createProcessArtifactAsync(args) {
      if (++writes === 1) { entered(); await gate; }
      return service.createProcessArtifactAsync(args);
    } };
    const artifactIds = [], events = [];
    const record = createProcessArtifactRecorderAsync({ ...options, service: adapter, maxSteps,
      artifactIds, emit: event => events.push(event) });
    assert.equal(await record({ tool: 'catalog', result: {} }), null);
    const first = record(input(1));
    await ready;
    const second = record(input(2));
    const third = record(input(3));
    release();
    const results = await Promise.all([first, second, third]);
    const stored = await service.listArtifactsAsync(options);
    assert.equal(stored.length, maxSteps);
    const created = results.filter(Boolean);
    assert.equal(created.length, maxSteps);
    assert.deepEqual(artifactIds, created.map(item => item.id));
    assert.deepEqual(events.map(event => event.artifactId), artifactIds);
    for (let index = 1; index < created.length; index++) {
      assert.deepEqual(created[index].metadata.inputArtifactIds, [created[index - 1].id]);
    }
    if (maxSteps === 2) assert.equal(results[2], null);
  });
}

test('a failed process write does not poison the queue or consume its cap', async t => {
  const { service, options } = fixture(t);
  let attempts = 0;
  const record = createProcessArtifactRecorderAsync({ ...options, maxSteps: 1,
    service: { async createProcessArtifactAsync(args) {
      if (++attempts === 1) throw new Error('write rejected');
      return service.createProcessArtifactAsync(args);
    } },
  });
  const [failed, saved, capped] = await Promise.all([record(input(1)), record(input(2)), record(input(3))]);
  assert.equal(failed, null);
  assert.ok(saved.id);
  assert.equal(capped, null);
  assert.equal(attempts, 2);
  assert.equal((await service.listArtifactsAsync(options)).length, 1);
  assert.deepEqual(saved.metadata.inputArtifactIds, []);
});
