// 极简 XLSX 读取器：只依赖 node:zlib，用于把用户上传的 Excel 解析成表格。
// 支持真实 Excel 产物（deflate 压缩 + sharedStrings）与本仓库自带写入器的输出
// （stored + inlineStr），并把日期格式的数值单元格还原成日期文本。
// 这里只做通用格式解析，不包含任何业务口径。

import zlib from 'node:zlib';

const MAX_ROWS = 60_000;
const MAX_COLUMNS = 512;

// 内置的日期/时间格式 ID（ECMA-376 内建 numFmt）。
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22,
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

function unescapeXml(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

// 返回完整元素（含标签与属性），同时兼容自闭合写法（Excel 会大量使用）。
function elementList(xml, tag) {
  const pattern = new RegExp(
    `<${tag}(?:\\s[^>]*)?/>|<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`,
    'g',
  );
  return String(xml ?? '').match(pattern) ?? [];
}

function elementInner(element) {
  if (element === null || element === undefined || /\/>$/.test(element)) {
    return '';
  }
  return String(element).replace(/^<[^>]*>/, '').replace(/<\/[^>]*>$/, '');
}

function innerList(xml, tag) {
  return elementList(xml, tag).map(elementInner);
}

function firstInner(xml, tag) {
  const list = innerList(xml, tag);
  return list.length > 0 ? list[0] : null;
}

function attributeOf(xml, name) {
  const match = String(xml ?? '').match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? unescapeXml(match[1]) : null;
}

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EXTRA_TAG = 0x0001;
const ZIP64_MARKER = 0xffffffff;
// 单条、整体与条目数上限，避免被压缩炸弹拖垮进程。deflate 的最大压缩比约 1032:1，
// 因此只有「解压时就带上限」才算真正的防护：先在中央目录上做一次声明值校验，
// 再让每次 inflate 都带上剩余预算。
const DEFAULT_LIMITS = {
  maxEntryBytes: 192 * 1024 * 1024,
  maxTotalBytes: 384 * 1024 * 1024,
  maxEntries: 512,
};
function tooLargeError() {
  return Object.assign(new Error('xlsx 解压后体积过大，已停止解析'), { statusCode: 400 });
}

// 只有「超出解压预算」这一种错误才应该中止解析；数据本身损坏仍沿用既有的容错语义。
function isOverBudgetError(error) {
  if (!error) {
    return false;
  }
  return error.code === 'ERR_BUFFER_TOO_LARGE'
    || /maxOutputLength|larger than the maximum/i.test(String(error.message ?? ''));
}

// Excel 写出的工作簿普遍带 data descriptor（本地头里的压缩长度为 0），
// 因此必须用 EOCD -> 中央目录作为权威索引，本地头只用来定位数据起点。
// EOCD 的签名偶尔也会出现在压缩数据里，这里要求「中央目录起点 + 中央目录长度 == EOCD 位置」成立。
function isConsistentEocd(buffer, offset) {
  if (offset + 22 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) {
    return false;
  }
  const size = buffer.readUInt32LE(offset + 12);
  const cdOffset = buffer.readUInt32LE(offset + 16);
  return cdOffset + size === offset || (cdOffset === 0 && size === 0);
}

function findEndOfCentralDirectory(buffer) {
  const floor = Math.max(0, buffer.length - 66_000 - 22);
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (isConsistentEocd(buffer, offset)) {
      return offset;
    }
  }
  return -1;
}

// ZIP64 扩展字段只补充那些等于 0xFFFFFFFF 的字段，顺序为未压缩大小、压缩大小、本地头偏移。
function applyZip64Extra(extra, entry) {
  let cursor = 0;
  const read = () => {
    if (cursor + 8 > extra.length) {
      return null;
    }
    const value = Number(extra.readBigUInt64LE(cursor));
    cursor += 8;
    return value;
  };
  if (entry.uncompressedSize === ZIP64_MARKER) {
    entry.uncompressedSize = read() ?? entry.uncompressedSize;
  }
  if (entry.compressedSize === ZIP64_MARKER) {
    entry.compressedSize = read() ?? entry.compressedSize;
  }
  if (entry.localOffset === ZIP64_MARKER) {
    entry.localOffset = read() ?? entry.localOffset;
  }
}

function parseCentralDirectory(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) {
    return null;
  }
  const total = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  if (total === 0 || total === 0xffff || cursor + 46 > buffer.length) {
    return null;
  }
  const index = new Map();
  for (let i = 0; i < total; i += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      break;
    }
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const entry = {
      name: buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'),
      method: buffer.readUInt16LE(cursor + 10),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      uncompressedSize: buffer.readUInt32LE(cursor + 24),
      localOffset: buffer.readUInt32LE(cursor + 42),
    };
    if (extraLength > 0) {
      const extraStart = cursor + 46 + nameLength;
      let extra = extraStart;
      while (extra + 4 <= extraStart + extraLength) {
        const tag = buffer.readUInt16LE(extra);
        const size = buffer.readUInt16LE(extra + 2);
        if (tag === ZIP64_EXTRA_TAG) {
          applyZip64Extra(buffer.subarray(extra + 4, extra + 4 + size), entry);
          break;
        }
        extra += 4 + size;
      }
    }
    index.set(entry.name, entry);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return index.size > 0 ? index : null;
}

// 没有 EOCD 的归档（例如测试里手工拼的字节）退回顺序扫描本地头。
function parseStreamingDirectory(buffer) {
  const index = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === ZIP_LOCAL_SIGNATURE) {
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    index.set(buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'), {
      name: buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'),
      method: buffer.readUInt16LE(offset + 8),
      compressedSize,
      uncompressedSize: buffer.readUInt32LE(offset + 22),
      localOffset: offset,
    });
    if (compressedSize <= 0) {
      break;
    }
    offset = offset + 30 + nameLength + extraLength + compressedSize;
  }
  return index.size > 0 ? index : null;
}

function readEntryData(buffer, entry, budget) {
  const offset = entry.localOffset;
  if (!Number.isFinite(offset) || offset < 0 || offset + 30 > buffer.length
    || buffer.readUInt32LE(offset) !== ZIP_LOCAL_SIGNATURE) {
    return Buffer.alloc(0);
  }
  // 本地头的名称/扩展字段长度可能与中央目录不同，数据起点必须按本地头计算。
  const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
  const size = entry.compressedSize;
  // ZIP64 的 64 位长度可能溢出成非有限值；`start + size > buffer.length` 对 NaN/Infinity
  // 的判断并不可靠，必须显式挡在前面。
  if (!Number.isFinite(size) || size <= 0 || start + size > buffer.length) {
    return Buffer.alloc(0);
  }
  const data = buffer.subarray(start, start + size);
  if (entry.method !== 8) {
    // stored：数据未压缩，预算检查是唯一能拦住超额分配的地方。
    if (data.length > budget) {
      throw tooLargeError();
    }
    return Buffer.from(data);
  }
  try {
    return zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, Math.floor(budget)) });
  } catch (error) {
    if (isOverBudgetError(error)) {
      throw tooLargeError();
    }
    return Buffer.alloc(0);
  }
}

// 归档按需解压：只有真正被读取的条目才会 inflate，避免整包展开占用内存。
class ZipArchive {
  constructor(buffer, index, limits = DEFAULT_LIMITS) {
    this.buffer = buffer;
    this.index = index;
    this.limits = { ...DEFAULT_LIMITS, ...(limits ?? {}) };
    this.decompressedBytes = 0;
  }

  names() {
    return [...this.index.keys()];
  }

  has(name) {
    return this.index.has(name);
  }

  get(name) {
    const entry = this.index.get(name);
    if (!entry) {
      return null;
    }
    if (!entry.data) {
      // 单条预算不能超过「整体剩余预算」，否则多条中等体积的条目可以绕过总量上限。
      const remaining = this.limits.maxTotalBytes - this.decompressedBytes;
      const budget = Math.min(this.limits.maxEntryBytes, remaining);
      if (budget <= 0) {
        throw tooLargeError();
      }
      const data = readEntryData(this.buffer, entry, budget);
      this.decompressedBytes += data.length;
      if (data.length > this.limits.maxEntryBytes
        || this.decompressedBytes > this.limits.maxTotalBytes) {
        throw tooLargeError();
      }
      entry.data = data;
    }
    return entry.data;
  }
}

function openZipArchive(buffer, limits = DEFAULT_LIMITS) {
  let index = null;
  try {
    index = parseCentralDirectory(buffer);
  } catch {
    index = null;
  }
  if (!index) {
    index = parseStreamingDirectory(buffer);
  }
  if (!index) {
    return null;
  }
  const resolved = { ...DEFAULT_LIMITS, ...(limits ?? {}) };
  // 读取任何条目之前先按中央目录的声明值拦截：条目数过多，或声明的未压缩总量
  // 已经超过整体预算，就没有必要再去解压。
  if (index.size > resolved.maxEntries) {
    throw tooLargeError();
  }
  let declaredTotal = 0;
  for (const entry of index.values()) {
    const declared = Number(entry.uncompressedSize);
    if (!Number.isFinite(declared) || declared < 0) {
      throw tooLargeError();
    }
    declaredTotal += declared;
    if (declaredTotal > resolved.maxTotalBytes) {
      throw tooLargeError();
    }
  }
  return new ZipArchive(buffer, index, resolved);
}

function textOf(entry) {
  return entry ? entry.toString('utf8') : '';
}

function isDateFormat(numFmtId, code) {
  if (BUILTIN_DATE_FORMATS.has(Number(numFmtId))) {
    return true;
  }
  if (!code) {
    return false;
  }
  const cleaned = String(code)
    .replace(/\[[^\]]*\]/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '');
  if (/^[#0.,%\s]+$/.test(cleaned)) {
    return false;
  }
  return /[ymdhs]/i.test(cleaned);
}

function parseStyles(stylesXml) {
  if (!stylesXml) {
    return [];
  }
  const custom = new Map();
  const numFmtsBlock = firstInner(stylesXml, 'numFmts');
  for (const item of elementList(numFmtsBlock ?? '', 'numFmt')) {
    custom.set(Number(attributeOf(item, 'numFmtId')), unescapeXml(attributeOf(item, 'formatCode')));
  }
  const cellXfs = firstInner(stylesXml, 'cellXfs') ?? '';
  return elementList(cellXfs, 'xf').map((xf) => {
    const id = Number(attributeOf(xf, 'numFmtId') ?? 0);
    return { numFmtId: id, isDate: isDateFormat(id, custom.get(id)) };
  });
}

function parseSharedStrings(xml) {
  if (!xml) {
    return [];
  }
  return innerList(xml, 'si').map((item) => {
    const runs = innerList(item, 'r');
    if (runs.length === 0) {
      return unescapeXml(firstInner(item, 't') ?? '');
    }
    return runs.map((run) => unescapeXml(firstInner(run, 't') ?? '')).join('');
  });
}

function columnIndexOf(reference) {
  const letters = String(reference ?? '').match(/^[A-Z]+/)?.[0] ?? '';
  let value = 0;
  for (const char of letters) {
    value = value * 26 + (char.charCodeAt(0) - 64);
  }
  return value - 1;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

// Excel 序列号转日期文本；1900 闰年 bug 通过 60 号分界处理。
function serialToDateText(serial) {
  const days = Math.floor(serial);
  const fraction = serial - days;
  const epochDays = days > 59 ? days - 25569 : days - 25568;
  const date = new Date(epochDays * 86_400_000 + Math.round(fraction * 86_400_000));
  if (Number.isNaN(date.getTime())) {
    return String(serial);
  }
  const datePart = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const timePart = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return timePart === '00:00:00' ? datePart : `${datePart} ${timePart}`;
}

function cellText(cellXml, sharedStrings, styles) {
  const type = attributeOf(cellXml, 't') ?? 'n';
  if (type === 'inlineStr') {
    const inline = firstInner(cellXml, 'is') ?? '';
    const runs = innerList(inline, 'r');
    if (runs.length > 0) {
      return runs.map((run) => unescapeXml(firstInner(run, 't') ?? '')).join('');
    }
    return unescapeXml(firstInner(inline, 't') ?? '');
  }
  const raw = unescapeXml(firstInner(cellXml, 'v') ?? '');
  if (raw === '') {
    return '';
  }
  if (type === 's') {
    return sharedStrings[Number(raw)] ?? '';
  }
  if (type === 'b') {
    return raw === '1' ? 'TRUE' : 'FALSE';
  }
  if (type === 'e') {
    return '';
  }
  if (type === 'str') {
    return raw;
  }
  const styleIndex = Number(attributeOf(cellXml, 's') ?? -1);
  const style = styles[styleIndex];
  const numeric = Number(raw);
  if (style?.isDate && Number.isFinite(numeric)) {
    return serialToDateText(numeric);
  }
  return raw;
}

function parseSheetRows(sheetXml, sharedStrings, styles) {
  const rows = [];
  let totalRows = 0;
  for (const rowXml of elementList(sheetXml, 'row')) {
    totalRows += 1;
    if (rows.length >= MAX_ROWS) {
      continue;
    }
    const cells = [];
    for (const cellXml of elementList(rowXml, 'c')) {
      const index = columnIndexOf(attributeOf(cellXml, 'r'));
      if (index < 0 || index >= MAX_COLUMNS) {
        continue;
      }
      cells[index] = cellText(cellXml, sharedStrings, styles);
    }
    rows.push(cells.map((value) => (value === undefined ? '' : String(value))));
  }
  return { rows, totalRows };
}

function resolveSheetPath(entries, workbookXml) {
  const sheets = elementList(workbookXml, 'sheet');
  const firstSheet = sheets[0] ?? '';
  const relationId = attributeOf(firstSheet, 'r:id');
  if (relationId) {
    const rels = textOf(entries.get('xl/_rels/workbook.xml.rels'));
    for (const relation of elementList(rels, 'Relationship')) {
      if (attributeOf(relation, 'Id') === relationId) {
        const target = String(attributeOf(relation, 'Target') ?? '').replace(/^\//, '');
        const normalized = target.startsWith('xl/') ? target : `xl/${target}`;
        if (entries.has(normalized)) {
          return normalized;
        }
      }
    }
  }
  return entries.names()
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))
    .sort()[0] ?? null;
}

// 读取第一个工作表，返回二维文本矩阵（保留表头行）。
export function readXlsxSheet(buffer) {
  const archive = openZipArchive(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? ''));
  if (!archive) {
    throw Object.assign(new Error('文件不是有效的 xlsx 工作簿'), { statusCode: 400 });
  }
  const workbookXml = textOf(archive.get('xl/workbook.xml'));
  const sheetPath = resolveSheetPath(archive, workbookXml);
  if (!sheetPath) {
    throw Object.assign(new Error('xlsx 中未找到工作表'), { statusCode: 400 });
  }
  const sharedStrings = parseSharedStrings(textOf(archive.get('xl/sharedStrings.xml')));
  const styles = parseStyles(textOf(archive.get('xl/styles.xml')));
  const parsed = parseSheetRows(textOf(archive.get(sheetPath)), sharedStrings, styles);
  const rows = parsed.rows
    .filter((values) => values.some((value) => String(value ?? '').trim() !== ''));
  const sheetName = attributeOf(
    elementList(workbookXml, 'sheet')[0] ?? '',
    'name',
  ) ?? 'Sheet1';
  return { sheetName, rows, totalRows: parsed.totalRows, maxRows: MAX_ROWS };
}

export { openZipArchive, serialToDateText, isDateFormat };
