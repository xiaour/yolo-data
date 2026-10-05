import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import { WorkspaceService } from '../src/workspace.js';
import {
  buildProcessArtifact,
  createProcessArtifactRecorder,
} from '../src/processArtifacts.js';

const TABLE_RESULT = {
  dataset: { id: 7, name: '销售明细' },
  rowCount: 42,
  columns: [
    { name: '大区', bizName: 'region', showType: 'CATEGORY' },
    { name: '销售额', bizName: 'sale_amt', showType: 'NUMBER' },
  ],
  sampleRows: [{ region: '华东', sale_amt: 12 }],
  queryFingerprint: 'fp-1',
  workspaceArtifactId: 'artifact-full-1',
};

test('过程文件按工具环节生成，保留数据快照与血缘', () => {
  const draft = buildProcessArtifact({
    tool: 'query_business_dataset',
    result: TABLE_RESULT,
    step: {
      id: 'step-3',
      sequence: 3,
      title: '执行数据集查询',
      detail: '返回 42 行',
      stageCode: 'EXECUTE',
      durationMs: 128,
      startedAt: '2026-10-05T00:00:00.000Z',
    },
    previousArtifactId: 'artifact-step-2',
  });

  assert.match(draft.title, /^步骤 03 · 执行数据集查询 · 42 行$/);
  assert.equal(draft.metadata.dataKind, 'TABLE');
  assert.equal(draft.metadata.process, true);
  assert.equal(draft.metadata.sequence, 3);
  assert.equal(draft.metadata.rowCount, 42);
  assert.equal(draft.metadata.capturedRowCount, 1);
  assert.equal(draft.metadata.sampled, true);
  assert.equal(draft.payload.data.rows.length, 1);
  assert.equal(draft.payload.args, undefined, '不保存环节参数');
  assert.equal(draft.metadata.argsSummary, undefined, '不保存环节参数摘要');
  assert.deepEqual(
    draft.metadata.inputArtifactIds,
    ['artifact-step-2', 'artifact-full-1'],
  );
  assert.deepEqual(draft.metadata.outputArtifactIds, ['artifact-full-1']);
});

test('没有可读数据表的环节不落过程文件', () => {
  const contract = buildProcessArtifact({
    tool: 'compile_query_contract',
    result: { contractId: 'c-1', valid: true, coverage: [] },
    step: { sequence: 2, title: '编译查询契约' },
  });
  assert.equal(contract, null);

  const catalog = buildProcessArtifact({
    tool: 'search_indicators',
    result: { indicators: [{ id: '1', name: '指标' }] },
    step: { sequence: 1, title: '检索主题指标' },
  });
  assert.equal(catalog, null);

  const failed = buildProcessArtifact({
    tool: 'query_business_dataset',
    error: new Error('dataset permission denied'),
    step: { sequence: 4, title: '执行数据集查询', status: 'error' },
  });
  assert.equal(failed, null);

  const jsonOnly = buildProcessArtifact({
    tool: 'query_indicator',
    result: { rowCount: 0, columns: [], rows: [] },
    step: { sequence: 5, title: '执行指标查询' },
  });
  assert.equal(jsonOnly, null, '空表不算可读数据');
});

test('记录器按顺序串联上游过程文件并受步数上限约束', () => {
  const created = [];
  const service = {
    createProcessArtifact(input) {
      const artifact = { id: `artifact-${created.length + 1}`, ...input };
      created.push(artifact);
      return artifact;
    },
  };
  const events = [];
  const artifactIds = [];
  const record = createProcessArtifactRecorder({
    service,
    workspaceId: 11,
    userId: 3,
    sessionId: 5,
    emit: (event) => events.push(event),
    artifactIds,
    maxSteps: 2,
  });

  const catalog = record({ tool: 'search_indicators', result: { indicators: [] }, step: { sequence: 1 } });
  const first = record({ tool: 'query_indicator', result: TABLE_RESULT, step: { sequence: 2 } });
  const second = record({ tool: 'query_indicator', result: TABLE_RESULT, step: { sequence: 3 } });
  const third = record({ tool: 'query_indicator', result: TABLE_RESULT, step: { sequence: 4 } });

  assert.equal(catalog, null, '没有可读数据的环节不落盘，也不占用步数');
  assert.equal(created.length, 2, '超过上限后不再记录');
  assert.equal(third, null);
  assert.deepEqual(artifactIds, [first.id, second.id]);
  assert.deepEqual(
    second.metadata.inputArtifactIds,
    [first.id, 'artifact-full-1'],
    '过程文件同时记录上游步骤与被引用的结果产物',
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'workspace_updated');
});

test('过程文件写入工作区，并可作为 JSON 导出', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-process-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  const workspaceService = new WorkspaceService(database);
  const user = database.getUserByUsername('east_manager');
  const theme = database.listThemes()[0];
  const session = database.createChatSession({
    userId: user.id,
    themeId: theme.id,
    title: '过程文件测试',
  });
  const workspace = workspaceService.ensureForSession({
    userId: user.id,
    themeId: theme.id,
    sessionId: session.id,
    name: '经营工作区',
  });
  const record = createProcessArtifactRecorder({
    service: workspaceService,
    workspaceId: workspace.id,
    userId: user.id,
    sessionId: session.id,
  });

  const artifact = record({
    tool: 'query_business_dataset',
    result: TABLE_RESULT,
    step: { id: 'step-1', sequence: 1, title: '执行数据集查询', durationMs: 20 },
  });

  assert.equal(artifact.artifactType, 'PROCESS_STEP');
  const stored = workspaceService.getArtifact({ artifactId: artifact.id, userId: user.id });
  assert.equal(stored.metadata.process, true);
  assert.equal(stored.payload.data.columns.length, 2);

  const listed = workspaceService.listArtifacts({ workspaceId: workspace.id, userId: user.id });
  assert.ok(listed.some((item) => item.artifactType === 'PROCESS_STEP'));

  const json = workspaceService.exportArtifact({
    artifactId: artifact.id,
    userId: user.id,
    format: 'json',
  });
  assert.match(json.content, /"dataKind": "TABLE"/);

  // 历史库里可能仍有非表格过程文件，导出时不能生成空表格。
  const contractOnly = workspaceService.createProcessArtifact({
    workspaceId: workspace.id,
    userId: user.id,
    sessionId: session.id,
    title: '步骤 02 · 编译查询契约',
    metadata: { process: true, dataKind: 'CONTRACT' },
    payload: { result: { contractId: 'c-9' } },
  });
  assert.throws(
    () => workspaceService.exportArtifact({
      artifactId: contractOnly.id,
      userId: user.id,
      format: 'csv',
    }),
    /不含表格数据/,
  );
});
