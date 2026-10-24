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

function asBool(value) {
  return value === 1 || value === true;
}

export function mapRow(row) {
    return row ? {
      ...row,
      options: parseJson(row.optionsJson, {}),
      lastTestOk: row.lastTestOk === null || row.lastTestOk === undefined
        ? null
        : asBool(row.lastTestOk),
    } : null;
  }
