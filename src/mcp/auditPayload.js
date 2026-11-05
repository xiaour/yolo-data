export function sanitize(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitize);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (/key|secret|token|password|authorization/i.test(key)) {
        out[key] = '***';
        continue;
      }
      out[key] = val && typeof val === 'object' ? sanitize(val) : (
        typeof val === 'string' && val.length > 200 ? `${val.slice(0, 200)}…` : val
      );
    }
    return out;
  }
  return value;
}

export function summarize(result) {
  if (!result || !Array.isArray(result.content)) return undefined;
  try {
    const text = result.content.map((c) => c?.text ?? '').join(' ');
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return undefined;
  }
}

