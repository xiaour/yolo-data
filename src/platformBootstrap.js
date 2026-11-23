import { loadBootstrapConfig, seedPlatformConfigSnapshot } from './platformBootstrapSeed.js';
export async function seedMysqlPlatformDefaults(database) {
  // Some embedders/tests provide a minimal store factory for initialization
  // lifecycle checks; only seed stores exposing the full query contract.
  if (typeof database.query !== 'function' || !database.userRepository) return;
  const bootstrap = loadBootstrapConfig();
  const bootstrapMarker = 'bootstrap.defaults.initialized';
  const createdUserIds = new Set();
  const createdUsernames = new Set();
  const createdThemeIds = new Set();
  const createdThemeNames = new Set();
  const [marker] = await database.query(
    'SELECT `key` FROM platform_settings WHERE `key` = ?',
    [bootstrapMarker],
  );
  if (marker) {
    database.bootstrapState = { createdUserIds: [], createdThemeIds: [] };
    return database.bootstrapState;
  }
  const [existing] = await database.query('SELECT COUNT(*) AS count FROM app_users');
  if (Number(existing?.count ?? 0) > 0) {
    database.bootstrapState = { createdUserIds: [], createdThemeIds: [] };
    return database.bootstrapState;
  }
  if (database.backend === 'mysql'
    && await seedPlatformConfigSnapshot(database)) {
    const [users, themes] = await Promise.all([
      database.userRepository.listUsersAsync(),
      database.listThemesAsync(),
    ]);
    database.bootstrapState = {
      createdUserIds: users.map((user) => Number(user.id)),
      createdThemeIds: themes.map((theme) => Number(theme.id)),
    };
    await database.execute(`INSERT IGNORE INTO platform_settings
      (\`key\`, value_json, updated_at) VALUES (?, 'true', ?)`,
    [bootstrapMarker, new Date().toISOString()]);
    return { seededSnapshot: true, ...database.bootstrapState };
  }
  for (const user of bootstrap.users ?? []) {
    const username = String(user.username ?? '').trim();
    if (!username || await database.userRepository.getUserByUsernameAsync(username)) continue;
    const created = await database.userRepository.saveUserAsync({
      username,
      displayName: user.displayName ?? username,
      role: user.role,
      status: 1,
      attributes: user.attributes ?? {},
    });
    if (created?.id != null) createdUserIds.add(Number(created.id));
    createdUsernames.add(username);
  }

  const existingThemes = await database.listThemesAsync();
  const themesByName = new Map(existingThemes.map((theme) => [theme.name, theme]));
  for (const theme of bootstrap.themes ?? []) {
    const name = String(theme.name ?? '').trim();
    if (!name || themesByName.has(name)) continue;
    const created = await database.saveThemeAsync({
      ...theme,
      name,
      indicatorIds: theme.indicatorIds ?? [],
      skillCodes: theme.skillCodes ?? [],
      allowedDimensions: theme.allowedDimensions ?? [],
    });
    if (created) themesByName.set(name, created);
    if (created?.id != null) createdThemeIds.add(Number(created.id));
    createdThemeNames.add(name);
  }

  for (const grant of bootstrap.themeGrants ?? []) {
    if (!createdUsernames.has(String(grant.username))
      && !createdThemeNames.has(String(grant.theme))) continue;
    const user = await database.userRepository.getUserByUsernameAsync(grant.username);
    const theme = themesByName.get(grant.theme);
    if (!user || !theme) continue;
    await database.execute(`INSERT IGNORE INTO user_theme_grants
      (user_id, theme_id, can_query, can_manage) VALUES (?, ?, 1, ?)`,
    [user.id, theme.id, grant.canManage ? 1 : 0]);
  }
  database.bootstrapState = {
    createdUserIds: [...createdUserIds],
    createdThemeIds: [...createdThemeIds],
  };
  await database.execute(`INSERT IGNORE INTO platform_settings
    (\`key\`, value_json, updated_at) VALUES (?, 'true', ?)`,
  [bootstrapMarker, new Date().toISOString()]);
  return database.bootstrapState;
}
