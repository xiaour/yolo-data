// 本地上传文件的通用解析：编码探测、分隔符探测、表头与列名归一、列类型推断。
// 这里只做「格式」判断，不包含任何业务词表、指标名或业务规则；
// 业务字段语义（时间字段、指标字段）一律交给 datasetProfiler + 业务词表。

const MAX_COLUMNS = 500;
const MAX_CELL_CHARS = 4_000;
const INFER_SAMPLE_ROWS = 200;

const DELIMITERS = [',', ';', '\t', '|'];

// 通用数字字面量：可选正负号、可选千分位、可选小数、可选百分号。
const NUMERIC_PATTERN = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?$/;
// 通用日期字面量：ISO 与斜杠两种常见写法，可带时间部分。
const DATE_PATTERNS = [
  /^\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/,
  /^\d{4}\/\d{1,2}\/\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/,
];

function stripBom(text) {
  return String(text ?? '').replace(/^\uFEFF/, '');
}

// 编码探测：先看 BOM，再尝试严格 UTF-8 解码，失败则回退到 GB18030。
// Node 22 自带 full-icu，TextDecoder 已支持 gbk/gb18030，无需额外依赖。
export function decodeBuffer(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return { text: stripBom(bytes.toString('utf8')), encoding: 'utf-8', bom: true };
  }
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return { text: stripBom(bytes.toString('utf16le')), encoding: 'utf-16le', bom: true };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, encoding: 'utf-8', bom: false };
  } catch {
    const text = new TextDecoder('gb18030').decode(bytes);
    return { text, encoding: 'gb18030', bom: false };
  }
}

// 在首屏有效行上统计候选分隔符的列数一致性，取最稳定且列数最多者。
export function detectDelimiter(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(0, 20);
  if (lines.length === 0) {
    return ',';
  }
  let best = { delimiter: ',', columns: 0, stable: false };
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => splitDelimitedLine(line, delimiter).length);
    const first = counts[0] ?? 0;
    if (first < 2) {
      continue;
    }
    const stable = counts.every((count) => count === first);
    if (
      first > best.columns
      || (first === best.columns && stable && !best.stable)
    ) {
      best = { delimiter, columns: first, stable };
    }
  }
  return best.delimiter;
}

// 单行切分（含引号转义），供分隔符探测使用。
function splitDelimitedLine(line, delimiter) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

// 完整的分隔文本解析：支持引号包裹、引号转义、单元格内换行与 CRLF。
export function parseDelimitedText(text, { delimiter = ',' } = {}) {
  const source = String(text ?? '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let limitReached = false;

  const pushCell = () => {
    row.push(cell.length > MAX_CELL_CHARS ? cell.slice(0, MAX_CELL_CHARS) : cell);
    cell = '';
  };
  const pushRow = () => {
    pushCell();
    const hasContent = row.some((value) => String(value).trim() !== '');
    if (hasContent) {
      rows.push(row);
    }
    row = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.trim() === '') {
      cell = '';
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      pushCell();
      continue;
    }
    if (char === '\n') {
      pushRow();
      continue;
    }
    if (char === '\r') {
      continue;
    }
    cell += char;
  }
  pushRow();

  const header = rows.shift() ?? [];
  return {
    columns: header.map((value) => String(value ?? '').trim()),
    rows: rows.map((values) => values.map((value) => String(value ?? ''))),
  };
}

// JSON 文本解析：接受对象数组、单对象，或 { data: [...] } / { rows: [...] } 包装。
export function parseJsonText(text) {
  let parsed;
  try {
    parsed = JSON.parse(stripBom(String(text ?? '')));
  } catch (error) {
    throw Object.assign(new Error(`JSON 文件解析失败：${error.message}`), { statusCode: 400 });
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.rows)
      ? parsed.rows
      : Array.isArray(parsed?.data)
        ? parsed.data
        : [parsed];
  const records = list.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  if (records.length === 0) {
    throw Object.assign(new Error('JSON 文件中没有可用的记录对象'), { statusCode: 400 });
  }
  const columns = [...new Set(records.flatMap((record) => Object.keys(record)))]
    .slice(0, MAX_COLUMNS);
  return {
    columns,
    rows: records.map((record) => columns.map((key) => {
      const value = record[key];
      if (value === null || value === undefined) {
        return '';
      }
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    })),
  };
}

// 列名归一：去空白、空列名补位、重名加后缀，并生成稳定的 ASCII bizName。
export function normalizeColumnNames(columns = []) {
  const seen = new Map();
  return columns.slice(0, MAX_COLUMNS).map((raw, index) => {
    const base = String(raw ?? '').replace(/\s+/g, ' ').trim() || `列${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const name = count === 1 ? base : `${base}_${count}`;
    const ascii = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
    return {
      name,
      bizName: ascii ? name : `c${index + 1}`,
      index,
    };
  });
}

function isBlank(value) {
  return String(value ?? '').trim() === '';
}

// 列类型推断：全空视为空列；非空值全部命中数字/日期字面量才判定为对应类型。
export function inferColumnType(values = []) {
  const samples = values
    .map((value) => String(value ?? '').trim())
    .filter((value) => value !== '')
    .slice(0, INFER_SAMPLE_ROWS);
  if (samples.length === 0) {
    return { showType: 'STRING', type: 'STRING', normalized: false };
  }
  const numeric = samples.every((value) => NUMERIC_PATTERN.test(value));
  if (numeric) {
    return {
      showType: 'NUMBER',
      type: 'NUMBER',
      normalized: samples.some((value) => value.includes(',') || value.endsWith('%')),
    };
  }
  const dated = samples.every((value) => DATE_PATTERNS.some((pattern) => pattern.test(value)));
  if (dated) {
    return { showType: 'DATE', type: 'DATE', normalized: false };
  }
  return { showType: 'STRING', type: 'STRING', normalized: false };
}

// 数字字面量归一：去掉千分位与百分号，保留符号与小数。
function toNumberLiteral(value) {
  const text = String(value ?? '').trim();
  const negative = text.startsWith('-');
  const cleaned = text.replace(/[,%\s]/g, '').replace(/^[+-]/, '');
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    return text;
  }
  return negative ? -parsed : parsed;
}

// 把二维文本表转成平台列契约（columns + rows），并按类型归一数值单元格。
export function buildTable({ columns = [], rows = [], maxRows = Infinity } = {}) {
  const normalized = normalizeColumnNames(columns);
  const trimmedRows = rows.slice(0, Number.isFinite(maxRows) ? maxRows : rows.length);
  const warnings = [];
  const spec = normalized.map((column) => {
    const values = trimmedRows.map((row) => row?.[column.index]);
    const type = inferColumnType(values);
    if (type.normalized) {
      warnings.push(`列「${column.name}」的千分位或百分号已按数值归一，原始文本保留在原始文件产物中`);
    }
    return { ...column, ...type };
  });
  const emptyColumns = spec
    .filter((column) => trimmedRows.every((row) => isBlank(row?.[column.index])))
    .map((column) => column.name);
  const outputColumns = spec.map((column) => ({
    name: column.name,
    bizName: column.bizName,
    showType: column.showType,
    type: column.type,
    unit: '',
  }));
  const outputRows = trimmedRows.map((row) => {
    const record = {};
    for (const column of spec) {
      const raw = row?.[column.index];
      record[column.bizName] = column.showType === 'NUMBER' && !isBlank(raw)
        ? toNumberLiteral(raw)
        : String(raw ?? '');
    }
    return record;
  });
  return { columns: outputColumns, rows: outputRows, warnings, emptyColumns };
}

// 统一的表格文件入口：按格式分派到分隔文本或 JSON 解析。
export function parseTabularContent({ content, format = 'csv', maxRows = Infinity } = {}) {
  const extension = String(format ?? '').toLowerCase().replace(/^\./, '');
  const decoded = decodeBuffer(Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8'));
  if (extension === 'json') {
    const parsed = parseJsonText(decoded.text);
    const table = buildTable({ columns: parsed.columns, rows: parsed.rows, maxRows });
    return { ...table, encoding: decoded.encoding, delimiter: null, truncated: parsed.rows.length > maxRows };
  }
  const delimiter = extension === 'tsv' ? '\t' : detectDelimiter(decoded.text);
  const parsed = parseDelimitedText(decoded.text, { delimiter });
  const table = buildTable({ columns: parsed.columns, rows: parsed.rows, maxRows });
  return {
    ...table,
    encoding: decoded.encoding,
    delimiter,
    truncated: parsed.rows.length > maxRows,
  };
}

export {
  DELIMITERS,
  MAX_COLUMNS,
  MAX_CELL_CHARS,
  splitDelimitedLine,
};
