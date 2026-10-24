import assert from 'node:assert/strict';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';

function fixture(t) {
  const database = new PlatformDatabase(':memory:');
  t.after(() => database.close());
  const userId = database.getUserByUsername('east_manager').id;
  const otherId = database.getUserByUsername('admin').id;
  const themeId = database.listThemes()[0].id;
  const sessionId = database.createChatSession({ userId, themeId, title: 'repository' }).id;
  const workspace = database.ensureWorkspace({ userId, themeId, sessionId });
  const create = (extra = {}) => database.createWorkspaceArtifact({
    workspaceId: workspace.id, userId, sessionId, ...extra,
  });
  return { database, userId, otherId, themeId, sessionId, workspace, create };
}

test('workspace lookup and rename retain owner filtering and session identity', (t) => {
  const { database: db, userId, otherId, themeId, sessionId, workspace } = fixture(t);
  assert.equal(workspace.name, '问数工作区');
  assert.equal(db.ensureWorkspace({ userId, themeId, sessionId, name: 'ignored' }).id, workspace.id);
  assert.equal(db.getWorkspace(workspace.id, otherId), null);
  assert.equal(db.getWorkspaceBySession(sessionId, otherId), null);
  assert.equal(db.updateWorkspace(workspace.id, otherId, { name: 'forbidden' }), null);
  assert.equal(db.updateWorkspace(workspace.id, userId, { name: '  renamed  ' }).name, 'renamed');
  assert.equal(db.updateWorkspace(workspace.id, userId).name, 'renamed');
  assert.equal(db.getWorkspaceBySession(sessionId).id, workspace.id);
  assert.equal(db.getWorkspace(workspace.id).themeId, themeId);
});

test('artifact versions preserve metadata by default and replace it explicitly', (t) => {
  const { database: db, userId, otherId, workspace, create } = fixture(t);
  const initial = create({ metadata: { source: 'sales' }, payload: { rows: [1] } });
  assert.equal(initial.artifactType, 'TABLE');
  assert.equal(initial.title, '');
  assert.equal(initial.messageId, null);
  assert.equal(initial.conversationId, null);
  assert.equal(initial.currentVersion, 1);
  assert.deepEqual(initial.payload, { rows: [1] });
  assert.equal(db.getWorkspaceArtifact(initial.id, otherId), null);
  assert.throws(() => db.appendWorkspaceArtifactVersion({ artifactId: initial.id, userId: otherId }), /not found/);
  const next = db.appendWorkspaceArtifactVersion({ artifactId: initial.id, userId, payload: { rows: [2] } });
  assert.equal(next.currentVersion, 2);
  assert.deepEqual(next.metadata, { source: 'sales' });
  assert.deepEqual(next.payload, { rows: [2] });
  const last = db.appendWorkspaceArtifactVersion({ artifactId: initial.id, userId, metadata: {}, operation: { type: 'EDIT' } });
  assert.equal(last.currentVersion, 3);
  assert.deepEqual(last.metadata, {});
  assert.deepEqual(last.payload, {});
  const versions = db.db.prepare('SELECT version, operation_json AS operation, payload_json AS payload FROM artifact_versions WHERE artifact_id = ? ORDER BY version').all(initial.id);
  assert.deepEqual(versions.map((row) => [row.version, JSON.parse(row.operation), JSON.parse(row.payload)]), [
    [1, { type: 'CREATE' }, { rows: [1] }], [2, {}, { rows: [2] }], [3, { type: 'EDIT' }, {}],
  ]);
  assert.equal(db.getWorkspace(workspace.id, userId).artifactCount, 1);
});

test('artifact listing filters status and owner and orders by time then descending id', (t) => {
  const { database: db, userId, otherId, workspace, create } = fixture(t);
  const first = create({ metadata: { order: 1 } });
  const second = create({ metadata: { order: 2 } });
  const newer = create();
  const hidden = create();
  const foreign = create({ userId: otherId });
  db.db.prepare('UPDATE workspace_artifacts SET updated_at = ? WHERE workspace_id = ?').run('2026-01-01', workspace.id);
  db.db.prepare('UPDATE workspace_artifacts SET updated_at = ? WHERE id = ?').run('2026-02-01', newer.id);
  db.db.prepare('UPDATE workspace_artifacts SET status = 0 WHERE id = ?').run(hidden.id);
  const ownerRows = db.listWorkspaceArtifacts(workspace.id, userId);
  assert.deepEqual(ownerRows.map((row) => row.id), [newer.id, ...[first.id, second.id].sort().reverse()]);
  assert.deepEqual(ownerRows.find((row) => row.id === first.id).metadata, { order: 1 });
  assert.deepEqual(db.listWorkspaceArtifacts(workspace.id, otherId).map((row) => row.id), [foreign.id]);
  assert.equal(db.listWorkspaceArtifacts(workspace.id).length, 4);
  assert.equal(db.getWorkspace(workspace.id).artifactCount, 4);
});

test('malformed JSON reads use empty objects while JSON null remains null', (t) => {
  const { database: db, userId, workspace, create } = fixture(t);
  const artifact = create();
  db.db.prepare('UPDATE workspace_artifacts SET metadata_json = ? WHERE id = ?').run('{broken', artifact.id);
  db.db.prepare('UPDATE artifact_versions SET payload_json = ? WHERE artifact_id = ?').run('', artifact.id);
  assert.deepEqual(db.getWorkspaceArtifact(artifact.id, userId).metadata, {});
  assert.deepEqual(db.getWorkspaceArtifact(artifact.id).payload, {});
  assert.deepEqual(db.listWorkspaceArtifacts(workspace.id)[0].metadata, {});
  db.db.prepare('UPDATE workspace_artifacts SET metadata_json = ? WHERE id = ?').run('null', artifact.id);
  assert.equal(db.getWorkspaceArtifact(artifact.id).metadata, null);
  assert.deepEqual(create({ metadata: null, payload: null }).metadata, []);
});

test('failed initial version insert rolls back artifact and workspace timestamp', (t) => {
  const { database: db, workspace, create } = fixture(t);
  db.db.prepare('UPDATE workspaces SET updated_at = ? WHERE id = ?').run('sentinel', workspace.id);
  db.db.exec("CREATE TRIGGER fail_version BEFORE INSERT ON artifact_versions BEGIN SELECT RAISE(ABORT, 'version rejected'); END");
  assert.throws(() => create(), /version rejected/);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM workspace_artifacts').get().count, 0);
  assert.equal(db.getWorkspace(workspace.id).updatedAt, 'sentinel');
  db.db.exec('DROP TRIGGER fail_version');
  assert.equal(create().currentVersion, 1);
});

test('failed version metadata update rolls back inserted version and both timestamps', (t) => {
  const { database: db, userId, workspace, create } = fixture(t);
  const artifact = create({ metadata: { original: true } });
  db.db.exec("CREATE TRIGGER fail_workspace BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT, 'workspace rejected'); END");
  assert.throws(() => db.appendWorkspaceArtifactVersion({ artifactId: artifact.id, userId, metadata: { changed: true } }), /workspace rejected/);
  assert.deepEqual(db.getWorkspaceArtifact(artifact.id, userId), artifact);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS count FROM artifact_versions WHERE artifact_id = ?').get(artifact.id).count, 1);
  assert.equal(db.getWorkspace(workspace.id).updatedAt, artifact.updatedAt);
  db.db.exec('DROP TRIGGER fail_workspace');
  assert.equal(db.appendWorkspaceArtifactVersion({ artifactId: artifact.id, userId }).currentVersion, 2);
});

test('message binding deduplicates ids and excludes artifacts owned by another user', (t) => {
  const { database: db, userId, otherId, sessionId, create } = fixture(t);
  const first = create();
  const foreign = create({ userId: otherId });
  const message = db.appendChatMessage({ sessionId, userId, role: 'assistant', content: 'bind' });
  assert.equal(db.bindWorkspaceArtifactsToMessage({ userId, messageId: message.id }), 0);
  assert.equal(db.bindWorkspaceArtifactsToMessage({ artifactIds: [first.id, first.id, '', 'missing', foreign.id], userId, messageId: message.id }), 1);
  assert.equal(db.getWorkspaceArtifact(first.id).messageId, message.id);
  assert.equal(db.getWorkspaceArtifact(foreign.id).messageId, null);
});

test('message binding rolls back earlier updates when a later artifact update fails', (t) => {
  const { database: db, userId, sessionId, create } = fixture(t);
  const first = create();
  const second = create();
  const message = db.appendChatMessage({ sessionId, userId, role: 'assistant', content: 'bind' });
  db.db.exec(`CREATE TRIGGER fail_bind BEFORE UPDATE ON workspace_artifacts WHEN OLD.id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'binding rejected'); END`);
  assert.throws(() => db.bindWorkspaceArtifactsToMessage({ artifactIds: [first.id, second.id], userId, messageId: message.id }), /binding rejected/);
  assert.deepEqual(db.getWorkspaceArtifact(first.id), first);
  assert.deepEqual(db.getWorkspaceArtifact(second.id), second);
});
