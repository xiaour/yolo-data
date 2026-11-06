export function mysqlize(sql) {
  let converted = sql
    .replace(/\bINTEGER PRIMARY KEY AUTOINCREMENT\b/gi, 'BIGINT AUTO_INCREMENT PRIMARY KEY')
    .replace(/\bINTEGER\b/gi, 'BIGINT')
    .replace(/\bREAL\b/gi, 'DOUBLE')
    .replace(/\bTEXT\b/gi, 'VARCHAR(255)')
    .replace(/\bBLOB\b/gi, 'LONGBLOB')
    .replace(/\s+DESC\b/gi, ' DESC')
    .replace(/\s+ASC\b/gi, ' ASC');
  const tableName = converted.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w]+)/i)?.[1]?.toLowerCase();
  const indexColumnLengths = {
    semantic_value_domains: { source_type: 64, source_id: 128 },
    theme_semantic_value_domains: { source_type: 64, source_id: 128 },
    semantic_value_snapshots: { source_type: 64, source_id: 128 },
    semantic_value_overrides: { source_type: 64, source_id: 128, action: 32 },
  }[tableName] ?? {};
  if (tableName === 'platform_settings') {
    converted = converted.replace(/(^|\n)(\s*value_json\s+)VARCHAR\(255\)([^\n]*)/i, (_match, prefix, column, suffix) =>
      `${prefix}${column}LONGTEXT${suffix.replace(/\s+DEFAULT\s+(?:'[^']*'|NULL)/i, '')}`);
  }
  for (const [column, length] of Object.entries(indexColumnLengths)) {
    converted = converted.replace(new RegExp(`(^|\\n)(\\s*${column}\\s+)VARCHAR\\(255\\)`, 'i'), `$1$2VARCHAR(${length})`);
  }
  return converted.split('\n').map((line) => {
    line = line.replace(/^(\s*)key(?=\s)/i, '$1`key`');
    line = line.replace(/^(\s*)trigger(?=\s)/i, '$1`trigger`');
    const match = line.match(/^(\s*)([a-z_]+) VARCHAR\(255\)(.*)$/i);
    if (!match) return line;
    const indexedLength = indexColumnLengths[match[2].toLowerCase()];
    if (indexedLength) return `${match[1]}${match[2]} VARCHAR(${indexedLength})${match[3]}`;
    const longText = /(_json|content|instruction|prompt|answer|question|description|sql_text|error_message|raw_json|metadata_json|operation_json|payload_json|contract_json|scopes|detail_json|resolution_json|context_json)/i.test(match[2]);
    if (!longText) return line;
    return `${match[1]}${match[2]} LONGTEXT${match[3].replace(/\s+DEFAULT\s+(?:'[^']*'|NULL)/i, '')}`;
  }).join('\n');
}
