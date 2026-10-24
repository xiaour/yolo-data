import assert from 'node:assert/strict';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import { WorkspaceService } from '../src/workspace.js';
import { UploadService } from '../src/uploads.js';

const contentBase64 = Buffer.from('code,amount\na,1\n').toString('base64');
export function createUploadHarness(database, limits = {}) {
  const workspace = new WorkspaceService(database);
  const uploads = new UploadService({ database, workspace, config: { uploads: limits } });
  return { workspace, uploads };
}
for (const existingWorkspace of [false, true]) {
  for (const quota of ['count', 'bytes']) {
    test(`concurrent uploads enforce ${quota} quota with ${existingWorkspace ? 'existing' : 'first'} workspace`, async () => {
      const database = new PlatformDatabase(':memory:');
      try {
        const { workspace, uploads } = createUploadHarness(database, quota === 'count'
          ? { maxFilesPerSession: 1 } : { maxTotalBytesPerSession: Buffer.from(contentBase64, 'base64').length });
        const user = database.getUserByUsername('admin');
        const theme = database.listThemes()[0];
        const session = database.createChatSession({ userId: user.id, themeId: theme.id });
        if (existingWorkspace) workspace.ensureForSession({ userId: user.id, themeId: theme.id, sessionId: session.id });
        const results = await Promise.allSettled(['one.csv', 'two.csv'].map(name => uploads.uploadAsync({ userId: user.id, sessionId: session.id, name, contentBase64 })));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        const rejected = results.find(result => result.status === 'rejected').reason;
        assert.equal(rejected.code, 'UPLOAD_QUOTA_EXCEEDED');
        assert.equal(rejected.statusCode, 429);
        const record = database.getWorkspaceBySession(session.id, user.id);
        const raw = workspace.listArtifacts({ workspaceId: record.id, userId: user.id }).filter(a => a.metadata?.source?.type === 'UPLOAD');
        assert.equal(raw.length, 1);
        assert.equal(database.db.prepare('SELECT COUNT(*) AS count FROM workspaces WHERE session_id=?').get(session.id).count, 1);
      } finally { database.close(); }
    });
  }
}

test('failed raw version insertion rolls back workspace, FILE and quota', async () => {
  const database = new PlatformDatabase(':memory:');
  try {
    const { uploads } = createUploadHarness(database, { maxFilesPerSession: 1 });
    const user = database.getUserByUsername('admin');
    const session = database.createChatSession({ userId: user.id, themeId: database.listThemes()[0].id });
    const input = { userId: user.id, sessionId: session.id, name: 'one.csv', contentBase64 };
    database.db.exec("CREATE TRIGGER fail_upload_version BEFORE INSERT ON artifact_versions BEGIN SELECT RAISE(ABORT, 'forced version failure'); END");
    await assert.rejects(uploads.uploadAsync(input), /forced version failure/);
    assert.equal(database.getWorkspaceBySession(session.id, user.id), null);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM workspace_artifacts').get().n, 0);
    assert.equal(database.db.prepare('SELECT COUNT(*) AS n FROM artifact_versions').get().n, 0);
    database.db.exec('DROP TRIGGER fail_upload_version');
    assert.ok((await uploads.uploadAsync(input)).file.artifactId);
  } finally { database.close(); }
});

test('inactive uploads release quota and independent sessions retain their own quota', async () => {
  const database = new PlatformDatabase(':memory:');
  try {
    const { uploads } = createUploadHarness(database, { maxFilesPerSession: 1 });
    const user = database.getUserByUsername('admin');
    const themeId = database.listThemes()[0].id;
    const sessions = [0, 1].map(() => database.createChatSession({ userId: user.id, themeId }));
    const input = { userId: user.id, name: 'one.csv', contentBase64 };
    const results = await Promise.all(sessions.map(session => uploads.uploadAsync({ ...input, sessionId: session.id })));
    await assert.rejects(uploads.uploadAsync({ ...input, sessionId: sessions[0].id }), { code: 'UPLOAD_QUOTA_EXCEEDED' });
    database.db.prepare('UPDATE workspace_artifacts SET status=0 WHERE id=?').run(results[0].file.artifactId);
    assert.ok((await uploads.uploadAsync({ ...input, sessionId: sessions[0].id, name: 'replacement.csv' })).file.artifactId);
    await assert.rejects(uploads.uploadAsync({ ...input, sessionId: sessions[1].id }), { code: 'UPLOAD_QUOTA_EXCEEDED' });
  } finally { database.close(); }
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
async function workerMessage(child, stderr) {
  const exited = new AbortController();
  const onExit = () => exited.abort();
  child.once('exit', onExit);
  if (child.exitCode !== null || child.signalCode !== null) exited.abort();
  try {
    const [message] = await once(child, 'message', {
      signal: AbortSignal.any([AbortSignal.timeout(30_000), exited.signal]),
    });
    return message;
  } catch (error) {
    throw new Error(`Upload worker ${child.pid} failed to reply: ${stderr()}`, { cause: error });
  } finally { child.off('exit', onExit); }
}

async function stopWorker(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(5_000) });
  child.kill();
  await exited;
}

for (const quota of [{ maxFilesPerSession: 1 }, { maxTotalBytesPerSession: Buffer.from(contentBase64, 'base64').length }]) {
  test(`independent SQLite processes serialize first-workspace admission (${Object.keys(quota)[0]})`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-admission-'));
    const filename = path.join(directory, 'platform.db');
    const database = new PlatformDatabase(filename);
    const children = [];
    try {
      const user = database.getUserByUsername('admin');
      const session = database.createChatSession({ userId: user.id, themeId: database.listThemes()[0].id });
      const completions = [];
      for (let i = 0; i < 2; i++) {
        const child = fork(new URL('./fixtures/uploadAdmissionWorker.mjs', import.meta.url), [filename, String(user.id), String(session.id), JSON.stringify(quota)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        children.push(child);
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk; });
        const ready = await workerMessage(child, () => stderr);
        assert.equal(ready.ready, true);
        // Observe failures immediately, even while the next worker starts.
        completions.push(workerMessage(child, () => stderr).catch(error => ({ status: 'worker-error', message: error.message })));
      }
      children.forEach(child => child.send('go'));
      const results = await Promise.all(completions);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, JSON.stringify(results));
      assert.equal(results.find(result => result.status === 'rejected').code, 'UPLOAD_QUOTA_EXCEEDED', JSON.stringify(results));
      const rows = database.db.prepare('SELECT metadata_json AS metadataJson FROM workspace_artifacts WHERE session_id=?').all(session.id);
      assert.equal(rows.filter(row => JSON.parse(row.metadataJson).source?.type === 'UPLOAD').length, 1);
    } finally {
      try {
        const stopped = await Promise.allSettled(children.map(stopWorker));
        const failure = stopped.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      } finally {
        database.close();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  });
}
