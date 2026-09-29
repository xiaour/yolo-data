import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import { WorkspaceService } from '../src/workspace.js';
import { CodeExecutionService, validateCode } from '../src/codeExecution.js';

function createHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-code-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  const workspace = new WorkspaceService(database);
  const codeExecution = new CodeExecutionService({
    database,
    workspace,
    config: {
      projectRoot: directory,
      codeExecutionRoot: path.join(directory, 'code-runs'),
      pythonBin: 'python',
    },
  });
  const user = database.getUserByUsername('admin');
  const theme = database.listThemes()[0];
  const session = database.createChatSession({
    userId: user.id,
    themeId: theme.id,
    title: '代码执行测试',
  });
  const work = workspace.ensureForSession({
    userId: user.id,
    themeId: theme.id,
    sessionId: session.id,
    name: '代码执行测试',
  });
  return { directory, database, workspace, codeExecution, user, theme, session, work };
}

test('analysis code reads workspace artifacts and writes downloadable outputs', async () => {
  const harness = createHarness();
  try {
    const source = harness.database.createWorkspaceArtifact({
      workspaceId: harness.work.id,
      userId: harness.user.id,
      sessionId: harness.session.id,
      artifactType: 'TABLE',
      title: '销售明细',
      metadata: { rowCount: 2, columnCount: 2 },
      payload: {
        data: {
          columns: [
            { name: '省区', bizName: 'province' },
            { name: '销售额', bizName: 'amount', showType: 'NUMBER' },
          ],
          rows: [
            { province: '上海', amount: 10 },
            { province: '北京', amount: 20 },
          ],
        },
      },
    });
    const result = await harness.codeExecution.run({
      userId: harness.user.id,
      workspaceId: harness.work.id,
      sessionId: harness.session.id,
      inputArtifactIds: [source.id],
      outputFiles: ['summary.csv', 'summary.xlsx'],
      purpose: '汇总销售额并输出 Excel',
      artifactPrefix: '8月销售额汇总',
      code: `
import json
import pandas as pd
manifest = json.load(open('input/manifest.json', encoding='utf-8'))
source = manifest['inputs'][0]
df = pd.read_csv('input/' + source['files'][0])
amount_column = next(column['name'] for column in source['columns'] if column['bizName'] == 'amount')
summary = pd.DataFrame([{'total': int(df[amount_column].sum())}])
summary.to_csv('output/summary.csv', index=False)
summary.to_excel('output/summary.xlsx', index=False)
print('total', int(summary.iloc[0]['total']))
`,
    });

    assert.equal(result.success, true);
    assert.ok(result.codeArtifactId);
    assert.match(result.stdout, /total 30/);
    assert.deepEqual(
      result.outputs.map((item) => item.format).sort(),
      ['csv', 'xlsx'],
    );
    const csvOutput = result.outputs.find((item) => item.format === 'csv');
    const xlsxOutput = result.outputs.find((item) => item.format === 'xlsx');
    const exportedCsv = harness.workspace.exportArtifact({
      artifactId: csvOutput.artifactId,
      userId: harness.user.id,
      format: 'csv',
    });
    const exportedXlsx = harness.workspace.exportArtifact({
      artifactId: xlsxOutput.artifactId,
      userId: harness.user.id,
      format: 'xlsx',
    });
    assert.match(String(exportedCsv.content), /30/);
    assert.equal(exportedXlsx.content.subarray(0, 2).toString('ascii'), 'PK');
    const artifacts = harness.workspace.listArtifacts({
      workspaceId: harness.work.id,
      userId: harness.user.id,
    });
    const codeArtifact = artifacts.find((item) => item.id === result.codeArtifactId);
    const csvArtifact = artifacts.find((item) => item.id === csvOutput.artifactId);
    assert.equal(codeArtifact.artifactType, 'CODE');
    assert.equal(codeArtifact.title, '8月销售额汇总 · 分析代码');
    assert.equal(csvArtifact.title, '8月销售额汇总 · summary.csv');
    assert.deepEqual(codeArtifact.metadata.inputArtifactIds, [source.id]);
    assert.deepEqual(
      codeArtifact.metadata.outputArtifactIds.sort(),
      result.outputs.map((item) => item.artifactId).sort(),
    );
  } finally {
    harness.database.close();
  }
});

test('analysis code rejects network and process execution primitives', () => {
  assert.throws(
    () => validateCode('import subprocess\nsubprocess.run([\"whoami\"])'),
    /blocked/,
  );
  assert.throws(
    () => validateCode('open(r\"C:\\\\Windows\\\\win.ini\")'),
    /blocked/,
  );
});
