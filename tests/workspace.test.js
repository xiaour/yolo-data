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
        ],
        rows: [
          { region: '华东', sale_amt: 10 },
          { region: '华南', sale_amt: 20 },
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
