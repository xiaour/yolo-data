import { mapRow } from './dataSourceRow.js';
import { normalizeDataSource } from './dialects/index.js';
import { dataSourceTestState } from './datasourceLifecycle.js';

function nowIso() {
  return new Date().toISOString();
}

function asJson(value) {
  return JSON.stringify(value ?? {});
}

export class DataSourceRepository {
  constructor(db, asyncStore = db) {
    this.db = db;
    this.asyncStore = asyncStore;
  }

  mapRow(row) { return mapRow(row); }

  async listDataSourcesAsync() {
    const rows = await this.asyncStore.query(`SELECT id, code, name, db_type AS dbType,
      host, port, database_name AS databaseName, username,
      encrypted_password AS encryptedPassword, options_json AS optionsJson, status,
      last_test_at AS lastTestAt, last_test_ok AS lastTestOk,
      last_test_message AS lastTestMessage, created_at AS createdAt, updated_at AS updatedAt
      FROM data_sources ORDER BY id`);
    return rows.map((row) => this.mapRow({ ...row, id: Number(row.id) }));
  }

  async getDataSourceAsync(id) {
    return (await this.listDataSourcesAsync()).find((source) => source.id === Number(id)) ?? null;
  }

  async saveDataSourceAsync(payload, id = null) {
    payload = normalizeDataSource(payload);
    const timestamp = nowIso();
    const code = String(payload.code ?? '').trim();
    const name = String(payload.name ?? '').trim();
    if (!code || !name) throw new Error('data source code and name are required');
    const current = id ? await this.getDataSourceAsync(id) : null;
    if (id && !current) throw new Error('data source not found');
    const details = [code, name, String(payload.dbType ?? 'DORIS').toUpperCase(),
      String(payload.host ?? '').trim(), Number(payload.port ?? 9030),
      String(payload.databaseName ?? '').trim(), String(payload.username ?? '').trim(),
      String(payload.encryptedPassword ?? '') || current?.encryptedPassword || '',
      asJson(payload.options ?? {}), Number(payload.status ?? 1)];
    if (id) {
      await this.asyncStore.execute(`UPDATE data_sources SET code=?, name=?, db_type=?, host=?,
        port=?, database_name=?, username=?, encrypted_password=?, options_json=?, status=?,
        updated_at=?, last_test_at=?, last_test_ok=?, last_test_message=? WHERE id=?`,
      [...details, timestamp, ...dataSourceTestState(current, details.slice(2, 9)), Number(id)]);
      return this.getDataSourceAsync(id);
    }
    const result = await this.asyncStore.execute(`INSERT INTO data_sources
      (code, name, db_type, host, port, database_name, username, encrypted_password,
       options_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [...details, timestamp, timestamp]);
    return this.getDataSourceAsync(result.insertId);
  }

  async updateDataSourceTestAsync(id, { ok, message }, source = null) {
    const current = source ?? await this.getDataSourceAsync(id);
    if (!current) return null;
    const fields = ['code', 'db_type', 'host', 'database_name', 'username', 'encrypted_password', 'options_json'];
    const match = fields.map(field => this.asyncStore.backend === 'mysql'
      ? `BINARY ${field} = BINARY ?` : `${field} = ?`).join(' AND ');
    await this.asyncStore.execute(`UPDATE data_sources SET last_test_at=?, last_test_ok=?,
      last_test_message=? WHERE id=? AND port=? AND ${match}`, [
      nowIso(), ok ? 1 : 0, String(message ?? ''), Number(id), Number(current.port),
      current.code, current.dbType, current.host, current.databaseName, current.username,
      current.encryptedPassword ?? '', JSON.stringify(current.options ?? {}),
    ]);
    return this.getDataSourceAsync(id);
  }

  async deleteDataSourceAsync(id) {
    return this.asyncStore.transaction(async (tx) => {
      const [source] = await tx.query('SELECT id FROM data_sources WHERE id = ?', [Number(id)]);
      if (!source) return false;
      const references = await tx.query(`SELECT id, name FROM business_datasets
        WHERE datasource_id = ? ORDER BY id`, [Number(id)]);
      if (references.length) {
        throw Object.assign(new Error(`数据源仍被 ${references.length} 个数据集引用：${references.map((item) => item.name).join('、')}`), {
          statusCode: 409, code: 'DATASOURCE_IN_USE', references,
        });
      }
      const result = await tx.execute('DELETE FROM data_sources WHERE id = ?', [Number(id)]);
      return Number(result.affectedRows) > 0;
    });
  }

  listDataSources() {
    return this.db.prepare(`
      SELECT id, code, name, db_type AS dbType, host, port,
             database_name AS databaseName, username,
             options_json AS optionsJson, status,
             last_test_at AS lastTestAt, last_test_ok AS lastTestOk,
             last_test_message AS lastTestMessage,
             created_at AS createdAt, updated_at AS updatedAt
      FROM data_sources
      ORDER BY id
    `).all().map((row) => this.mapRow(row));
  }

  getDataSource(id) {
    return this.mapRow(this.db.prepare(`
      SELECT id, code, name, db_type AS dbType, host, port,
             database_name AS databaseName, username, encrypted_password AS encryptedPassword,
             options_json AS optionsJson, status,
             last_test_at AS lastTestAt, last_test_ok AS lastTestOk,
             last_test_message AS lastTestMessage,
             created_at AS createdAt, updated_at AS updatedAt
      FROM data_sources WHERE id = ?
    `).get(Number(id)));
  }

  getDataSourceByCode(code) {
    const row = this.db.prepare(
      'SELECT id FROM data_sources WHERE code = ?',
    ).get(String(code));
    return row ? this.getDataSource(row.id) : null;
  }

  async getDataSourceByCodeAsync(code) {
    return (await this.listDataSourcesAsync()).find((source) => source.code === String(code)) ?? null;
  }

  saveDataSource(payload, id = null) {
    const timestamp = nowIso();
    payload = normalizeDataSource(payload);
    const code = String(payload.code ?? '').trim();
    const name = String(payload.name ?? '').trim();
    if (!code || !name) {
      throw new Error('data source code and name are required');
    }
    const values = [
      code,
      name,
      String(payload.dbType ?? 'DORIS').toUpperCase(),
      String(payload.host ?? '').trim(),
      Number(payload.port ?? 9030),
      String(payload.databaseName ?? '').trim(),
      String(payload.username ?? '').trim(),
      String(payload.encryptedPassword ?? ''),
      asJson(payload.options ?? {}),
      Number(payload.status ?? 1),
      timestamp,
    ];
    if (id) {
      const current = this.getDataSource(id);
      if (!current) {
        throw new Error('data source not found');
      }
      this.db.prepare(`
        UPDATE data_sources
        SET code = ?, name = ?, db_type = ?, host = ?, port = ?, database_name = ?, username = ?, encrypted_password = ?,
            options_json = ?, status = ?, updated_at = ?,
            last_test_at = ?, last_test_ok = ?, last_test_message = ?
        WHERE id = ?
      `).run(
        values[0], values[1], values[2], values[3], values[4], values[5],
        values[6], values[7] || current.encryptedPassword, values[8], values[9],
        timestamp, ...dataSourceTestState(current, values.slice(2, 9)), Number(id),
      );
      return this.getDataSource(id);
    }
    const result = this.db.prepare(`
      INSERT INTO data_sources
        (code, name, db_type, host, port, database_name, username,
         encrypted_password, options_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      values[0], values[1], values[2], values[3], values[4], values[5],
      values[6], values[7], values[8], values[9], timestamp, timestamp,
    );
    return this.getDataSource(Number(result.lastInsertRowid));
  }
}
