import assert from 'node:assert/strict';
import test from 'node:test';
import { initializePlatformDatabase } from '../src/platformDatabase.js';
import { WorkspaceService } from '../src/workspace.js';
import { UploadService } from '../src/uploads.js';

const databaseName = process.env.YOLO_MYSQL_UPLOAD_TEST_DATABASE;
test('live MySQL upload admission serializes count, bytes, first workspace and rollback', { skip: !databaseName }, async () => {
  // The opt-in database belongs to this CI service and contains synthetic data.
  const platform = await initializePlatformDatabase({ backend: 'mysql', mysql: {
    host: process.env.YOLO_MYSQL_UPLOAD_TEST_HOST ?? '127.0.0.1',
    port: Number(process.env.YOLO_MYSQL_UPLOAD_TEST_PORT ?? 3306),
    database: databaseName, user: process.env.YOLO_MYSQL_UPLOAD_TEST_USER ?? 'root',
    password: process.env.YOLO_MYSQL_UPLOAD_TEST_PASSWORD ?? 'test', connectionLimit: 6,
  } });
  const database = platform.database;
  try {
    const user = (await database.listUsersAsync()).find(user => user.username === 'admin');
    const [theme] = await database.listThemesAsync();
    const workspace = new WorkspaceService(database);
    const contentBase64 = Buffer.from('code,amount\na,1\n').toString('base64');
    for (const existing of [false, true]) {
      for (const limits of [{ maxFilesPerSession: 1 }, { maxTotalBytesPerSession: Buffer.from(contentBase64, 'base64').length }]) {
        const session = await database.createChatSessionAsync({ userId: user.id, themeId: theme.id, title: 'synthetic admission test' });
        if (existing) await workspace.ensureForSessionAsync({ userId: user.id, themeId: theme.id, sessionId: session.id });
        const uploads = new UploadService({ database, workspace, config: { uploads: limits } });
        const input = { userId: user.id, sessionId: session.id, contentBase64 };
        const results = await Promise.allSettled(Array.from({ length: 4 }, (_, index) => uploads.uploadAsync({ ...input, name: `${index}.csv` })));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        for (const result of results.filter(result => result.status === 'rejected')) assert.equal(result.reason.code, 'UPLOAD_QUOTA_EXCEEDED');
        const [count] = await database.query('SELECT COUNT(*) AS n FROM workspaces WHERE session_id=?', [session.id]);
        assert.equal(Number(count.n), 1);
        const record = await database.getWorkspaceBySessionAsync(session.id, user.id);
        const raw = (await workspace.listArtifactsAsync({ workspaceId: record.id, userId: user.id })).filter(a => a.metadata?.source?.type === 'UPLOAD');
        assert.equal(raw.length, 1);
        await database.execute('UPDATE workspace_artifacts SET status=0 WHERE id=?', [raw[0].id]);
        assert.ok((await uploads.uploadAsync({ ...input, name: 'replacement.csv' })).file.artifactId);
      }
    }
    const uploads = new UploadService({ database, workspace, config: { uploads: { maxFilesPerSession: 1 } } });
    const sessions = await Promise.all([0, 1].map(() => database.createChatSessionAsync({ userId: user.id, themeId: theme.id, title: 'independent session' })));
    assert.equal((await Promise.all(sessions.map(session => uploads.uploadAsync({ userId: user.id, sessionId: session.id, name: 'one.csv', contentBase64 })))).length, 2);
    const session = await database.createChatSessionAsync({ userId: user.id, themeId: theme.id, title: 'rollback test' });
    await database.execute("CREATE TRIGGER fail_upload_version BEFORE INSERT ON artifact_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced version failure'");
    try {
      await assert.rejects(uploads.uploadAsync({ userId: user.id, sessionId: session.id, name: 'one.csv', contentBase64 }), /forced version failure/);
      assert.equal(await database.getWorkspaceBySessionAsync(session.id, user.id), null);
    } finally { await database.execute('DROP TRIGGER fail_upload_version'); }
    assert.ok((await uploads.uploadAsync({ userId: user.id, sessionId: session.id, name: 'retry.csv', contentBase64 })).file.artifactId);
  } finally { await platform.close(); }
});
