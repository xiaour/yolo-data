import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodeExecutionService } from '../src/codeExecution.js';

test('real isolated container exports analysis without reading a host-only canary', {
  skip: process.env.YOLO_SANDBOX_TEST !== '1', timeout: 90_000,
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-live-sandbox-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const canary = path.join(directory, 'host-private.txt');
  fs.writeFileSync(canary, 'HOST_ONLY_CANARY');
  const codes = [...canary].map(char => char.charCodeAt(0));
  const files = [];
  const service = new CodeExecutionService({ workspace: {
    getArtifact: () => ({ id: 'table', artifactType: 'TABLE', payload: {
      data: { columns: [{ name: 'amount' }], rows: [{ amount: 10 }, { amount: 20 }] },
    } }),
    createCodeArtifact: () => ({ id: 'code' }),
    createFileArtifact: artifact => { files.push(artifact); return { id: 'export-' + files.length }; },
  }, config: { codeExecutionRoot: path.join(directory, 'runs'), codeExecution: {
    backend: process.env.SANDBOX_BACKEND === 'podman' ? 'podman' : 'container',
    image: process.env.SANDBOX_IMAGE ?? 'yolo-data-sandbox:local',
  } } });
  const result = await service.run({ userId: 1, sessionId: 1, workspaceId: 1,
    inputArtifactIds: ['table'], timeoutSeconds: 30, code: [
      'import pandas as pd',
      'df = pd.read_csv("input/1_table.csv")',
      'pd.DataFrame([{"total": df["amount"].sum()}]).to_csv("output/summary.csv", index=False)',
      'pd.DataFrame([{"total": df["amount"].sum()}]).to_excel("output/summary.xlsx", index=False)',
      'try:',
      '    print(_original_open("".join(map(chr, ' + JSON.stringify(codes) + '))).read())',
      'except OSError:',
      '    print("host-file-blocked")',
    ].join('\n') });
  assert.equal(result.success, true, result.stderr);
  assert.match(result.stdout, /host-file-blocked/);
  assert.ok(!result.stdout.includes('HOST_ONLY_CANARY'));
  assert.deepEqual(result.outputs.map(file => file.format).sort(), ['csv', 'xlsx']);
  assert.match(files.find(file => file.format === 'csv').content, /30/);
});
