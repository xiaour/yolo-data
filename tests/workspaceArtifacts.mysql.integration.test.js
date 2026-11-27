// Parity coverage for the async workspace/artifact store (src/platformWorkspaceArtifacts.js):
// the same behaviors tests/workspaceRepository.test.js locks in for the synchronous
// SQLite facade, exercised through the MySQL-backed store that attachAsyncRepositories
// wires up. Skipped unless a live MySQL is provided via YOLO_MYSQL_UPLOAD_TEST_*; CI
// runs it in the "MySQL persistence acceptance" job.
import assert from 'node:assert/strict';
import test from 'node:test';
import { initializePlatformDatabase } from '../src/platformDatabase.js';

const databaseName = process.env.YOLO_MYSQL_UPLOAD_TEST_DATABASE;

function mysqlConfig() {
  return {
    host: process.env.YOLO_MYSQL_UPLOAD_TEST_HOST ?? '127.0.0.1',
    port: Number(process.env.YOLO_MYSQL_UPLOAD_TEST_PORT ?? 3306), database: databaseName,
    user: process.env.YOLO_MYSQL_UPLOAD_TEST_USER ?? 'root',
    password: process.env.YOLO_MYSQL_UPLOAD_TEST_PASSWORD ?? 'test',
    connectionLimit: 6,
  };
}

// The admin user and the first theme come from the seed snapshot inside the CI
// service database. A second user is created per test so owner filtering can be
// exercised without touching seed rows; ON DELETE CASCADE makes two deletes
// clear everything a test created (sessions take workspaces, artifacts, versions
// and messages; the created user takes the foreign-owned artifact).
async function openStore(t, suffix) {
  const platform = await initializePlatformDatabase({ backend: 'mysql', mysql: mysqlConfig() });
  const database = platform.database;
  const user = (await database.listUsersAsync()).find((item) => item.username === 'admin');
  const other = await database.userRepository.saveUserAsync({
    username: `wa_other_${suffix}`,
    displayName: `Other ${suffix}`,
    role: 'ANALYST',
    status: 1,
    attributes: {},
  });
  const [theme] = await database.listThemesAsync();
  const session = await database.createChatSessionAsync({
    userId: user.id, themeId: theme.id, title: `wa ${suffix}`,
  });
  t.after(async () => {
    try {
      await database.execute('DELETE FROM chat_sessions WHERE id = ?', [session.id]);
    } finally {
      await database.execute('DELETE FROM app_users WHERE id = ?', [other.id]);
      await platform.close();
    }
  });
  return { database, user, other, theme, session };
}

test('async workspace lookup and rename retain owner filtering and session identity', { skip: !databaseName }, async (t) => {
  const { database, user, other, theme, session } = await openStore(t, 'lookup');
  const workspace = await database.ensureWorkspaceAsync({ userId: user.id, themeId: theme.id, sessionId: session.id });
  assert.equal(workspace.name, '问数工作区');
  assert.equal((await database.ensureWorkspaceAsync({
    userId: user.id, themeId: theme.id, sessionId: session.id, name: 'ignored',
  })).id, workspace.id);
  assert.equal(await database.getWorkspaceAsync(workspace.id, other.id), null);
  assert.equal(await database.getWorkspaceBySessionAsync(session.id, other.id), null);
  assert.equal(await database.updateWorkspaceAsync(workspace.id, other.id, { name: 'forbidden' }), null);
  assert.equal((await database.updateWorkspaceAsync(workspace.id, user.id, { name: '  renamed  ' })).name, 'renamed');
  assert.equal((await database.updateWorkspaceAsync(workspace.id, user.id)).name, 'renamed');
  assert.equal((await database.getWorkspaceBySessionAsync(session.id)).id, workspace.id);
  assert.equal((await database.getWorkspaceAsync(workspace.id)).themeId, theme.id);
});

test('async artifact versions preserve metadata by default and replace it explicitly', { skip: !databaseName }, async (t) => {
  const { database, user, other, theme, session } = await openStore(t, 'versions');
  const workspace = await database.ensureWorkspaceAsync({ userId: user.id, themeId: theme.id, sessionId: session.id });
  const initial = await database.createWorkspaceArtifactAsync({
    workspaceId: workspace.id, userId: user.id, sessionId: session.id,
    metadata: { source: 'sales' }, payload: { rows: [1] },
  });
  assert.equal(initial.artifactType, 'TABLE');
  assert.equal(initial.currentVersion, 1);
  assert.deepEqual(initial.payload, { rows: [1] });
  assert.equal(await database.getWorkspaceArtifactAsync(initial.id, other.id), null);
  await assert.rejects(
    () => database.appendWorkspaceArtifactVersionAsync({ artifactId: initial.id, userId: other.id }),
    /not found/,
  );
  const next = await database.appendWorkspaceArtifactVersionAsync({
    artifactId: initial.id, userId: user.id, payload: { rows: [2] },
  });
  assert.equal(next.currentVersion, 2);
  assert.deepEqual(next.metadata, { source: 'sales' });
  assert.deepEqual(next.payload, { rows: [2] });
  const last = await database.appendWorkspaceArtifactVersionAsync({
    artifactId: initial.id, userId: user.id, metadata: {}, operation: { type: 'EDIT' },
  });
  assert.equal(last.currentVersion, 3);
  assert.deepEqual(last.metadata, {});
  assert.deepEqual(last.payload, {});
  const versions = (await database.query(
    'SELECT version, operation_json AS operation, payload_json AS payload FROM artifact_versions WHERE artifact_id = ? ORDER BY version',
    [initial.id],
  )).map((row) => [row.version, JSON.parse(row.operation), JSON.parse(row.payload)]);
  assert.deepEqual(versions, [
    [1, { type: 'CREATE' }, { rows: [1] }], [2, {}, { rows: [2] }], [3, { type: 'EDIT' }, {}],
  ]);
  // Message binding keeps the artifact readable through its owning user only.
  const message = await database.appendChatMessageAsync({
    sessionId: session.id, userId: user.id, role: 'assistant', content: 'bind target',
  });
  assert.equal(await database.bindWorkspaceArtifactsToMessageAsync({
    artifactIds: [initial.id, 'missing'], userId: other.id, messageId: message.id,
  }), 0);
  assert.equal(await database.bindWorkspaceArtifactsToMessageAsync({
    artifactIds: [initial.id, 'missing'], userId: user.id, messageId: message.id,
  }), 1);
  assert.equal((await database.getWorkspaceArtifactAsync(initial.id, user.id)).messageId, message.id);
});

test('async artifact listing filters status and owner and orders by time then descending id', { skip: !databaseName }, async (t) => {
  const { database, user, other, theme, session } = await openStore(t, 'listing');
  const workspace = await database.ensureWorkspaceAsync({ userId: user.id, themeId: theme.id, sessionId: session.id });
  const create = async (extra = {}) => database.createWorkspaceArtifactAsync({
    workspaceId: workspace.id, userId: user.id, sessionId: session.id, ...extra,
  });
  const first = await create({ metadata: { order: 1 } });
  const second = await create({ metadata: { order: 2 } });
  const newer = await create();
  const hidden = await create();
  const foreign = await create({ userId: other.id });
  await database.execute('UPDATE workspace_artifacts SET updated_at = ? WHERE workspace_id = ?', ['2026-01-01', workspace.id]);
  await database.execute('UPDATE workspace_artifacts SET updated_at = ? WHERE id = ?', ['2026-02-01', newer.id]);
  await database.execute('UPDATE workspace_artifacts SET status = 0 WHERE id = ?', [hidden.id]);
  const ownerRows = await database.listWorkspaceArtifactsAsync(workspace.id, user.id);
  assert.deepEqual(ownerRows.map((row) => row.id), [newer.id, ...[first.id, second.id].sort().reverse()]);
  assert.deepEqual(ownerRows.find((row) => row.id === first.id).metadata, { order: 1 });
  assert.deepEqual((await database.listWorkspaceArtifactsAsync(workspace.id, other.id)).map((row) => row.id), [foreign.id]);
  assert.equal((await database.listWorkspaceArtifactsAsync(workspace.id)).length, 4);
  assert.equal((await database.getWorkspaceAsync(workspace.id)).artifactCount, 4);
});

test('async malformed JSON reads use empty objects while JSON null remains null', { skip: !databaseName }, async (t) => {
  const { database, user, theme, session } = await openStore(t, 'json');
  const workspace = await database.ensureWorkspaceAsync({ userId: user.id, themeId: theme.id, sessionId: session.id });
  const artifact = await database.createWorkspaceArtifactAsync({
    workspaceId: workspace.id, userId: user.id, sessionId: session.id,
  });
  await database.execute('UPDATE workspace_artifacts SET metadata_json = ? WHERE id = ?', ['{broken', artifact.id]);
  await database.execute('UPDATE artifact_versions SET payload_json = ? WHERE artifact_id = ?', ['', artifact.id]);
  assert.deepEqual((await database.getWorkspaceArtifactAsync(artifact.id, user.id)).metadata, {});
  assert.deepEqual((await database.getWorkspaceArtifactAsync(artifact.id)).payload, {});
  assert.deepEqual((await database.listWorkspaceArtifactsAsync(workspace.id))[0].metadata, {});
  await database.execute('UPDATE workspace_artifacts SET metadata_json = ? WHERE id = ?', ['null', artifact.id]);
  assert.equal((await database.getWorkspaceArtifactAsync(artifact.id)).metadata, null);
});

test('async artifact creation and version updates roll back atomically on MySQL', { skip: !databaseName }, async (t) => {
  const { database, user, theme, session } = await openStore(t, 'rollback');
  const workspace = await database.ensureWorkspaceAsync({ userId: user.id, themeId: theme.id, sessionId: session.id });
  // Failed initial version insert rolls back the artifact row and the workspace timestamp.
  await database.execute('UPDATE workspaces SET updated_at = ? WHERE id = ?', ['sentinel', workspace.id]);
  await database.execute('DROP TRIGGER IF EXISTS wa_fail_version');
  await database.execute(
    'CREATE TRIGGER wa_fail_version BEFORE INSERT ON artifact_versions FOR EACH ROW '
    + "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'version rejected'",
  );
  const beforeCreate = (await database.query(
    'SELECT COUNT(*) AS n FROM workspace_artifacts WHERE workspace_id = ?', [workspace.id],
  ))[0].n;
  try {
    await assert.rejects(
      () => database.createWorkspaceArtifactAsync({
        workspaceId: workspace.id, userId: user.id, sessionId: session.id,
      }),
      /version rejected/,
    );
  } finally {
    await database.execute('DROP TRIGGER wa_fail_version');
  }
  assert.equal((await database.query(
    'SELECT COUNT(*) AS n FROM workspace_artifacts WHERE workspace_id = ?', [workspace.id],
  ))[0].n, Number(beforeCreate));
  assert.equal((await database.getWorkspaceAsync(workspace.id)).updatedAt, 'sentinel');
  // Failed version metadata update rolls back the inserted version and both timestamps.
  const artifact = await database.createWorkspaceArtifactAsync({
    workspaceId: workspace.id, userId: user.id, sessionId: session.id, metadata: { original: true },
  });
  await database.execute('UPDATE workspaces SET updated_at = ? WHERE id = ?', ['sentinel', workspace.id]);
  await database.execute('DROP TRIGGER IF EXISTS wa_fail_workspace');
  await database.execute(
    'CREATE TRIGGER wa_fail_workspace BEFORE UPDATE ON workspaces FOR EACH ROW '
    + "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'workspace rejected'",
  );
  try {
    await assert.rejects(
      () => database.appendWorkspaceArtifactVersionAsync({
        artifactId: artifact.id, userId: user.id, metadata: { changed: true },
      }),
      /workspace rejected/,
    );
  } finally {
    await database.execute('DROP TRIGGER wa_fail_workspace');
  }
  assert.deepEqual((await database.getWorkspaceArtifactAsync(artifact.id, user.id)).metadata, { original: true });
  assert.equal((await database.query(
    'SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id = ?', [artifact.id],
  ))[0].n, 1);
  assert.equal((await database.getWorkspaceAsync(workspace.id)).updatedAt, 'sentinel');
  assert.equal((await database.appendWorkspaceArtifactVersionAsync({
    artifactId: artifact.id, userId: user.id,
  })).currentVersion, 2);
});
