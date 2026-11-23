import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import knexFactory from 'knex';
import { DatabaseSync } from 'node:sqlite';
import { splitSqlStatements } from './mysqlMigrations.js';

function normalizeBackend(value) {
  const backend = String(value ?? 'sqlite').trim().toLowerCase();
  if (!['sqlite', 'mysql'].includes(backend)) throw new Error(`Unsupported platform database backend: ${backend}`);
  return backend;
}

export function createKnexPlatformStore(config = {}, { knex = knexFactory } = {}) {
  const backend = normalizeBackend(config.backend);
  if (backend === 'sqlite') {
    const rawFilename = config.path ?? './data/platform.db';
    const filename = rawFilename === ':memory:' ? rawFilename : path.resolve(rawFilename);
    if (filename !== ':memory:') fsSync.mkdirSync(path.dirname(filename), { recursive: true });
    const database = new DatabaseSync(filename);
    database.exec('PRAGMA foreign_keys = ON');
    return new NativeSqlitePlatformStore(database, config);
  }
  const connection = backend === 'mysql'
    ? {
      host: config.mysql?.host ?? config.host ?? '127.0.0.1',
      port: Number(config.mysql?.port ?? config.port ?? 3306),
      user: config.mysql?.user ?? config.user,
      password: config.mysql?.password ?? config.password,
      database: config.mysql?.database ?? config.database,
      charset: config.mysql?.charset ?? 'utf8mb4',
      timezone: 'Z',
      connectionLimit: Math.max(1, Number(config.mysql?.connectionLimit ?? 10) || 10),
    }
    : {
      filename: path.resolve(config.path ?? './data/platform.db'),
      ...(config.filename ? { filename: config.filename } : {}),
    };
  const client = knex({
    client: 'mysql2',
    connection,
    pool: { min: 0, max: connection.connectionLimit ?? 10 },
  });
  return new KnexPlatformStore(client, backend, config);
}

class NativeSqlitePlatformStore {
  constructor(database, config = {}) {
    this.database = database;
    this.backend = 'sqlite';
    this.initSqlPath = config.initSqlPath ?? './config/platform/sqlite-init.sql';
  }

  async connect() { this.database.prepare('SELECT 1').get(); return this; }
  async query(sql, bindings = []) { return this.database.prepare(sql).all(...bindings); }
  async execute(sql, bindings = []) {
    const result = this.database.prepare(sql).run(...bindings);
    return { affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid ?? 0) };
  }
  async transaction(callback) {
    this.database.exec('BEGIN');
    try {
      const result = await callback({
        query: (sql, bindings = []) => this.query(sql, bindings),
        execute: (sql, bindings = []) => this.execute(sql, bindings),
      });
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  async initialize(sqlPath = this.initSqlPath) {
    const statements = splitSqlStatements(await fs.readFile(sqlPath, 'utf8'));
    for (const statement of statements) {
      try { this.database.exec(statement); }
      catch (error) { if (!/already exists/i.test(error.message)) throw error; }
    }
    const migrationDirectory = path.join(path.dirname(sqlPath), 'sqlite-migrations');
    return statements.length + await this.applySqlMigrations(migrationDirectory);
  }
  async applySqlMigrations(directory) {
    let files;
    try { files = (await fs.readdir(directory)).filter((name) => name.endsWith('.sql')).sort(); }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    let count = 0;
    for (const name of files) {
      const key = name.replace(/\.sql$/i, '');
      if ((await this.query('SELECT 1 FROM schema_migrations WHERE "key"=? LIMIT 1', [key])).length) continue;
      const statements = splitSqlStatements(await fs.readFile(path.join(directory, name), 'utf8'));
      await this.transaction(async (tx) => {
        for (const statement of statements) { await tx.query(statement); count += 1; }
        await tx.execute('INSERT INTO schema_migrations ("key", applied_at) VALUES (?, ?)', [key, new Date().toISOString()]);
      });
    }
    return count;
  }
  async close() { this.database.close(); }
}

export class KnexPlatformStore {
  constructor(knex, backend, config = {}) {
    this.knex = knex;
    this.backend = backend;
    this.initSqlPath = config.initSqlPath ?? (backend === 'mysql'
      ? './config/platform/mysql-init.sql' : './config/platform/sqlite-init.sql');
  }

  async connect() {
    await this.knex.raw('SELECT 1');
    return this;
  }

  async query(sql, bindings = []) {
    const result = await this.knex.raw(sql, bindings);
    if (this.backend === 'mysql') return result[0];
    return result;
  }

  async execute(sql, bindings = []) {
    const result = await this.knex.raw(sql, bindings);
    if (this.backend === 'mysql') {
      const header = result[0];
      return { affectedRows: Number(header.affectedRows ?? 0), insertId: Number(header.insertId ?? 0), ...header };
    }
    const [metadata] = await this.knex.raw('SELECT changes() AS affectedRows, last_insert_rowid() AS insertId');
    return { affectedRows: Number(metadata?.affectedRows ?? 0), insertId: Number(metadata?.insertId ?? 0), result };
  }

  async transaction(callback) {
    return this.knex.transaction(async (trx) => callback({
      query: async (sql, bindings = []) => {
        const result = await trx.raw(sql, bindings);
        return this.backend === 'mysql' ? result[0] : result;
      },
      execute: async (sql, bindings = []) => {
        const result = await trx.raw(sql, bindings);
        if (this.backend === 'mysql') {
          const header = result[0];
          return { affectedRows: Number(header.affectedRows ?? 0), insertId: Number(header.insertId ?? 0), ...header };
        }
        const [metadata] = await trx.raw('SELECT changes() AS affectedRows, last_insert_rowid() AS insertId');
        return { affectedRows: Number(metadata?.affectedRows ?? 0), insertId: Number(metadata?.insertId ?? 0), result };
      },
    }));
  }

  async initialize(sqlPath = this.initSqlPath) {
    const statements = splitSqlStatements(await fs.readFile(sqlPath, 'utf8'));
    for (const statement of statements) {
      try {
        await this.knex.raw(statement);
      } catch (error) {
        if (this.backend === 'mysql' && error.code === 'ER_DUP_KEYNAME') continue;
        if (this.backend === 'sqlite' && /already exists/i.test(error.message)) continue;
        throw error;
      }
    }
    const migrationDirectory = path.join(path.dirname(sqlPath), `${this.backend}-migrations`);
    return statements.length + await this.applySqlMigrations(migrationDirectory);
  }

  async applySqlMigrations(directory) {
    let files;
    try { files = (await fs.readdir(directory)).filter((name) => name.endsWith('.sql')).sort(); }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    let count = 0;
    for (const name of files) {
      const key = name.replace(/\.sql$/i, '');
      const keyColumn = this.backend === 'mysql' ? '`key`' : '"key"';
      const existing = await this.query(`SELECT 1 FROM schema_migrations WHERE ${keyColumn} = ? LIMIT 1`, [key]);
      if (existing.length) continue;
      const statements = splitSqlStatements(await fs.readFile(path.join(directory, name), 'utf8'));
      await this.transaction(async (tx) => {
        for (const statement of statements) {
          try {
            await tx.query(statement);
          } catch (error) {
            // Init scripts and migrations intentionally overlap so a fresh
            // database and an upgraded database converge on the same schema.
            if (!(this.backend === 'mysql' && ['ER_DUP_KEYNAME', 'ER_DUP_FIELDNAME'].includes(error.code))) {
              throw error;
            }
          }
          count += 1;
        }
        await tx.execute(`INSERT INTO schema_migrations (${keyColumn}, applied_at) VALUES (?, ?)`, [key, new Date().toISOString()]);
      });
    }
    return count;
  }

  async close() { await this.knex.destroy(); }
}

export function attachKnexPlatformStore(target, store) {
  target.query = (sql, bindings = []) => store.query(sql, bindings);
  target.execute = (sql, bindings = []) => store.execute(sql, bindings);
  target.transaction = (callback) => store.transaction(callback);
  target.knexStore = store;
  return target;
}
