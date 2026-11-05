import { OpenAICompatibleDeepSeekHarness } from '../../harness.js';

export function registerModelConnectionRoute(table) {
  table.add({
    id: 'models.testConnection',
    method: 'POST',
    path: '/api/models/test',
    tags: ['models'],
    summary: '测试模型连通性（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const {
        request,
        response,
        database,
        application,
        getRequestUser,
        readJson,
        sendJson,
      } = ctx;
      const user = await getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      const existing = body?.id ? await database.modelRepository.getModelAsync(Number(body.id)) : null;
      if (body?.id && !existing) {
        throw Object.assign(new Error('model not found'), { statusCode: 404 });
      }
      const apiKey = String(body?.apiKey ?? '').trim()
        || (body?.apiKeyEnv
          ? String(process.env[String(body.apiKeyEnv).trim()] ?? '').trim()
          : '')
        || (existing?.apiKeyEnv
          ? String(process.env[String(existing.apiKeyEnv).trim()] ?? '').trim()
          : '')
        || String(process.env.API_KEY ?? '').trim()
        || (existing?.apiKeyEncrypted
          ? application.datasourceCrypto.decrypt(existing.apiKeyEncrypted)
          : '');
      const config = {
        baseUrl: String(body?.baseUrl ?? existing?.baseUrl ?? '').trim(),
        apiKey,
        model: String(body?.modelName ?? body?.model ?? existing?.modelName ?? '').trim(),
        temperature: Number(body?.temperature ?? existing?.temperature ?? 0),
        maxTokens: Number(body?.maxTokens ?? existing?.maxTokens ?? 0),
        timeoutMs: Math.min(
          30_000,
          Math.max(1_000, Number(body?.timeoutMs ?? existing?.timeoutMs ?? 10_000) || 10_000),
        ),
        provider: String(body?.provider ?? existing?.provider ?? 'deepseek').trim(),
      };
      if (!config.baseUrl || !config.model) {
        throw Object.assign(new Error('Base URL and model identifier are required'), { statusCode: 400 });
      }
      if (!config.apiKey) {
        throw Object.assign(new Error('API key is required'), { statusCode: 400 });
      }

      const startedAt = Date.now();
      const harness = new OpenAICompatibleDeepSeekHarness(config);
      const result = await harness.chat([
        { role: 'user', content: 'Reply with OK.' },
      ]);
      sendJson(response, 200, {
        success: true,
        latencyMs: Date.now() - startedAt,
        message: String(result?.choices?.[0]?.message?.content ?? '').trim().slice(0, 120),
      });
    },
  });
}
