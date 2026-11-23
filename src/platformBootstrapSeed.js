import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// MySQL 平台库的种子数据来源：默认引导配置（config/bootstrap/default.json）
// 与平台快照种子（config/bootstrap/platform-seed.json）的读取、校验与灌入。

export function loadBootstrapConfig() {
  try {
    const path = fileURLToPath(new URL('../config/bootstrap/default.json', import.meta.url));
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return { users: [], themes: [], themeGrants: [], rowPolicies: [] };
  }
}

export async function seedPlatformConfigSnapshot(database) {
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
