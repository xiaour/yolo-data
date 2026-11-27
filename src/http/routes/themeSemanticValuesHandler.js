// 智能体语义值域路由处理器：GET 读取字段值域、PUT 更新值域配置并写审计。
// 挂载在主题路由的两个端点上（/api/themes/:id/semantic-values）。
export async function themeSemanticValuesHandler(ctx) {
  const { request, response, database, agent, params, method, getRequestUser, readJson, sendJson } = ctx;
  const themeSemanticValuesRoute = params;
  const user = await getRequestUser(request, database);
  if (user.role !== 'ADMIN') {
    throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
  }
  const themeId = Number(themeSemanticValuesRoute[0]);
  const theme = await database.themeRepository.getThemeAsync(themeId);
  if (!theme) {
    throw Object.assign(new Error('theme not found'), { statusCode: 404 });
  }
  if (method === 'GET') {
    sendJson(response, 200, await agent.listSemanticValueFields(themeId));
    return;
  }
  const body = await readJson(request);
  const updated = await database.themeRepository.saveThemeAsync({
    ...theme,
    semanticValueConfig: body,
  }, themeId);
  await database.addAuditLogAsync({
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
