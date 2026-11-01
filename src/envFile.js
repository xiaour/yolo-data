import fs from 'node:fs';
import path from 'node:path';

function parseEnvValue(value) {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'" || quote === '`') && trimmed.endsWith(quote)) {
    const body = trimmed.slice(1, -1);
    return quote === '"'
      ? body.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      : body;
  }
  return trimmed.replace(/\s+#.*$/, '').trim();
}

export function parseEnvFile(text) {
  const values = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    values[match[1]] = parseEnvValue(match[2]);
  }
  return values;
}

// Existing process environment always wins; .env fills only unset/empty keys.
export function loadEnvFile({
  projectRoot,
  filePath = path.join(projectRoot, '.env'),
  target = process.env,
} = {}) {
  if (!fs.existsSync(filePath)) return { filePath, loaded: [], skipped: [] };
  const values = parseEnvFile(fs.readFileSync(filePath, 'utf8'));
  const loaded = [];
  const skipped = [];
  for (const [key, value] of Object.entries(values)) {
    if (target[key] === undefined || target[key] === '') {
      target[key] = value;
      loaded.push(key);
    } else {
      skipped.push(key);
    }
  }
  return { filePath, loaded, skipped };
}
