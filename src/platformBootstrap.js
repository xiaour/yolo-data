import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function loadBootstrapConfig() {
  try {
    const path = fileURLToPath(new URL('../config/bootstrap/default.json', import.meta.url));
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return { users: [], themes: [], themeGrants: [], rowPolicies: [] };
  }
}

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

async function seedPlatformConfigSnapshot(database) {
  const seedPath = fileURLToPath(new URL('../config/bootstrap/platform-seed.json', import.meta.url));
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  } catch {
    return;
  }
  if (snapshot?.format !== 1 || !snapshot.tables || typeof snapshot.tables !== 'object') return;
  const tables = Object.keys(snapshot.tables);
  for (const table of tables) {
    if (!/^[a-z][a-z0-9_]*$/.test(table)) return;
    const [row] = await database.query(`SELECT COUNT(*) AS count FROM \`${table}\``);
    if (Number(row?.count ?? 0) > 0) return false;
  }
  await database.transaction(async (tx) => {
    for (const [table, rows] of Object.entries(snapshot.tables)) {
      for (const row of rows) {
        const columns = Object.keys(row);
        if (columns.length === 0) continue;
        const tick = String.fromCharCode(96);
        const quoted = columns.map((column) => `${tick}${column.replaceAll(tick, tick + tick)}${tick}`).join(', ');
        const placeholders = columns.map(() => '?').join(', ');
        await tx.execute(`INSERT INTO ${tick}${table}${tick} (${quoted}) VALUES (${placeholders})`,
          columns.map((column) => row[column]));
      }
    }
  });
  return true;
}
