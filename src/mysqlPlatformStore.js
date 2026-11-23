import path from 'node:path';
import fs from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { applySqlMigrations, splitSqlStatements } from './mysqlMigrations.js';

function normalizeConfig(config = {}) {
  const database = String(config.database ?? '').trim();
  const user = String(config.user ?? '').trim();
  if (!database || !user) {
    throw new Error('平台 MySQL 必须配置 PLATFORM_DB_NAME 和 PLATFORM_DB_USER');
  }
  return {
    host: String(config.host ?? '127.0.0.1').trim(),
    port: Number(config.port ?? 3306),
    database,
    user,
    password: String(config.password ?? ''),
    charset: String(config.charset ?? 'utf8mb4').trim() || 'utf8mb4',
    waitForConnections: true,
    connectionLimit: Math.max(1, Number(config.connectionLimit ?? 10) || 10),
    timezone: 'Z',
  };
}

export class MysqlPlatformStore {
  constructor(config = {}, { poolFactory = mysql.createPool } = {}) {
    this.config = normalizeConfig(config);
    this.initSqlPath = String(config.initSqlPath ?? './config/platform/mysql-init.sql').trim();
    this.poolFactory = poolFactory;
    this.pool = null;
  }

  async connect() {
    if (!this.pool) {
      this.pool = this.poolFactory(this.config);
    }
    const connection = await this.pool.getConnection();
    connection.release();
    return this;
  }
  async query(sql, values = []) {
    if (!this.pool) await this.connect();
    const [rows] = await this.pool.query(sql, values);
    return rows;
  }

  async execute(sql, values = []) {
    if (!this.pool) await this.connect();
    const [result] = await this.pool.execute(sql, values);
    return result;
  }

  async transaction(callback) {
    if (!this.pool) await this.connect();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await callback({
        query: (sql, values = []) => connection.query(sql, values).then(([rows]) => rows),
        execute: (sql, values = []) => connection.execute(sql, values).then(([value]) => value),
      });
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async initialize(sqlPath = this.initSqlPath) {
    const source = await fs.readFile(sqlPath, 'utf8');
    const statements = splitSqlStatements(source);
    if (!this.pool) this.pool = this.poolFactory(this.config);
    const connection = await this.pool.getConnection();
    try {
      for (const statement of statements) {
        try {
          await connection.query(statement);
        } catch (error) {
          // The generated bootstrap uses idempotent tables, but MySQL does not
          // support CREATE INDEX IF NOT EXISTS. Re-running it may hit this case.
          if (error.code !== 'ER_DUP_KEYNAME') throw error;
        }
      }
    } finally {
      connection.release();
    }
    const migrationDirectory = path.join(path.dirname(sqlPath), 'mysql-migrations');
    return statements.length + await this.applySqlMigrations(migrationDirectory);
  }

  async applySqlMigrations(directory) {
    return applySqlMigrations(this, directory);
  }

  async close() {
    await this.pool?.end();
    this.pool = null;
  }
}

export { normalizeConfig as normalizeMysqlPlatformConfig };
