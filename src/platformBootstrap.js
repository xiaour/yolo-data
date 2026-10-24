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
  const timestamp = new Date().toISOString();
  const [userCount] = await database.query('SELECT COUNT(*) AS count FROM app_users');
  if (database.backend === 'mysql'
    && Number(userCount?.count ?? 0) === 0
    && await seedPlatformConfigSnapshot(database)) {
    return { seededSnapshot: true };
  }
  if (Number(userCount?.count ?? 0) === 0) {
    for (const user of bootstrap.users ?? []) {
      await database.userRepository.saveUserAsync({
        username: user.username,
        displayName: user.displayName ?? user.username,
        role: user.role,
        status: 1,
        attributes: user.attributes ?? {},
      });
    }
  }

  const [themeCount] = await database.query('SELECT COUNT(*) AS count FROM themes');
  if (Number(themeCount?.count ?? 0) === 0) {
    for (const theme of bootstrap.themes ?? []) {
      await database.saveThemeAsync({
        ...theme,
        indicatorIds: theme.indicatorIds ?? [],
        skillCodes: theme.skillCodes ?? [],
        allowedDimensions: theme.allowedDimensions ?? [],
      });
    }
  }

  const [grantCount] = await database.query('SELECT COUNT(*) AS count FROM user_theme_grants');
  if (Number(grantCount?.count ?? 0) === 0) {
    for (const grant of bootstrap.themeGrants ?? []) {
      const user = await database.userRepository.getUserByUsernameAsync(grant.username);
      const themes = await database.listThemesAsync();
      const theme = themes.find((item) => item.name === grant.theme);
      if (!user || !theme) continue;
      await database.execute(`INSERT IGNORE INTO user_theme_grants
        (user_id, theme_id, can_query, can_manage) VALUES (?, ?, 1, ?)`,
      [user.id, theme.id, grant.canManage ? 1 : 0]);
    }
  }
  return { seededUsers: Number(userCount?.count ?? 0) === 0, seededThemes: Number(themeCount?.count ?? 0) === 0 };
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
