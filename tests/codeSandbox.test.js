import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOutputCapture } from '../src/analysisProcess.js';
import { resolveSandboxConfig, assertSandboxAllowed, runContainerAnalysis } from '../src/codeSandbox.js';
import { CodeExecutionService } from '../src/codeExecution.js';
import { loadConfig } from '../src/config.js';

function temporaryRun(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-isolation-'));
  fs.mkdirSync(path.join(root, 'output'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('default analysis backend is isolated and loadConfig carries sandbox settings', () => {
  assert.equal(resolveSandboxConfig({}, {}).backend, 'container');
  assert.equal(loadConfig({}).codeExecution.backend, 'container');
  const configured = loadConfig({ SANDBOX_BACKEND: 'podman', SANDBOX_IMAGE: 'custom:local',
    SANDBOX_SECCOMP: '/custom/seccomp.json' });
  assert.equal(configured.codeExecution.backend, 'podman');
  assert.equal(configured.codeExecution.image, 'custom:local');
  assert.equal(configured.codeExecution.seccompProfile, '/custom/seccomp.json');
  assert.throws(() => assertSandboxAllowed({ backend: 'contianer' }), { code: 'SANDBOX_BACKEND_INVALID' });
  assert.throws(() => assertSandboxAllowed({ backend: 'inprocess' }), { code: 'UNSAFE_SANDBOX_DISABLED' });
  assert.doesNotThrow(() => assertSandboxAllowed({ backend: 'inprocess', allowUnsafeInprocess: true }));
});

test('the audited original-open escape is refused before unsafe host execution', async t => {
  const directory = temporaryRun(t);
  const canary = path.join(directory, 'outside.txt');
  fs.writeFileSync(canary, 'must-stay-private');
  const root = path.join(directory, 'runs');
  const service = new CodeExecutionService({ workspace: {}, config: {
    codeExecutionRoot: root, codeExecution: { backend: 'inprocess', allowUnsafeInprocess: false },
  } });
  const codes = [...canary].map(char => char.charCodeAt(0));
  await assert.rejects(service.run({ userId: 1, code:
    'print(_original_open("".join(map(chr, ' + JSON.stringify(codes) + '))).read())' }),
  { code: 'UNSAFE_SANDBOX_DISABLED' });
  assert.equal(fs.existsSync(root), false);
});

test('container analysis exposes only current inputs and output, with no network or capabilities', async t => {
  const runRoot = temporaryRun(t);
  let captured;
  const result = await runContainerAnalysis({ runRoot, timeoutSeconds: 2, env: {},
    sandbox: resolveSandboxConfig({}, {}), run: async options => {
      captured = options;
      return { exitCode: 0, timedOut: false, stdout: 'done', stderr: '' };
    } });
  assert.equal(result.exitCode, 0);
  assert.equal(captured.command, 'docker');
  const args = captured.args;
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.equal(args[args.indexOf('--user') + 1], '65534:65534');
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('no-new-privileges'));
  assert.ok(args.includes(runRoot + ':/work:ro'));
  assert.ok(args.includes(path.join(runRoot, 'output') + ':/work/output:rw'));
  assert.ok(!args.includes('seccomp=unconfined'));
  assert.deepEqual(args.slice(-5), ['yolo-data-sandbox:local', 'python', '-I', '-B', 'run.py']);
});

test('timeout removes the exact container and fails visibly when cleanup fails', async t => {
  const runRoot = temporaryRun(t);
  const calls = [];
  await runContainerAnalysis({ runRoot, timeoutSeconds: 2, env: {},
    sandbox: resolveSandboxConfig({ codeExecution: { backend: 'podman' } }, {}),
    run: async options => {
      calls.push(options);
      return calls.length === 1 ? { exitCode: null, timedOut: true, stderr: '' }
        : { exitCode: 0, timedOut: false, stderr: '' };
    } });
  const name = calls[0].args[calls[0].args.indexOf('--name') + 1];
  assert.equal(calls[0].command, 'podman');
  assert.deepEqual(calls[1].args, ['rm', '--force', name]);
  assert.match(name, /^yolo-analysis-/);
  await assert.rejects(runContainerAnalysis({ runRoot, timeoutSeconds: 2, env: {},
    sandbox: resolveSandboxConfig({}, {}), run: async options => options.args[0] === 'run'
      ? { exitCode: null, timedOut: true, stderr: '' }
      : { exitCode: 1, timedOut: false, stderr: 'daemon unavailable' } }),
  { code: 'SANDBOX_CLEANUP_FAILED' });
});

test('a failed sandbox never falls back to host Python or publishes partial output', async t => {
  const runRoot = temporaryRun(t);
  let imported = false;
  const service = new CodeExecutionService({ workspace: { createCodeArtifact: () => ({ id: 'code' }) },
    config: { codeExecutionRoot: runRoot, codeExecution: { backend: 'container' } } });
  service.runContainerProcess = async () => ({ exitCode: 1, timedOut: false,
    stdout: '', stderr: 'daemon unavailable', durationMs: 1 });
  service.importOutputs = async () => { imported = true; return []; };
  const result = await service.run({ userId: 1, sessionId: 1, code: 'print(1)' });
  assert.equal(result.success, false);
  assert.equal(imported, false);
  assert.deepEqual(result.outputs, []);
});

test('stdout and stderr byte budgets cannot be bypassed by large or small chunks', () => {
  const output = createOutputCapture(10);
  for (let i = 0; i < 10; i++) output.push(Buffer.from('abc'));
  assert.equal(output.text(), 'abcabcabca');
  const large = createOutputCapture(10);
  large.push(Buffer.alloc(1000, 'x'));
  large.push(Buffer.from('tail'));
  assert.equal(Buffer.byteLength(large.text()), 10);
});
