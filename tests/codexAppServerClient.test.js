import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { CodexAppServerClient } from '../src/codexAppServerClient.js';
import { buildCodexRuntime, CodexAppServerHarness } from '../src/codexHarness.js';

function fakeCodexProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  let buffer = '';
  const writes = [];
  const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      writes.push(message);
      if (message.method === 'initialize') {
        send({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'fake-codex' } });
      } else if (message.method === 'thread/start') {
        send({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-1' } } });
      } else if (message.method === 'turn/start') {
        send({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-1' } } });
        setImmediate(() => {
          send({
            jsonrpc: '2.0', method: 'turn/plan/updated',
            params: { threadId: 'thread-1', turnId: 'turn-1', plan: { steps: [{ id: 'p1', status: 'in_progress', step: '查找指标' }] } },
          });
          send({
            jsonrpc: '2.0', method: 'item/started',
            params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'reason-1', type: 'reasoning' } },
          });
          send({
            jsonrpc: '2.0', method: 'item/completed',
            params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'reason-1', type: 'reasoning', status: 'completed', text: '私有思维不应展示' } },
          });
          send({
            jsonrpc: '2.0', id: 900, method: 'item/tool/call',
            params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', tool: 'get_metric', arguments: { id: 7 } },
          });
        });
      } else if (message.id === 900 && message.result) {
        send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer-1', delta: '销售额为 42。' } });
        send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } });
      }
    }
  });
  return { child, writes };
}

test('Codex app-server client completes handshake and bridges dynamic tools', async () => {
  const fake = fakeCodexProcess();
  const client = new CodexAppServerClient({ spawnImpl: () => fake.child });
  const toolCalls = [];
  const events = [];
  const result = await client.runTurn({
    threadParams: { dynamicTools: [] },
    turnParams: { input: [{ type: 'text', text: 'question', text_elements: [] }] },
    executeTool: async (name, args) => {
      toolCalls.push({ name, args });
      return { value: 42 };
    },
    onEvent: (event) => events.push(event),
    timeoutMs: 2_000,
  });
  assert.equal(result.content, '销售额为 42。');
  assert.deepEqual(toolCalls, [{ name: 'get_metric', args: { id: 7 } }]);
  assert.ok(fake.writes.some((item) => item.method === 'initialized'));
  assert.equal(fake.writes.find((item) => item.id === 900).result.success, true);
  assert.equal(events.find((event) => event.type === 'codex_plan_updated').steps[0].title, '查找指标');
  assert.equal(events.find((event) => event.type === 'codex_item').title, '分析问题');
  assert.doesNotMatch(JSON.stringify(events), /私有思维不应展示/);
  client.close();
});

test('Codex harness exposes YOLO tools as dynamic tools in a read-only thread', async () => {
  let captured;
  const client = {
    runTurn: async (request) => {
      captured = request;
      return { content: 'done', trace: [], threadId: 't', turnId: 'u' };
    },
    close() {},
  };
  const harness = new CodexAppServerHarness({ enabled: true, cwd: process.cwd(), client });
  const result = await harness.run({
    messages: [
      { role: 'system', content: 'system policy' },
      { role: 'user', content: 'question' },
    ],
    tools: [{
      type: 'function',
      function: { name: 'resolve_query', description: 'compile', parameters: { type: 'object' } },
    }],
    executeTool: async () => ({}),
  });
  assert.equal(result.content, 'done');
  assert.equal(captured.threadParams.sandbox, 'read-only');
  assert.equal(captured.threadParams.approvalPolicy, 'never');
  assert.equal(captured.threadParams.ephemeral, false);
  assert.equal(captured.threadParams.dynamicTools[0].name, 'resolve_query');
  assert.match(captured.threadParams.baseInstructions, /system policy/);
});

test('Codex app-server resumes an existing durable thread with updated instructions', async () => {
  const client = new CodexAppServerClient();
  const calls = [];
  client.ensureStarted = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'turn/start') {
      setImmediate(() => client.handleNotification('turn/completed', {
        threadId: params.threadId,
        turn: { id: 'turn-resumed', status: 'completed' },
      }));
      return { turn: { id: 'turn-resumed' } };
    }
    return { thread: { id: params.threadId } };
  };
  const ready = [];
  const result = await client.runTurn({
    threadId: 'thread-existing',
    threadParams: {
      baseInstructions: 'latest theme prompt',
      developerInstructions: 'developer policy',
      cwd: process.cwd(),
      dynamicTools: [{ name: 'not-valid-on-resume' }],
      ephemeral: false,
    },
    turnParams: { input: [{ type: 'text', text: 'follow-up', text_elements: [] }] },
    executeTool: async () => ({}),
    onThreadReady: async (threadId, state) => ready.push({ threadId, ...state }),
    timeoutMs: 2_000,
  });
  const resume = calls.find((call) => call.method === 'thread/resume');
  assert.equal(result.threadId, 'thread-existing');
  assert.equal(resume.params.baseInstructions, 'latest theme prompt');
  assert.equal(resume.params.excludeTurns, true);
  assert.equal(Object.hasOwn(resume.params, 'dynamicTools'), false);
  assert.equal(calls.some((call) => call.method === 'thread/start'), false);
  assert.deepEqual(ready, [{ threadId: 'thread-existing', created: false }]);
});

test('Codex app-server replaces a persisted thread only when resume reports it missing', async () => {
  const client = new CodexAppServerClient();
  const calls = [];
  client.ensureStarted = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/resume') throw new Error('thread not found');
    if (method === 'thread/start') return { thread: { id: 'thread-replacement' } };
    if (method === 'turn/start') {
      setImmediate(() => client.handleNotification('turn/completed', {
        threadId: params.threadId,
        turn: { id: 'turn-replacement', status: 'completed' },
      }));
      return { turn: { id: 'turn-replacement' } };
    }
    return null;
  };
  const ready = [];
  const result = await client.runTurn({
    threadId: 'thread-deleted',
    threadParams: { ephemeral: false },
    turnParams: { input: [{ type: 'text', text: 'question', text_elements: [] }] },
    newThreadTurnParams: { input: [{ type: 'text', text: 'restored history and question', text_elements: [] }] },
    executeTool: async () => ({}),
    onThreadReady: async (threadId, state) => ready.push({ threadId, ...state }),
    timeoutMs: 2_000,
  });
  assert.equal(result.threadId, 'thread-replacement');
  assert.deepEqual(ready, [{ threadId: 'thread-replacement', created: true }]);
  assert.equal(
    calls.find((call) => call.method === 'turn/start').params.input[0].text,
    'restored history and question',
  );
});

test('Codex harness seeds YOLO history once and then sends only the current original question', async () => {
  const captured = [];
  const client = {
    runTurn: async (request) => {
      captured.push(request);
      return { content: 'done', trace: [], threadId: request.threadId ?? 'thread-created', turnId: 'turn' };
    },
    close() {},
  };
  const harness = new CodexAppServerHarness({ enabled: true, cwd: process.cwd(), client });
  const base = {
    messages: [{ role: 'system', content: 'theme prompt' }, { role: 'user', content: 'locally expanded question' }],
    tools: [],
    executeTool: async () => ({}),
  };
  await harness.run({
    ...base,
    metadata: {
      question: '按省区分组呢',
      codexBootstrapHistory: [
        { role: 'user', content: '上个月销售额是多少' },
        { role: 'assistant', content: '上个月销售额为 100 万元' },
      ],
    },
  });
  await harness.run({
    ...base,
    metadata: {
      question: '再看华东地区',
      codexThreadId: 'thread-created',
      codexBootstrapHistory: [{ role: 'user', content: 'must not be duplicated' }],
    },
  });
  const firstInput = captured[0].turnParams.input[0].text;
  const secondInput = captured[1].turnParams.input[0].text;
  assert.match(firstInput, /上个月销售额是多少/);
  assert.match(firstInput, /按省区分组呢/);
  assert.equal(secondInput, '再看华东地区');
  assert.doesNotMatch(secondInput, /must not be duplicated/);
  assert.equal(captured[1].threadId, 'thread-created');
});

test('Codex runtime uses login-free local providers by default', () => {
  const runtime = buildCodexRuntime({ provider: 'ollama', env: { KEEP: 'yes' } });
  assert.deepEqual(runtime.args, [
    'app-server', '--stdio', '-c', 'model_provider="ollama"',
  ]);
  assert.equal(runtime.env.KEEP, 'yes');
  assert.equal(runtime.env.YOLO_CODEX_PROVIDER_API_KEY, undefined);
});

test('Codex custom provider receives its API key through the child environment', () => {
  const runtime = buildCodexRuntime({
    provider: 'custom',
    providerBaseUrl: 'https://gateway.example/v1',
    providerApiKey: 'server-secret',
    wireApi: 'responses',
    env: {},
  });
  assert.equal(runtime.env.YOLO_CODEX_PROVIDER_API_KEY, 'server-secret');
  assert.ok(runtime.args.includes('model_provider="yolo_runtime"'));
  assert.ok(runtime.args.includes('model_providers.yolo_runtime.requires_openai_auth=false'));
  assert.ok(runtime.args.includes('model_providers.yolo_runtime.base_url="https://gateway.example/v1"'));
  assert.ok(runtime.args.includes('model_providers.yolo_runtime.env_key="YOLO_CODEX_PROVIDER_API_KEY"'));
});

test('Codex local provider is available only when its configured model is running', async () => {
  const readyHarness = new CodexAppServerHarness({
    enabled: true,
    provider: 'ollama',
    model: 'gpt-oss:20b',
    cwd: process.cwd(),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ models: [{ name: 'gpt-oss:20b' }] }),
    }),
  });
  const missingHarness = new CodexAppServerHarness({
    enabled: true,
    provider: 'ollama',
    model: 'gpt-oss:20b',
    cwd: process.cwd(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }),
  });
  assert.equal(await readyHarness.initialize(), true);
  assert.equal(await missingHarness.initialize(), false);
  readyHarness.close();
  missingHarness.close();
});

