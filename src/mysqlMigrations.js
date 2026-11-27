import path from 'node:path';
import fs from 'node:fs/promises';

// MySQL 平台库的 SQL 迁移执行器：按 `-- STATEMENT` 标记与行尾分号切分 .sql 文件，
// 以文件名登记 schema_migrations，并对 ADD COLUMN / CREATE INDEX 做
// 幂等兜底（MySQL DDL 自动提交，中断后重跑可能撞到已存在结构）。

export function splitSqlStatements(source) {
  return source
    .split(/^\s*--\s*STATEMENT\s*$/m)
    .flatMap((part) => part.split(/;\s*(?=\r?\n|$)/))
    .map((statement) => statement.replace(/^(?:\s*--[^\r\n]*(?:\r?\n|$))+/, '').trim())
    .filter((statement) => statement && !/^--/.test(statement));
}

export async function applySqlMigrations(store, directory) {
  let files;
  try {
    files = (await fs.readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  let appliedStatements = 0;
  for (const name of files) {
    const key = name.replace(/\.sql$/i, '');
    const previous = await store.query(
      'SELECT 1 FROM schema_migrations WHERE `key` = ? LIMIT 1',
      [key],
    );
    if (previous.length > 0) continue;
    const statements = splitSqlStatements(await fs.readFile(path.join(directory, name), 'utf8'));
    await store.transaction(async (tx) => {
      for (const statement of statements) {
        const addColumn = statement.match(
          /^ALTER\s+TABLE\s+([\w]+)\s+ADD\s+COLUMN\s+([\w]+)/i,
        );
        if (addColumn) {
          const [, table, column] = addColumn;
          const existing = await tx.query(
            `SELECT 1 FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
            [table, column],
          );
          if (existing.length > 0) continue;
        }
        const createIndex = statement.match(
          /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+([\w]+)/i,
        );
        if (createIndex) {
          const existing = await tx.query(
            `SELECT 1 FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND index_name = ? LIMIT 1`,
            [createIndex[1]],
          );
          if (existing.length > 0) continue;
        }
        try {
          await tx.query(statement);
        } catch (error) {
          // A column may already be present in a fresh schema even when an
          // older compatibility migration has not been recorded yet. MySQL
          // DDL auto-commits, so this can also occur after an interrupted run.
          if (addColumn && error.code === 'ER_DUP_FIELDNAME') continue;
          throw error;
        }
        appliedStatements += 1;
      }
      await tx.execute(
        'INSERT INTO schema_migrations (`key`, applied_at) VALUES (?, ?)',
        [key, new Date().toISOString()],
      );
    });
  }
  return appliedStatements;
}
