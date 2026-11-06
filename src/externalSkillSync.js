function asJson(value) {
  return JSON.stringify(value ?? []);
}

export function externalSkillUpsertSql(backend) {
  return backend === 'mysql' ? `
        INSERT INTO skills
          (code, name, description, category, kind, tool_name, instruction,
           default_enabled, status, source, source_path, metadata_json,
           phase_tags_json, content, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1,
                'SKILL_MD', ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          name = IF(source = 'SKILL_MD', VALUES(name), name),
          description = IF(source = 'SKILL_MD', VALUES(description), description),
          category = IF(source = 'SKILL_MD', VALUES(category), category),
          kind = IF(source = 'SKILL_MD', VALUES(kind), kind),
          tool_name = IF(source = 'SKILL_MD', VALUES(tool_name), tool_name),
          instruction = IF(source = 'SKILL_MD', VALUES(instruction), instruction),
          source_path = IF(source = 'SKILL_MD', VALUES(source_path), source_path),
          metadata_json = IF(source = 'SKILL_MD', VALUES(metadata_json), metadata_json),
          phase_tags_json = IF(source = 'SKILL_MD', VALUES(phase_tags_json), phase_tags_json),
          content = IF(source = 'SKILL_MD', VALUES(content), content),
          content_hash = IF(source = 'SKILL_MD', VALUES(content_hash), content_hash),
          status = IF(source = 'SKILL_MD', 1, status),
          updated_at = IF(source = 'SKILL_MD', VALUES(updated_at), updated_at)
      ` : `
        INSERT INTO skills
          (code, name, description, category, kind, tool_name, instruction,
           default_enabled, status, source, source_path, metadata_json,
           phase_tags_json, content, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1,
                'SKILL_MD', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          name = excluded.name, description = excluded.description,
          category = excluded.category, kind = excluded.kind,
          tool_name = excluded.tool_name, instruction = excluded.instruction,
          source = excluded.source, source_path = excluded.source_path,
          metadata_json = excluded.metadata_json, phase_tags_json = excluded.phase_tags_json,
          content = excluded.content, content_hash = excluded.content_hash,
          status = 1, updated_at = excluded.updated_at
        WHERE skills.source = 'SKILL_MD'
      `;
}

export function normalizeExternalSkills(skills) {
  return (skills ?? []).map((skill) => ({
      code: String(skill.code ?? '').trim(),
      name: String(skill.name ?? '').trim(),
      description: String(skill.description ?? '').trim(),
      instruction: String(skill.instruction ?? '').trim(),
      sourcePath: skill.sourcePath ? String(skill.sourcePath) : null,
      metadataJson: asJson(skill.metadata ?? {}),
      phaseTagsJson: asJson(skill.phaseTags ?? []),
      content: String(skill.content ?? ''),
      contentHash: String(skill.contentHash ?? ''),
      category: String(skill.category ?? 'EXTERNAL').trim().toUpperCase(),
      kind: String(skill.kind ?? 'INSTRUCTION').trim().toUpperCase(),
      toolName: skill.toolName ? String(skill.toolName).trim() : null,
    })).filter((skill) => skill.code && skill.name);
}
