import fs from 'node:fs';
import { mysqlize } from './mysql-schema-conversion.mjs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PlatformDatabase } from '../src/database.js';

const outputPath = path.resolve(process.argv[2] ?? 'config/platform/mysql-init.sql');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-platform-schema-'));
const sqlitePath = path.join(tempDir, 'platform.db');

const database = new PlatformDatabase(sqlitePath);
const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
const objects = sqlite.prepare(`
  SELECT type, name, sql
  FROM sqlite_master
  WHERE sql IS NOT NULL AND type IN ('table', 'index')
    AND name NOT LIKE 'sqlite_%'
  ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name
`).all();
sqlite.close();
database.close();

const statements = objects.map((object) => {
  const sql = mysqlize(object.sql).replace(/CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ');
  return `-- ${object.type}: ${object.name}\n${sql};`;
});
const header = `-- YOLO platform metadata database for MySQL 8.0+\n-- Generated from the active SQLite platform schema.\n-- This database stores platform metadata only; business data sources remain configurable.\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n`;
const footer = '\nSET FOREIGN_KEY_CHECKS = 1;\n';
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${header}\n${statements.join('\n\n')}${footer}`, 'utf8');
console.log(`Generated ${outputPath} (${statements.length} statements)`);
