export function registerBootstrapRoute(table) {
  table.add({
    id: 'users.bootstrap',
    method: 'GET',
    path: '/api/bootstrap',
    tags: ['users'],
    summary: '前端启动所需的全量上下文',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, application, agent, getRequestUser, sendJson, toPublicTheme, toPublicModel } = ctx;
      const user = await getRequestUser(request, database);
      const canManage = user.role === 'ADMIN';
      const [themes, preferences, managedThemes, skills, datasetOptions, businessDatasets,
        dataSources, models, health, indicatorTypes] = await Promise.all([
        agent.getThemesForUserAsync(user.id),
        database.isAsyncPlatformStore
          ? database.getUserPreferencesAsync(user.id) : database.getUserPreferences(user.id),
        canManage
          ? (database.isAsyncPlatformStore ? database.listThemesAsync() : database.listThemes())
          : Promise.resolve([]),
        database.isAsyncPlatformStore ? database.listSkillsAsync() : Promise.resolve(database.listSkills()),
        database.isAsyncPlatformStore
          ? database.listDatasetOptionsAsync() : Promise.resolve(database.listDatasetOptions()),
        database.listBusinessDatasetsAsync(canManage ? { includeDisabled: true } : { userId: user.id }),
        user.role === 'ADMIN' ? database.dataSourceRepository.listDataSourcesAsync() : Promise.resolve([]),
        user.role === 'ADMIN' ? database.modelRepository.listModelsAsync() : Promise.resolve([]),
        application.currentHealth(),
        !canManage ? Promise.resolve([]) : database.localIndicators.listTypesAsync(),
      ]);
      sendJson(response, 200, {
        currentUser: user,
        preferences,
        themes: themes.map(toPublicTheme),
        managedThemes: managedThemes.map(toPublicTheme),
        skills,
        datasetOptions: datasetOptions.items,
        indicatorSource: application.resolveIndicatorSource(),
        businessDatasets,
        dataSources,
        models: models.map(toPublicModel),
        indicatorTypes,
        health,
      });
    },
  });
}
