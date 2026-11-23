// 应用装配期的引导辅助：平台 MySQL 数据源的自动注册与 yolo-conf
// 模型配置的种子化。只在 createApplication 的装配路径使用。

export async function ensurePlatformMysqlDatasource({ backend, mysql = {}, businessDatasets }) {
  if (String(backend ?? '').toLowerCase() !== 'mysql'
    || !mysql.host || !mysql.database || !mysql.user) return null;
  const code = 'platform_mysql';
  const existing = await businessDatasets.getDataSourceByCodeAsync(code);
  if (existing) return existing;
  return businessDatasets.saveDataSourceAsync({
    code,
    name: '平台 MySQL 数据源',
    dbType: 'MYSQL',
    host: mysql.host,
    port: mysql.port ?? 3306,
    databaseName: mysql.database,
    username: mysql.user,
    password: mysql.password ?? '',
    status: 1,
    options: { readonly: true, maxRows: 1000, queryTimeoutMs: 20_000 },
  });
}

export async function seedConfiguredModel(database, modelConfig) {
  if (!String(modelConfig?.apiKey ?? '').trim() || !String(modelConfig?.model ?? '').trim()) return;
  const isAsync = database.isAsyncPlatformStore === true;
  const models = isAsync ? await database.listModelsAsync() : database.listModels();
  const configuredName = `${modelConfig.model} (yolo-conf)`;
  const configured = models.find((model) => model.name === configuredName)
    ?? models.find((model) => (
      model.modelName === modelConfig.model
      && model.baseUrl === modelConfig.baseUrl
      && model.apiKeyEnv === 'API_KEY'
    ));
  const model = configured ?? (isAsync
    ? await database.modelRepository.saveModelAsync({
      name: configuredName,
      provider: 'openai-compatible',
      modelName: modelConfig.model,
      baseUrl: modelConfig.baseUrl,
      apiKeyEnv: 'API_KEY',
      temperature: modelConfig.temperature,
      maxTokens: modelConfig.maxTokens,
      timeoutMs: modelConfig.timeoutMs,
      maxToolRounds: modelConfig.maxToolRounds,
      isDefault: true,
      status: 1,
    })
    : database.saveModel({
      name: configuredName,
      provider: 'openai-compatible',
      modelName: modelConfig.model,
      baseUrl: modelConfig.baseUrl,
      apiKeyEnv: 'API_KEY',
      temperature: modelConfig.temperature,
      maxTokens: modelConfig.maxTokens,
      timeoutMs: modelConfig.timeoutMs,
      maxToolRounds: modelConfig.maxToolRounds,
      isDefault: true,
      status: 1,
    }));
  if (!model) return;

  const createdThemeIds = new Set(
    (database.bootstrapState?.createdThemeIds ?? []).map(Number),
  );
  if (createdThemeIds.size === 0) return;
  const themes = isAsync ? await database.listThemesAsync() : database.listThemes();
  for (const theme of themes) {
    if (!createdThemeIds.has(Number(theme.id)) || (theme.modelIds ?? []).length > 0) continue;
    const payload = { ...theme, modelIds: [model.id], defaultModelId: model.id };
    if (isAsync) await database.saveThemeAsync(payload, theme.id);
    else database.saveTheme(payload, theme.id);
  }
}
