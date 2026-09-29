import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HarnessFactory,
  OpenAICompatibleDeepSeekHarness,
} from '../src/harness.js';

test('harness factory builds an agent-scoped model runtime', async () => {
  process.env.TEST_AGENT_LLM_KEY = 'agent-key';
  let capturedBody = null;
  const factory = new HarnessFactory({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.1,
    maxTokens: 0,
    timeoutMs: 5_000,
    maxToolRounds: 4,
  }, async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: '已按主题模型配置完成分析。',
        },
      }],
      usage: { total_tokens: 42 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  const harness = factory.forTheme({
    provider: 'openai-compatible',
    model: 'deepseek-reasoner',
    baseUrl: 'https://agent.example/v1',
    apiKeyEnv: 'TEST_AGENT_LLM_KEY',
    temperature: 0.4,
  });
  const result = await harness.run({
    messages: [{ role: 'user', content: '测试' }],
    tools: [],
    executeTool: async () => ({}),
  });

  assert.equal(harness.mode, 'deepseek');
  assert.equal(harness.model, 'deepseek-reasoner');
  assert.equal(capturedBody.model, 'deepseek-reasoner');
  assert.equal(capturedBody.temperature, 0.4);
  assert.equal(result.content, '已按主题模型配置完成分析。');
  delete process.env.TEST_AGENT_LLM_KEY;
});

test('harness factory decrypts a theme-scoped API key', async () => {
  let authorization = null;
  const factory = new HarnessFactory({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.1,
    maxTokens: 0,
    timeoutMs: 5_000,
    maxToolRounds: 2,
  }, async (_url, options) => {
    authorization = options.headers.Authorization;
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }, null, {
    decrypt: () => 'stored-theme-key',
  });

  const harness = factory.forTheme({
    model: 'deepseek-chat',
    apiKeyEncrypted: 'ENC:test',
  });
  await harness.run({
    messages: [{ role: 'user', content: '测试' }],
    tools: [],
    executeTool: async () => ({}),
  });

  assert.equal(harness.mode, 'deepseek');
  assert.equal(authorization, 'Bearer stored-theme-key');
});

test('harness stops after a tool locks the first valid result', async () => {
  let requestCount = 0;
  const harness = new OpenAICompatibleDeepSeekHarness({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'test-key',
    model: 'deepseek-chat',
    fetchImpl: async () => {
      requestCount += 1;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: {
                name: 'query_indicator',
                arguments: '{"indicatorId":"2"}',
              },
            }],
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const result = await harness.run({
    messages: [{ role: 'user', content: '查询含税销售金额' }],
    tools: [],
    executeTool: async () => ({
      summary: '锁定结果',
      finalMessage: '含税销售金额合计 100',
      stopAgent: true,
    }),
  });

  assert.equal(requestCount, 1);
  assert.equal(result.content, '含税销售金额合计 100');
  assert.equal(result.stoppedByResultLock, true);
});

test('harness stops immediately on a terminal configuration error', async () => {
  let requestCount = 0;
  const harness = new OpenAICompatibleDeepSeekHarness({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'test-key',
    model: 'deepseek-chat',
    fetchImpl: async () => {
      requestCount += 1;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: {
                name: 'query_indicator',
                arguments: '{"indicatorId":"2"}',
              },
            }],
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const result = await harness.run({
    messages: [{ role: 'user', content: '测试' }],
    tools: [],
    executeTool: async () => {
      const error = new Error('请补齐主题提示词或字段白名单');
      error.terminal = true;
      throw error;
    },
  });

  assert.equal(requestCount, 1);
  assert.equal(result.content, '请补齐主题提示词或字段白名单');
  assert.equal(result.stoppedByTerminalError, true);
});

test('harness forwards an external cancellation signal to model requests', async () => {
  let capturedSignal = null;
  const controller = new AbortController();
  const harness = new OpenAICompatibleDeepSeekHarness({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'test-key',
    model: 'deepseek-chat',
    fetchImpl: async (_url, options) => {
      capturedSignal = options.signal;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: 'ok',
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await harness.chat([], [], {
    signal: controller.signal,
  });

  assert.ok(capturedSignal);
  assert.equal(capturedSignal.aborted, false);
  controller.abort();
  assert.equal(capturedSignal.aborted, true);
});
