import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer } from '../src/server.js';

function testConfig(directory) {
  return {
    projectRoot: process.cwd(),
    port: 0,
    dbPath: path.join(directory, 'test.db'),
    deepseek: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      temperature: 0.1,
      maxTokens: 0,
      timeoutMs: 5_000,
      maxToolRounds: 3,
    },
    chatMemoryMessageLimit: 20,
    datasourceSecretKey: '',
    datasourceSecretKeyPath: path.join(directory, '.credential-key'),
    bootstrapDatasource: { enabled: false },
  };
}

test('theme API stores model keys encrypted and never returns plaintext', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-server-'));
  const { server, application } = await startServer(testConfig(directory));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = {
    'content-type': 'application/json',
    'x-user-id': '1',
  };

  try {
    const themes = await (await fetch(`${baseUrl}/api/themes`, { headers })).json();
    const theme = themes.find((item) => item.name === '经营总览');
    const saveResponse = await fetch(`${baseUrl}/api/themes/${theme.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        ...theme,
        llmConfig: {
          ...theme.llmConfig,
          model: 'deepseek-chat',
          apiKey: 'sk-page-secret',
        },
        semanticPolicy: {
          metrics: [{
            id: 'policy.metric',
            concept: '业务指标',
            aliases: ['业务指标'],
            target: {
              type: 'FIELD',
              field: 'sale_amt',
              aggregator: 'SUM',
            },
          }],
        },
      }),
    });
    const saved = await saveResponse.json();

    assert.equal(saveResponse.status, 200);
    assert.equal(saved.llmConfig.hasApiKey, true);
    assert.equal(saved.llmConfig.apiKey, undefined);
    assert.equal(saved.llmConfig.apiKeyEncrypted, undefined);
    assert.equal(JSON.stringify(saved).includes('sk-page-secret'), false);
    assert.equal(JSON.stringify(saved).includes('apiKeyEncrypted'), false);
    assert.equal(saved.semanticPolicy.metrics[0].id, 'policy.metric');

    const stored = application.database.getTheme(theme.id);
    assert.match(stored.llmConfig.apiKeyEncrypted, /^ENC:/);
    assert.equal(
      application.datasourceCrypto.decrypt(stored.llmConfig.apiKeyEncrypted),
      'sk-page-secret',
    );
    assert.equal(stored.semanticPolicy.metrics[0].target.field, 'sale_amt');

    const clearResponse = await fetch(`${baseUrl}/api/themes/${theme.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        ...saved,
        llmConfig: {
          ...saved.llmConfig,
          clearApiKey: true,
        },
      }),
    });
    const cleared = await clearResponse.json();
    assert.equal(cleared.llmConfig.hasApiKey, false);
    assert.equal(
      application.database.getTheme(theme.id).llmConfig.apiKeyEncrypted,
      undefined,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await application.database.closeAsync();
  }
});

test('theme semantic value API persists field switches independently per agent', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-semantic-api-'));
  const { server, application } = await startServer(testConfig(directory));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const adminHeaders = {
    'content-type': 'application/json',
    'x-user-id': '1',
  };

  try {
    const themes = await (await fetch(`${baseUrl}/api/themes`, {
      headers: adminHeaders,
    })).json();
    const [firstTheme, secondTheme] = themes;
    const config = {
      enabled: true,
      autoDiscover: false,
      fields: {
        'INDICATOR:2:business_type_name': false,
        'DATASET:1:first_category_name': true,
      },
    };

    const saveResponse = await fetch(
      `${baseUrl}/api/themes/${firstTheme.id}/semantic-values`,
      {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify(config),
      },
    );
    const saved = await saveResponse.json();
    assert.equal(saveResponse.status, 200);
    assert.equal(
      saved.config.fields['INDICATOR:2:business_type_name'].enabled,
      false,
    );
    assert.equal(
      saved.config.fields['DATASET:1:first_category_name'].enabled,
      true,
    );
    assert.equal(
      application.database.getTheme(firstTheme.id).semanticValueConfig.autoDiscover,
      false,
    );

    const firstFields = await (await fetch(
      `${baseUrl}/api/themes/${firstTheme.id}/semantic-values`,
      { headers: adminHeaders },
    )).json();
    const businessType = firstFields.fields.find(
      (field) => field.key === 'INDICATOR:2:business_type_name',
    );
    assert.equal(businessType.enabled, false);

    const secondFields = await (await fetch(
      `${baseUrl}/api/themes/${secondTheme.id}/semantic-values`,
      { headers: adminHeaders },
    )).json();
    assert.deepEqual(secondFields.config.fields, {});
    assert.equal(
      application.database.getTheme(secondTheme.id).semanticValueConfig.autoDiscover
        ?? true,
      true,
    );

    const deniedResponse = await fetch(
      `${baseUrl}/api/themes/${firstTheme.id}/semantic-values`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-user-id': '2',
        },
        body: JSON.stringify(config),
      },
    );
    assert.equal(deniedResponse.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await application.database.closeAsync();
  }
});

test('system settings and health report the persisted local catalog count', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-settings-'));
  const { server, application } = await startServer(testConfig(directory));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const adminHeaders = { 'content-type': 'application/json', 'x-user-id': '1' };
  try {
    const readSettings = async () => {
      const response = await fetch(`${baseUrl}/api/settings`, { headers: adminHeaders });
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.deepEqual(await readSettings(), { localIndicatorCount: 0 });
    const indicator = await application.database.localIndicators.save({ name: '销售额', bizName: 'sales_amount' });
    assert.deepEqual(await readSettings(), { localIndicatorCount: 1 });
    const health = await (await fetch(`${baseUrl}/api/health`)).json();
    assert.equal(health.source.mode, 'local');
    assert.equal(health.source.localIndicatorManagement, true);
    assert.equal(health.source.localIndicatorCount, 1);
    assert.equal(health.source.indicatorSource, 'LOCAL');
    const catalog = await (await fetch(`${baseUrl}/api/indicators`, { headers: adminHeaders })).json();
    assert.equal(catalog.localMode, true);
    assert.deepEqual(catalog.items.map((item) => item.id), [indicator.id]);
    await application.database.localIndicators.deleteAsync(indicator.id);
    assert.deepEqual(await readSettings(), { localIndicatorCount: 0 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await application.database.closeAsync();
  }
});

test('model management persists multiple models and theme default selection', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-models-'));
  const { server, application } = await startServer(testConfig(directory));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const adminHeaders = {
    'content-type': 'application/json',
    'x-user-id': '1',
  };

  try {
    const firstResponse = await fetch(`${baseUrl}/api/models`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'DeepSeek Flash',
        provider: 'deepseek',
        modelName: 'deepseek-flash',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-model-secret',
        temperature: 0,
        maxToolRounds: 12,
        isDefault: true,
      }),
    });
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 200);
    assert.equal(first.hasApiKey, true);
    assert.equal(first.apiKeyEncrypted, undefined);
    assert.equal(JSON.stringify(first).includes('sk-model-secret'), false);

    const secondResponse = await fetch(`${baseUrl}/api/models`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        name: 'OpenAI Compatible',
        provider: 'openai-compatible',
        modelName: 'custom-model',
        apiKeyEnv: 'CUSTOM_MODEL_API_KEY',
        temperature: 0.2,
      }),
    });
    const second = await secondResponse.json();
    assert.equal(secondResponse.status, 200);
    assert.equal(second.isDefault, false);

    const modelsResponse = await fetch(`${baseUrl}/api/models`, {
      headers: adminHeaders,
    });
    const models = await modelsResponse.json();
    assert.equal(models.length, 2);
    assert.equal(models.find((model) => model.id === first.id).isDefault, true);

    const themes = await (await fetch(`${baseUrl}/api/themes`, {
      headers: adminHeaders,
    })).json();
    const theme = themes.find((item) => item.name === '经营总览');
    const themeResponse = await fetch(`${baseUrl}/api/themes/${theme.id}`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        ...theme,
        modelIds: [first.id, second.id],
        defaultModelId: second.id,
      }),
    });
    const savedTheme = await themeResponse.json();
    assert.equal(themeResponse.status, 200);
    assert.deepEqual(savedTheme.modelIds, [first.id, second.id]);
    assert.equal(savedTheme.defaultModelId, second.id);
    assert.equal(
      application.database.getTheme(theme.id).defaultModelId,
      second.id,
    );

    const defaultResponse = await fetch(
      `${baseUrl}/api/models/${second.id}/default`,
      { method: 'PUT', headers: adminHeaders },
    );
    const defaultModel = await defaultResponse.json();
    assert.equal(defaultModel.isDefault, true);
    assert.equal(
      application.database.getModel(first.id).isDefault,
      false,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await application.database.closeAsync();
  }
});

test('model management can test a saved model connection without exposing the key', async () => {
  const upstream = http.createServer(async (request, response) => {
    const body = await new Promise((resolve, reject) => {
      let text = '';
      request.on('data', (chunk) => { text += chunk; });
      request.on('end', () => resolve(text ? JSON.parse(text) : {}));
      request.on('error', reject);
    });
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer sk-test-model');
    assert.equal(body.messages[0].content, 'Reply with OK.');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      choices: [{ message: { content: 'OK' } }],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-model-test-'));
  const { server, application } = await startServer(testConfig(directory));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  const headers = {
    'content-type': 'application/json',
    'x-user-id': '1',
  };

  try {
    const createdResponse = await fetch(`${baseUrl}/api/models`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Connection Test',
        provider: 'openai-compatible',
        modelName: 'test-model',
        baseUrl: upstreamUrl,
        apiKey: 'sk-test-model',
      }),
    });
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 200);

    const testResponse = await fetch(`${baseUrl}/api/models/test`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: created.id }),
    });
    const result = await testResponse.json();
    assert.equal(testResponse.status, 200);
    assert.equal(result.success, true);
    assert.equal(result.message, 'OK');
    assert.equal(application.database.getModel(created.id).hasApiKey, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await application.database.closeAsync();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('model connection test turns an HTML upstream error into a readable message', async () => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'text/html' });
    response.end('<!doctype html><html><body><h1>Not Found</h1></body></html>');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-model-html-error-'));
  const { server, application } = await startServer(testConfig(directory));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  const headers = {
    'content-type': 'application/json',
    'x-user-id': '1',
  };

  try {
    const response = await fetch(`${baseUrl}/api/models/test`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'openai-compatible',
        modelName: 'test-model',
        baseUrl: upstreamUrl,
        apiKey: 'sk-test-model',
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 400);
    assert.match(result.message, /模型服务返回了 HTML 页面/);
    assert.equal(result.message.includes('<html>'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await application.database.closeAsync();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
