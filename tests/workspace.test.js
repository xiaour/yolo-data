import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import { WorkspaceService } from '../src/workspace.js';

function createContext() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-workspace-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  const user = database.getUserByUsername('east_manager');
  const theme = database.listThemes()[0];
  const session = database.createChatSession({
    userId: user.id,
    themeId: theme.id,
    title: '工作区测试',
  });
  return {
    database,
    workspace: new WorkspaceService(database),
    user,
    theme,
    session,
  };
}

test('workspace persists result artifacts and transformation versions', () => {
  const context = createContext();
  const workspace = context.workspace.ensureForSession({
    userId: context.user.id,
    themeId: context.theme.id,
    sessionId: context.session.id,
    name: '经营工作区',
  });
  const assistantMessage = context.database.appendChatMessage({
    sessionId: context.session.id,
    userId: context.user.id,
    role: 'assistant',
    content: '本月销售额为 30',
    result: { question: '本月销售额' },
  });
  const artifact = context.workspace.createResultArtifact({
    workspaceId: workspace.id,
    userId: context.user.id,
    sessionId: context.session.id,
    messageId: assistantMessage.id,
    conversationId: null,
    artifactType: 'QUERY_RESULT',
    source: { type: 'INDICATOR', id: '2', name: '含税销售金额' },
    answer: {
      question: '本月销售额',
      resolvedQuestion: '本月销售额',
      indicator: { id: '2', name: '含税销售金额' },
      data: {
        columns: [
          { name: '大区', bizName: 'region', showType: 'CATEGORY' },
          { name: '销售额', bizName: 'sale_amt', showType: 'NUMBER' },
          { name: 'average_value', bizName: 'avg_value', showType: 'NUMBER' },
        ],
        rows: [
          { region: '华东', sale_amt: 10, avg_value: 10 },
          { region: '华南', sale_amt: 20, avg_value: 20 },
        ],
      },
      chart: { type: 'bar' },
    },
  });

  assert.equal(artifact.currentVersion, 1);
  assert.equal(artifact.metadata.rowCount, 2);
  const storedMessage = context.database
    .listChatMessages(context.session.id, context.user.id)
    .find((message) => message.id === assistantMessage.id);
  assert.equal(storedMessage.result.artifactId, artifact.id);
  assert.equal(storedMessage.result.workspaceId, workspace.id);
  assert.equal(storedMessage.result.artifactTitle, '本月销售额');
  assert.equal(storedMessage.result.artifactType, 'QUERY_RESULT');

  const derived = context.workspace.transformArtifact({
    artifactId: artifact.id,
    userId: context.user.id,
    operation: 'add_summary_row',
    params: { position: 'top', label: '汇总' },
  });
  assert.notEqual(derived.id, artifact.id);
  assert.equal(derived.artifactType, 'DERIVED_RESULT');
  assert.equal(derived.title, '本月销售额 · 汇总行');
  assert.equal(derived.currentVersion, 1);
  assert.equal(derived.payload.data.rows[0].region, '汇总');
  assert.equal(derived.payload.data.rows[0].sale_amt, 30);
  assert.equal(derived.payload.data.rows[0].avg_value, 15);
  assert.deepEqual(derived.metadata.parentArtifactIds, [artifact.id]);

  const csv = context.workspace.exportArtifact({
    artifactId: derived.id,
    userId: context.user.id,
    format: 'csv',
  });
  assert.match(csv.filename, /\.csv$/);
  assert.match(csv.filename, /本月销售额_汇总行\.csv$/);
  assert.match(csv.content, /汇总,30/);

  const fileArtifact = context.workspace.createFileArtifact({
    workspaceId: workspace.id,
    userId: context.user.id,
    sessionId: context.session.id,
    title: '校验结果.txt',
    content: '通过',
    format: 'txt',
    mimeType: 'text/plain',
    inputArtifactIds: [artifact.id],
    runId: 'run-1',
  });
  context.workspace.bindArtifactsToMessage({
    artifactIds: [fileArtifact.id],
    userId: context.user.id,
    messageId: assistantMessage.id,
  });
  assert.equal(
    context.workspace.getArtifact({
      artifactId: fileArtifact.id,
      userId: context.user.id,
    }).messageId,
    assistantMessage.id,
  );
  assert.deepEqual(fileArtifact.metadata.inputArtifactIds, [artifact.id]);
});

test('workspace enforces user ownership', () => {
  const context = createContext();
  const workspace = context.workspace.ensureForSession({
    userId: context.user.id,
    themeId: context.theme.id,
    sessionId: context.session.id,
  });
  const otherUser = context.database.getUserByUsername('channel_analyst');

  assert.throws(
    () => context.workspace.listArtifacts({
      workspaceId: workspace.id,
      userId: otherUser.id,
    }),
    /workspace not found/,
  );
});

function createTransformService(database, mode) {
  const calls = { reads: 0, writes: 0 };
  if (mode === 'sync') return { service: new WorkspaceService(database), calls };
  const service = new WorkspaceService({
    isAsyncPlatformStore: true,
    async getWorkspaceArtifactAsync(...args) {
      calls.reads += 1;
      return database.getWorkspaceArtifact(...args);
    },
    async createWorkspaceArtifactAsync(...args) {
      calls.writes += 1;
      return database.createWorkspaceArtifact(...args);
    },
    getWorkspaceArtifact() { throw new Error('sync artifact read must not be called'); },
    createWorkspaceArtifact() { throw new Error('sync artifact write must not be called'); },
  });
  service.transformArtifact = () => { throw new Error('sync transform must not be called'); };
  return { service, calls };
}

for (const mode of ['sync', 'async']) {
  test(`workspace ${mode} transforms preserve source, numeric coercion and derived lineage`, async (t) => {
    const context = createContext();
    t.after(() => context.database.close());
    const workspace = context.workspace.ensureForSession({
      userId: context.user.id, themeId: context.theme.id, sessionId: context.session.id,
    });
    const source = context.workspace.createTableArtifact({
      workspaceId: workspace.id, userId: context.user.id, sessionId: context.session.id,
      title: 'numeric table', metadata: { custom: 'retained' },
      payload: { data: {
        columns: [
          { name: 'Label', bizName: 'label', showType: 'CATEGORY' },
          { name: 'Value', bizName: 'value', showType: 'NUMBER' },
          { name: 'Base', bizName: 'base', type: 'DECIMAL' },
        ],
        rows: [
          { label: 'blank', value: '', base: '2' },
          { label: 'null', value: null, base: 2 },
          { label: 'valid', value: '6', base: '3' },
          { label: 'invalid', value: 'bad', base: 2 },
          { label: 'zero base', value: 4, base: 0 },
        ],
      } },
    });
    const { service, calls } = createTransformService(context.database, mode);
    const transform = (artifactId, operation, params) => service[
      mode === 'async' ? 'transformArtifactAsync' : 'transformArtifact'
    ]({ artifactId, userId: context.user.id, operation, params });
    const ratio = await transform(source.id, 'add_ratio_column', {
      numerator: 'value', denominator: 'base', field: 'share',
    });
    assert.deepEqual(ratio.payload.data.rows.map((row) => row.share), [0, 0, 200, null, null]);
    if (mode === 'async') assert.deepEqual(calls, { reads: 1, writes: 1 });
    const summary = await transform(ratio.id, 'add_summary_row', { position: 'bottom' });
    assert.deepEqual(summary.payload.data.rows.at(-1), { label: '汇总', value: 10, base: 9, share: 200 });
    const sorted = await transform(ratio.id, 'sort', { field: 'share', direction: 'DESC' });
    assert.equal(sorted.payload.data.rows[0].label, 'valid');
    const filtered = await transform(sorted.id, 'filter_rows', { field: 'share', operator: '>', value: 0 });
    const renamed = await transform(filtered.id, 'rename_column', { field: 'share', name: '  Share  ' });
    const formatted = await transform(renamed.id, 'format_column', { field: 'share', decimals: '', unit: 'ratio' });
    const limited = await transform(formatted.id, 'limit_rows', { limit: 1 });
    assert.deepEqual(limited.payload.data.rows, [{ label: 'valid', value: '6', base: '3', share: 200 }]);
    assert.deepEqual(limited.payload.data.columns.at(-1), {
      name: 'Share', bizName: 'share', showType: 'NUMBER', type: 'DECIMAL', unit: 'ratio', decimals: 0,
    });
    assert.equal(limited.currentVersion, 1);
    assert.equal(limited.metadata.custom, 'retained');
    assert.equal(limited.metadata.rowCount, 1);
    assert.equal(limited.metadata.columnCount, 4);
    assert.deepEqual(limited.metadata.parentArtifactIds, [formatted.id]);
    assert.equal(limited.metadata.derivedFromArtifactId, formatted.id);
    assert.equal(limited.metadata.operation, 'limit_rows');
    assert.deepEqual(limited.metadata.operationParams, { limit: 1 });
    assert.deepEqual(context.workspace.getArtifact({ artifactId: source.id, userId: context.user.id }), source);
    assert.equal(context.workspace.listArtifacts({ workspaceId: workspace.id, userId: context.user.id }).length, 8);
    assert.equal(context.database.countRows('artifact_versions'), 8);
    if (mode === 'async') assert.deepEqual(calls, { reads: 7, writes: 7 });
  });

  test(`workspace ${mode} rejected transforms leave artifact history unchanged`, async (t) => {
    const context = createContext();
    t.after(() => context.database.close());
    const workspace = context.workspace.ensureForSession({
      userId: context.user.id, themeId: context.theme.id, sessionId: context.session.id,
    });
    const source = context.workspace.createTableArtifact({
      workspaceId: workspace.id, userId: context.user.id, sessionId: context.session.id,
      title: 'owned table', payload: { data: { columns: [], rows: [] } },
    });
    const { service, calls } = createTransformService(context.database, mode);
    const transform = async (userId, operation, params) => service[
      mode === 'async' ? 'transformArtifactAsync' : 'transformArtifact'
    ]({ artifactId: source.id, userId, operation, params });
    const otherUser = context.database.getUserByUsername('channel_analyst');
    await assert.rejects(transform(otherUser.id, 'limit_rows', { limit: 1 }), /workspace artifact not found/);
    await assert.rejects(transform(context.user.id, 'sort', {}), /sort requires field/);
    await assert.rejects(transform(context.user.id, 'unknown', {}), /unsupported artifact operation/);
    assert.equal(context.database.countRows('artifact_versions'), 1);
    if (mode === 'async') assert.deepEqual(calls, { reads: 3, writes: 0 });
    assert.deepEqual(context.workspace.listArtifacts({ workspaceId: workspace.id, userId: context.user.id }).map((artifact) => artifact.id), [source.id]);
    assert.deepEqual(context.workspace.getArtifact({ artifactId: source.id, userId: context.user.id }), source);
  });
}
