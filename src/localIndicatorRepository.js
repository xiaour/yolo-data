import crypto from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export class LocalIndicatorRepository {
  constructor(db) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_indicators (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        biz_name TEXT NOT NULL,
        type_id TEXT NOT NULL DEFAULT '',
        type_name TEXT NOT NULL DEFAULT '通用指标',
        indicator_level TEXT NOT NULL DEFAULT 'ATOMIC',
        business_caliber TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        department TEXT NOT NULL DEFAULT '',
        status INTEGER NOT NULL DEFAULT 1,
        metrics_json TEXT NOT NULL DEFAULT '[]',
        dimensions_json TEXT NOT NULL DEFAULT '[]',
        models_json TEXT NOT NULL DEFAULT '[]',
        raw_json TEXT NOT NULL DEFAULT '{}',
        synced_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_indicators_name ON local_indicators(name);
      CREATE INDEX IF NOT EXISTS idx_local_indicators_type ON local_indicators(type_id);
    `);
  }

  save(payload, id = null) {
    const indicatorId = id
      ? String(id).trim()
      : `local:${crypto.randomUUID()}`;
    if (!indicatorId.startsWith('local:')) {
      throw new Error('local indicator id must use the local: prefix');
    }
    const name = String(payload.name ?? '').trim();
    const bizName = String(payload.bizName ?? '').trim();
    if (!name || !bizName) {
      throw new Error('指标名称和指标标识不能为空');
    }
    const timestamp = nowIso();
    const indicator = {
      id: indicatorId,
      name,
      bizName,
      typeId: String(payload.typeId ?? '').trim(),
      typeName: String(payload.typeName ?? '').trim() || '通用指标',
      indicatorLevel: String(payload.indicatorLevel ?? 'ATOMIC').trim().toUpperCase(),
      businessCaliber: String(payload.businessCaliber ?? '').trim(),
      description: String(payload.description ?? '').trim(),
      owner: String(payload.owner ?? '').trim(),
      department: String(payload.department ?? '').trim(),
      status: payload.status === 0 ? 0 : 1,
      metrics: Array.isArray(payload.metrics) ? payload.metrics : [],
      dimensions: Array.isArray(payload.dimensions) ? payload.dimensions : [],
      models: Array.isArray(payload.models) ? payload.models : [],
      raw: {
        ...(payload.raw && typeof payload.raw === 'object' ? payload.raw : {}),
        localManaged: true,
      },
    };
    this.db.prepare(`
      INSERT INTO local_indicators (
        id, name, biz_name, type_id, type_name, indicator_level,
        business_caliber, description, owner, department, status,
        metrics_json, dimensions_json, models_json, raw_json, synced_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        biz_name = excluded.biz_name,
        type_id = excluded.type_id,
        type_name = excluded.type_name,
        indicator_level = excluded.indicator_level,
        business_caliber = excluded.business_caliber,
        description = excluded.description,
        owner = excluded.owner,
        department = excluded.department,
        status = excluded.status,
        metrics_json = excluded.metrics_json,
        dimensions_json = excluded.dimensions_json,
        models_json = excluded.models_json,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `).run(
      indicatorId,
      indicator.name,
      indicator.bizName,
      indicator.typeId,
      indicator.typeName,
      indicator.indicatorLevel,
      indicator.businessCaliber,
      indicator.description,
      indicator.owner,
      indicator.department,
      indicator.status,
      JSON.stringify(indicator.metrics),
      JSON.stringify(indicator.dimensions),
      JSON.stringify(indicator.models),
      JSON.stringify(indicator.raw),
      timestamp,
      timestamp,
    );
    return this.get(indicatorId);
  }

  get(id) {
    return this.mapRow(this.db.prepare(`
      SELECT id, name, biz_name AS bizName, type_id AS typeId,
             type_name AS typeName, indicator_level AS indicatorLevel,
             business_caliber AS businessCaliber, description, owner, department,
             status, metrics_json AS metricsJson, dimensions_json AS dimensionsJson,
             models_json AS modelsJson, raw_json AS rawJson,
             synced_at AS syncedAt, updated_at AS updatedAt
      FROM local_indicators WHERE id = ?
    `).get(String(id)));
  }

  delete(id) {
    const result = this.db.prepare(
      'DELETE FROM local_indicators WHERE id = ?',
    ).run(String(id));
    return Number(result.changes ?? 0) > 0;
  }

  list({ keyword = '', typeId = '', limit = 500 } = {}) {
    const normalizedKeyword = String(keyword).trim().toLowerCase();
    const normalizedTypeId = String(typeId ?? '').trim();
    const rows = this.db.prepare(`
      SELECT id, name, biz_name AS bizName, type_id AS typeId,
             type_name AS typeName, indicator_level AS indicatorLevel,
             business_caliber AS businessCaliber, description, owner, department,
             status, metrics_json AS metricsJson, dimensions_json AS dimensionsJson,
             models_json AS modelsJson, raw_json AS rawJson,
             synced_at AS syncedAt, updated_at AS updatedAt
      FROM local_indicators ORDER BY name
    `).all().map((row) => this.mapRow(row));
    return rows
      .filter((item) => !normalizedTypeId || String(item.typeId) === normalizedTypeId)
      .filter((item) => !normalizedKeyword || [
        item.name,
        item.bizName,
        item.description,
        item.businessCaliber,
        item.typeName,
      ].some((value) => String(value ?? '').toLowerCase().includes(normalizedKeyword)))
      .slice(0, Math.max(1, Math.min(Number(limit) || 500, 2000)));
  }

  listTypes() {
    const byId = new Map();
    for (const indicator of this.list({ limit: 2000 })) {
      const id = String(indicator.typeId || indicator.typeName);
      if (id && !byId.has(id)) {
        byId.set(id, {
          id,
          name: indicator.typeName || id,
          code: '',
          parentId: '',
        });
      }
    }
    return [...byId.values()];
  }

  count() {
    return Number(this.db.prepare(
      'SELECT COUNT(*) AS count FROM local_indicators',
    ).get()?.count ?? 0);
  }

  mapRow(row) {
    if (!row) {
      return null;
    }
    return {
      ...row,
      metrics: parseJson(row.metricsJson, []),
      dimensions: parseJson(row.dimensionsJson, []),
      models: parseJson(row.modelsJson, []),
      raw: parseJson(row.rawJson, {}),
    };
  }
}
