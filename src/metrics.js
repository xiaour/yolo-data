// Minimal, dependency-free counters so gate/limit behaviour can be observed
// without pulling in a metrics client (keeps the zero-build/no-runtime-deps
// constraint). Metrics only aggregate: audit tables remain the evidence source.

const counters = new Map();

function escapeLabelValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function labelKey(labels = {}) {
  return Object.entries(labels)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(',');
}

export function incrementCounter(name, labels = {}, value = 1) {
  const normalizedName = String(name ?? '').trim();
  if (!normalizedName) {
    return 0;
  }
  const key = `${normalizedName}{${labelKey(labels)}}`;
  const next = (counters.get(key) ?? 0) + (Number(value) || 0);
  counters.set(key, next);
  return next;
}

export function getCounter(name, labels = {}) {
  return counters.get(`${name}{${labelKey(labels)}}`) ?? 0;
}

export function snapshotMetrics() {
  const result = {};
  for (const [key, value] of counters.entries()) {
    const separator = key.indexOf('{');
    const name = key.slice(0, separator);
    result[name] ??= {};
    result[name][key.slice(separator + 1, -1)] = value;
  }
  return result;
}

export function renderMetrics() {
  const lines = [];
  const sorted = [...counters.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  let currentName = null;
  for (const [key, value] of sorted) {
    const name = key.slice(0, key.indexOf('{'));
    if (name !== currentName) {
      lines.push(`# TYPE ${name} counter`);
      currentName = name;
    }
    lines.push(`${name}{${key.slice(key.indexOf('{') + 1, -1)}} ${value}`);
  }
  return `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
}

export function resetMetrics() {
  counters.clear();
}
