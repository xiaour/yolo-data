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

function harnessReplyingWith(status, body) {
  return new OpenAICompatibleDeepSeekHarness({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'test-key',
    model: 'deepseek-chat',
    fetchImpl: async () => new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
}

async function chatErrorMessage(status, body) {
  try {
    await harnessReplyingWith(status, body).chat([{ role: 'user', content: '测试' }]);
    return null;
  } catch (error) {
    return error.message;
  }
}

test('provider failures are translated into actionable configuration guidance', async () => {
  const insufficient = await chatErrorMessage(
    402,
    JSON.stringify({ error: { message: 'Insufficient Balance (request_id: abc-123)' } }),
  );
  assert.match(insufficient, /HTTP 402/);
  assert.match(insufficient, /余额不足/);
  assert.match(insufficient, /模型管理/);
  // 上游原始信息保留下来，方便管理员排查。
  assert.match(insufficient, /Insufficient Balance/);
  assert.match(insufficient, /abc-123/);

  assert.match(await chatErrorMessage(401, '{}'), /API Key 无效/);
  assert.match(await chatErrorMessage(404, '{}'), /Base URL 和模型名/);
  assert.match(await chatErrorMessage(429, '{}'), /稍后重试/);
  assert.match(await chatErrorMessage(503, '{}'), /暂时不可用/);
});

test('provider mismatch errors explain model and endpoint compatibility', async () => {
  const message = await chatErrorMessage(
    400,
    JSON.stringify({ error: { message: 'Model id : deepseek-ai/DeepSeek-V4.1-Flash , has no provider supported' } }),
  );
  assert.match(message, /没有可用的该模型 provider/);
  assert.match(message, /Base URL/);
  assert.match(message, /工具调用/);
});

test('provider failures keep the HTML base-url diagnosis and truncate long details', async () => {
  const html = await chatErrorMessage(404, '<!DOCTYPE html><html><body>gateway</body></html>');
  assert.match(html, /HTML 页面/);

  const long = await chatErrorMessage(
    500,
    JSON.stringify({ error: { message: 'x'.repeat(400) } }),
  );
  assert.ok(long.length < 400);
  assert.match(long, /\.\.\./);
});


test('local rule runtime with metadata-only catalog never calls removed indicator tools', async () => {
  const { RuleBasedHarness } = await import('../src/harness.js');
  const calls = [];
  const result = await new RuleBasedHarness().run({
    messages: [{ role: 'user', content: '销售额是多少' }],
    tools: [], metadata: { sourceMode: 'local' },
    executeTool: async (name) => { calls.push(name); throw new Error('unavailable tool'); },
  });
  assert.deepEqual(calls, []);
  assert.match(result.content, /业务数据集/);
  assert.deepEqual(result.trace, []);
});
