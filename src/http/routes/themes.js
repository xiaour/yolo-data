export function registerThemeRoutes(table) {
  table.add({
    id: 'themes.list',
    method: 'GET',
    path: '/api/themes',
    tags: ['themes'],
    summary: '列出当前用户可见主题',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, agent, getRequestUser, sendJson, toPublicTheme } = ctx;
      const user = getRequestUser(request, database);
      sendJson(response, 200, agent.getThemesForUser(user.id).map(toPublicTheme));
    },
  });

  table.add({
    id: 'themes.create',
    method: 'POST',
    path: '/api/themes',
    tags: ['themes'],
    summary: '创建主题（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, application, getRequestUser, readJson, sendJson, toPublicTheme, prepareThemePayload } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      const theme = database.saveTheme(
        prepareThemePayload(body, null, application.datasourceCrypto),
      );
      database.addAuditLog({
        userId: user.id,
        action: 'THEME_CREATE',
        detail: {
          themeId: theme.id,
          name: theme.name,
          modelKeyConfigured: Boolean(theme.llmConfig?.apiKeyEncrypted),
        },
      });
      sendJson(response, 200, toPublicTheme(theme));
    },
  });

  table.add({
    id: 'themes.update',
    method: 'PUT',
    path: '/api/themes/:id(\\d+)',
    tags: ['themes'],
    summary: '更新主题（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, application, params, getRequestUser, readJson, sendJson, toPublicTheme, prepareThemePayload } = ctx;
      const themeRoute = params;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      const existingTheme = database.getTheme(Number(themeRoute[0]));
      if (!existingTheme) {
        throw Object.assign(new Error('theme not found'), { statusCode: 404 });
      }
      const theme = database.saveTheme(
        prepareThemePayload(body, existingTheme, application.datasourceCrypto),
        Number(themeRoute[0]),
      );
      database.addAuditLog({
        userId: user.id,
        action: 'THEME_UPDATE',
        detail: {
          themeId: theme.id,
          name: theme.name,
          modelKeyConfigured: Boolean(theme.llmConfig?.apiKeyEncrypted),
        },
      });
      sendJson(response, 200, toPublicTheme(theme));
    },
  });

  table.add({
    id: 'themes.status.update',
    method: 'PUT',
    path: '/api/themes/:id(\\d+)/status',
    tags: ['themes'],
    summary: '启用或停用主题（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, params, getRequestUser, readJson, sendJson, toPublicTheme } = ctx;
      const themeStatusRoute = params;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      if (body.status !== 0 && body.status !== 1) {
        throw Object.assign(new Error('status must be 0 or 1'), { statusCode: 400 });
      }
      const theme = database.setThemeStatus(Number(themeStatusRoute[0]), body.status);
      if (!theme) {
        throw Object.assign(new Error('theme not found'), { statusCode: 404 });
      }
      database.addAuditLog({
        userId: user.id,
        action: 'THEME_STATUS_UPDATE',
        detail: { themeId: theme.id, name: theme.name, status: theme.status },
      });
      sendJson(response, 200, toPublicTheme(theme));
    },
  });

  table.add({
    id: 'themes.delete',
    method: 'DELETE',
    path: '/api/themes/:id(\\d+)',
    tags: ['themes'],
    summary: '删除主题（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, params, getRequestUser, sendJson } = ctx;
      const themeDeleteRoute = params;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const deleted = database.deleteTheme(Number(themeDeleteRoute[0]));
      database.addAuditLog({
        userId: user.id,
        action: 'THEME_DELETE',
        detail: { themeId: Number(themeDeleteRoute[0]), deleted },
      });
      sendJson(response, 200, { deleted });
    },
  });

  table.add({
    id: 'themes.prompt.update',
    method: 'PUT',
    path: '/api/themes/:id(\\d+)/prompt',
    tags: ['themes'],
    summary: '更新主题提示词（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, params, getRequestUser, readJson, sendJson } = ctx;
      const themePromptRoute = params;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      const theme = database.updateThemePrompt(Number(themePromptRoute[0]), body.systemPrompt);
      if (!theme) {
        throw Object.assign(new Error('theme not found'), { statusCode: 404 });
      }
      database.addAuditLog({
        userId: user.id,
        action: 'THEME_PROMPT_UPDATE',
        detail: { themeId: theme.id, name: theme.name },
      });
      sendJson(response, 200, theme);
    },
  });

  table.add({
    id: 'themes.semanticValues.read',
    method: 'GET',
    path: '/api/themes/:id(\\d+)/semantic-values',
    tags: ['themes'],
    summary: '读取主题语义值字段（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: themeSemanticValuesHandler,
  });

  table.add({
    id: 'themes.semanticValues.update',
    method: 'PUT',
    path: '/api/themes/:id(\\d+)/semantic-values',
    tags: ['themes'],
    summary: '保存主题语义值配置（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: themeSemanticValuesHandler,
  });

  table.add({
    id: 'themes.semanticValues.refresh',
    method: 'POST',
    path: '/api/themes/:id(\\d+)/semantic-values/refresh',
    tags: ['themes'],
    summary: '刷新主题语义值域（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, agent, params, getRequestUser, sendJson } = ctx;
      const themeSemanticValuesRefreshRoute = params;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const themeId = Number(themeSemanticValuesRefreshRoute[0]);
      const result = await agent.refreshSemanticValueFields(themeId);
      database.addAuditLog({
        userId: user.id,
        action: 'THEME_SEMANTIC_VALUES_REFRESH',
        detail: {
          themeId,
          fieldCount: result.fields.length,
          warningCount: result.warnings.length,
        },
      });
      sendJson(response, 200, result);
    },
  });

  table.add({
    id: 'themes.semanticValues.preview',
    method: 'POST',
    path: '/api/semantic-values/preview',
    tags: ['themes'],
    summary: '预览语义值字段（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, agent, database, getRequestUser, readJson, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      const themeId = Number(body.themeId);
      sendJson(response, 200, await agent.listSemanticValueFields(
        Number.isFinite(themeId) && themeId > 0 ? themeId : null,
        {
          indicatorIds: Array.isArray(body.indicatorIds) ? body.indicatorIds : [],
          businessDatasetIds: Array.isArray(body.businessDatasetIds)
            ? body.businessDatasetIds
            : [],
          semanticValueConfig: body.semanticValueConfig ?? {},
          systemPrompt: String(body.systemPrompt ?? ''),
        },
      ));
    },
  });

  table.add({
    id: 'skills.list',
    method: 'GET',
    path: '/api/skills',
    tags: ['themes'],
    summary: '列出 Skill（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, getRequestUser, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      sendJson(response, 200, database.listSkills());
    },
  });

  table.add({
    id: 'skillRegistry.read',
    method: 'GET',
    path: '/api/skill-registry',
    tags: ['themes'],
    summary: '读取 Skill 注册表（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, application, getRequestUser, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      sendJson(response, 200, {
        roots: application.config.skillDirectories ?? [],
        sync: application.runtime.skillSync,
        skills: database.listSkills(),
      });
    },
  });

  table.add({
    id: 'skillRegistry.sync',
    method: 'POST',
    path: '/api/skill-registry/sync',
    tags: ['themes'],
    summary: '同步外部 Skill（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, application, getRequestUser, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const sync = application.skillRegistry.refreshExternalSkills();
      application.runtime.skillSync = sync;
      database.addAuditLog({
        userId: user.id,
        action: 'SKILL_REGISTRY_SYNC',
        detail: {
          count: sync.count ?? 0,
          roots: sync.roots ?? [],
          warnings: sync.warnings?.length ?? 0,
        },
      });
      sendJson(response, 200, {
        ...sync,
        skills: database.listSkills(),
      });
    },
  });

  table.add({
    id: 'semanticDomains.list',
    method: 'GET',
    path: '/api/semantic-domains',
    tags: ['themes'],
    summary: '列出主题语义值域（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, agent, getRequestUser, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const themeId = Number(
        new URL(request.url, 'http://localhost').searchParams.get('themeId'),
      );
      if (!Number.isFinite(themeId) || themeId <= 0) {
        throw Object.assign(new Error('themeId is required'), { statusCode: 400 });
      }
      sendJson(response, 200, await agent.listSemanticValueFields(themeId));
    },
  });

  table.add({
    id: 'semanticDomains.refresh',
    method: 'POST',
    path: '/api/semantic-domains/refresh',
    tags: ['themes'],
    summary: '刷新语义值域（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, agent, getRequestUser, readJson, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      const result = await agent.refreshSemanticValueDomain(body);
      database.addAuditLog({
        userId: user.id,
        action: 'SEMANTIC_DOMAIN_REFRESH',
        detail: {
          themeId: body.themeId,
          sourceType: body.sourceType,
          sourceId: body.sourceId,
          fieldName: body.fieldName,
          status: result?.status,
        },
      });
      sendJson(response, 200, result);
    },
  });

  table.add({
    id: 'semanticDomains.override',
    method: 'POST',
    path: '/api/semantic-domains/override',
    tags: ['themes'],
    summary: '覆盖语义值域（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, database, agent, getRequestUser, readJson, sendJson } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      const body = await readJson(request);
      const result = await agent.saveSemanticValueOverride({
        ...body,
        updatedBy: user.id,
      });
      database.addAuditLog({
        userId: user.id,
        action: 'SEMANTIC_DOMAIN_OVERRIDE',
        detail: {
          themeId: body.themeId,
          sourceType: body.sourceType,
          sourceId: body.sourceId,
          fieldName: body.fieldName,
          concept: body.concept,
          action: body.action,
        },
      });
      sendJson(response, 200, result);
    },
  });
}

async function themeSemanticValuesHandler(ctx) {
  const { request, response, database, agent, params, method, getRequestUser, readJson, sendJson } = ctx;
  const themeSemanticValuesRoute = params;
  const user = getRequestUser(request, database);
  if (user.role !== 'ADMIN') {
    throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
  }
  const themeId = Number(themeSemanticValuesRoute[0]);
  const theme = database.getTheme(themeId);
  if (!theme) {
    throw Object.assign(new Error('theme not found'), { statusCode: 404 });
  }
  if (method === 'GET') {
    sendJson(response, 200, await agent.listSemanticValueFields(themeId));
    return;
  }
  const body = await readJson(request);
  const updated = database.saveTheme({
    ...theme,
    semanticValueConfig: body,
  }, themeId);
  database.addAuditLog({
    userId: user.id,
    action: 'THEME_SEMANTIC_VALUES_UPDATE',
    detail: {
      themeId,
      enabled: updated.semanticValueConfig?.enabled !== false,
      fieldCount: Object.keys(updated.semanticValueConfig?.fields ?? {}).length,
    },
  });
  sendJson(response, 200, await agent.listSemanticValueFields(themeId));
}
