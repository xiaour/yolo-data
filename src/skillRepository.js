import { externalSkillUpsertSql, normalizeExternalSkills } from './externalSkillSync.js';

function nowIso() {
  return new Date().toISOString();
}

export class SkillRepository {
  constructor(db, asyncStore = db) {
    this.db = db;
    this.asyncStore = asyncStore;
  }

  async listSkillsAsync({ includeDisabled = false } = {}) {
    const rows = await this.asyncStore.query(`
      SELECT code, name, description, category, kind, tool_name AS toolName,
             instruction, default_enabled AS defaultEnabled, status, source,
             source_path AS sourcePath, metadata_json AS metadataJson,
             phase_tags_json AS phaseTagsJson, content, content_hash AS contentHash
      FROM skills
      ${includeDisabled ? '' : 'WHERE status = 1'}
      ORDER BY category, name
    `);
    return rows.map((row) => ({
      ...row,
      defaultEnabled: Boolean(row.defaultEnabled),
      status: Boolean(row.status),
      metadata: parseJson(row.metadataJson, {}),
      phaseTags: parseJson(row.phaseTagsJson, []),
    }));
  }

  async getSkillAsync(code) {
    const skills = await this.listSkillsAsync({ includeDisabled: true });
    return skills.find((skill) => skill.code === String(code)) ?? null;
  }

  async syncExternalSkills(skills = [], { createOnly = false } = {}) {
    const timestamp = nowIso();
    const normalized = normalizeExternalSkills(skills);
    const insertOnlySql = this.asyncStore.backend === 'mysql' ? `
        INSERT IGNORE INTO skills
          (code, name, description, category, kind, tool_name, instruction,
           default_enabled, status, source, source_path, metadata_json,
           phase_tags_json, content, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1,
                'SKILL_MD', ?, ?, ?, ?, ?, ?, ?)
      ` : `
        INSERT OR IGNORE INTO skills
          (code, name, description, category, kind, tool_name, instruction,
           default_enabled, status, source, source_path, metadata_json,
           phase_tags_json, content, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1,
                'SKILL_MD', ?, ?, ?, ?, ?, ?, ?)
      `;
    const upsertSql = externalSkillUpsertSql(this.asyncStore.backend);

    let inserted = 0;
    await this.asyncStore.transaction(async (tx) => {
      for (const skill of normalized) {
        const result = await tx.execute(createOnly ? insertOnlySql : upsertSql, [
          skill.code,
          skill.name,
          skill.description,
          skill.category,
          skill.kind,
          skill.toolName,
          skill.instruction,
          skill.sourcePath,
          skill.metadataJson,
          skill.phaseTagsJson,
          skill.content,
          skill.contentHash,
          timestamp,
          timestamp,
        ]);
        inserted += Number(result?.affectedRows ?? result?.changes ?? 0);
      }
      if (createOnly) return;
      const codes = normalized.map((skill) => skill.code);
      if (codes.length === 0) {
        await tx.execute("DELETE FROM skills WHERE source = 'SKILL_MD'");
      } else {
        const placeholders = codes.map(() => '?').join(', ');
        await tx.execute(`
          DELETE FROM skills
          WHERE source = 'SKILL_MD' AND code NOT IN (${placeholders})
        `, codes);
      }
    });
    return createOnly ? inserted : normalized.length;
  }
}

function parseJson(value, fallback) {
  try { return JSON.parse(value ?? ''); } catch { return fallback; }
}
