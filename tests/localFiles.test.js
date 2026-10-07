import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { PlatformDatabase } from '../src/database.js';
import { WorkspaceService } from '../src/workspace.js';
import { UploadService } from '../src/uploads.js';
import { CodeExecutionService } from '../src/codeExecution.js';
import { parseTabularContent, detectDelimiter, decodeBuffer } from '../src/fileParsing.js';
import { openZipArchive, readXlsxSheet } from '../src/xlsxReader.js';
import { loadConfig } from '../src/config.js';
import { SessionMemoryStore } from '../src/memory.js';
import {
  resolveQuestionAttachments,
  appendUserQuestionWithAttachments,
} from '../src/chatAttachments.js';
import { createXlsxBuffer } from '../src/xlsx.js';
import { buildRouteTable, startServer } from '../src/server.js';
import { FakeIndicatorClient } from './fixtures/fakeIndicatorClient.js';

// 真实 GBK 字节：'名称,数量\n测试,3\n北京,5\n'
const GBK_CSV = Buffer.from([
  0xC3, 0xFB, 0xB3, 0xC6, 0x2C, 0xCA, 0xFD, 0xC1, 0xBF, 0x0A,
  0xB2, 0xE2, 0xCA, 0xD4, 0x2C, 0x33, 0x0A, 0xB1, 0xB1, 0xBE, 0xA9, 0x2C, 0x35, 0x0A,
]);

// 真实 Excel 产物的字节：deflate 压缩 + sharedStrings + 日期样式（46235 -> 2026-08-01）。
const REAL_XLSX_BASE64 = "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";

function createHarness(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-upload-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  const workspace = new WorkspaceService(database);
  const uploads = new UploadService({
    database,
    workspace,
    config: { uploads: overrides },
  });
  const user = database.getUserByUsername('admin');
  const theme = database.listThemes()[0];
  const session = database.createChatSession({
    userId: user.id,
    themeId: theme.id,
    title: '本地上传测试',
  });
  return {
    directory, database, workspace, uploads, user, theme, session,
  };
}

function toBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

test('local file parsing detects delimiter, quotes, encoding and column types', () => {
  const quoted = '省区,销售额,备注\n上海,"1,234.5","第一行\n第二行"\n北京,20%,\n';
  const parsed = parseTabularContent({ content: Buffer.from(quoted, 'utf8'), format: 'csv' });
  assert.deepEqual(parsed.columns.map((column) => column.name), ['省区', '销售额', '备注']);
  assert.equal(parsed.columns[1].showType, 'NUMBER');
  assert.equal(parsed.columns[0].showType, 'STRING');
  assert.equal(parsed.rows[0].c2, 1234.5);
  assert.equal(parsed.rows[0].c3, '第一行\n第二行');
  assert.equal(parsed.rows[1].c3, '');
  assert.equal(parsed.delimiter, ',');
  assert.equal(parsed.encoding, 'utf-8');

  const semicolon = parseTabularContent({
    content: Buffer.from('a;b\n1;2\n', 'utf8'),
    format: 'csv',
  });
  assert.equal(semicolon.delimiter, ';');
  assert.deepEqual(semicolon.rows[0], { a: 1, b: 2 });

  const tsv = parseTabularContent({
    content: Buffer.from('a\tb\nx\ty\n', 'utf8'),
    format: 'tsv',
  });
  assert.deepEqual(tsv.columns.map((column) => column.name), ['a', 'b']);

  const json = parseTabularContent({
    content: Buffer.from(JSON.stringify([{ code: 'A', amount: 3 }]), 'utf8'),
    format: 'json',
  });
  assert.deepEqual(json.rows, [{ code: 'A', amount: 3 }]);

  const wrapped = parseTabularContent({
    content: Buffer.from(JSON.stringify({ rows: [{ code: 'B' }] }), 'utf8'),
    format: 'json',
  });
  assert.deepEqual(wrapped.rows, [{ code: 'B' }]);
});

test('GBK encoded CSV files decode without extra dependencies', () => {
  const decoded = decodeBuffer(GBK_CSV);
  assert.equal(decoded.encoding, 'gb18030');
  assert.match(decoded.text, /名称,数量/);

  const parsed = parseTabularContent({ content: GBK_CSV, format: 'csv' });
  assert.deepEqual(parsed.columns.map((column) => column.name), ['名称', '数量']);
  assert.deepEqual(parsed.rows, [{ c1: '测试', c2: 3 }, { c1: '北京', c2: 5 }]);
});

// Excel 真实产物的写入口径：本地头里的 crc 与长度全为 0，
// 真实值只写在紧跟数据的 data descriptor 和中央目录里。
function buildZipWithDataDescriptors(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data, 'utf8');
    const data = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(data.length, 8);
    descriptor.writeUInt32LE(raw.length, 12);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0808, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, data, descriptor);
    centrals.push(central, name);
    offset += local.length + name.length + data.length + descriptor.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

test('xlsx written with data descriptors is parsed', () => {
  const buffer = buildZipWithDataDescriptors([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
    {
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0"?><workbook><sheets>'
        + '<sheet name="订单" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: '<worksheet><sheetData>'
        + '<row r="1"><c r="A1" t="inlineStr"><is><t>客户</t></is></c>'
        + '<c r="B1" t="inlineStr"><is><t>金额</t></is></c></row>'
        + '<row r="2"><c r="A2" t="inlineStr"><is><t>甲</t></is></c><c r="B2"><v>12.5</v></c></row>'
        + '</sheetData></worksheet>',
    },
  ]);
  const sheet = readXlsxSheet(buffer);
  assert.equal(sheet.sheetName, '订单');
  assert.equal(sheet.totalRows, 2);
  assert.deepEqual(sheet.rows, [['客户', '金额'], ['甲', '12.5']]);
});

// 单条目归档（无 EOCD）用于直接验证解压上限，不依赖真实工作簿结构。
function buildStreamingZip(name, method, payload, declaredUncompressedSize) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(declaredUncompressedSize, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  return Buffer.concat([local, nameBuffer, payload]);
}

const TINY_LIMITS = { maxEntryBytes: 4096, maxTotalBytes: 8192, maxEntries: 16 };

test('xlsx reader refuses an archive whose declared uncompressed size blows the budget', () => {
  const oversized = buildStreamingZip('a.xml', 0, Buffer.alloc(9000, 0x41), 9000);
  assert.throws(
    () => openZipArchive(oversized, TINY_LIMITS),
    (error) => error.statusCode === 400 && /体积过大/.test(error.message),
  );
});

test('xlsx reader caps inflate output even when the declared size lies', () => {
  // 解压炸弹：2MB 重复字节压成 ~2KB，但中央目录谎报只有 64 字节。
  // 声明值校验会被绕过，只有 inflate 时带上限才拦得住。
  const bomb = buildStreamingZip('a.xml', 8, zlib.deflateRawSync(Buffer.alloc(2 * 1024 * 1024, 0x41)), 64);
  const archive = openZipArchive(bomb, TINY_LIMITS);
  assert.ok(archive);
  assert.throws(
    () => archive.get('a.xml'),
    (error) => error.statusCode === 400 && /体积过大/.test(error.message),
  );
});

test('xlsx reader keeps tolerating a damaged entry instead of failing the parse', () => {
  // 数据损坏（非 ERR_BUFFER_TOO_LARGE）仍然沿用旧的容错语义：返回空条目。
  const damaged = buildStreamingZip('a.xml', 8, Buffer.from('not-a-deflate-stream'), 20);
  const archive = openZipArchive(damaged, TINY_LIMITS);
  assert.ok(archive);
  assert.equal(archive.get('a.xml').length, 0);
});

test('xlsx files are parsed without pandas or other dependencies', () => {
  // 真实 Excel 产物：deflate 压缩 + sharedStrings + 日期样式
  const buffer = Buffer.from(REAL_XLSX_BASE64, 'base64');
  const sheet = readXlsxSheet(buffer);
  assert.equal(sheet.sheetName, '回款');
  assert.deepEqual(sheet.rows[0], ['客户编码', '回款额', '日期']);
  assert.deepEqual(sheet.rows[1], ['C1', '1200.5', '2026-08-01']);
  assert.deepEqual(sheet.rows[2], ['C2', '850', '2026-08-02']);

  // 本仓库写入器产物（stored + inlineStr）也必须读得回来
  const written = createXlsxBuffer({
    sheetName: '渠道',
    columns: [{ name: '渠道', bizName: 'channel' }, { name: '目标', bizName: 'target' }],
    rows: [{ channel: 'A', target: 10 }],
  });
  assert.deepEqual(readXlsxSheet(written).rows, [['渠道', '目标'], ['A', '10']]);
});

test('upload parses xlsx into a table artifact with sheet name and dates', () => {
  const harness = createHarness();
  try {
    const result = harness.uploads.upload({
      userId: harness.user.id,
      sessionId: harness.session.id,
      name: '回款明细.xlsx',
      contentBase64: REAL_XLSX_BASE64,
    });
    assert.equal(result.table.sheetName, '回款');
    assert.equal(result.table.rowCount, 2);
    assert.deepEqual(result.table.columns.map((column) => column.name), ['客户编码', '回款额', '日期']);
    assert.equal(result.table.columns[1].showType, 'NUMBER');
    assert.equal(result.table.columns[2].showType, 'DATE');

    const stored = harness.workspace.getArtifact({
      artifactId: result.table.artifactId,
      userId: harness.user.id,
    });
    assert.deepEqual(stored.payload.data.rows, [
      { c1: 'C1', c2: 1200.5, c3: '2026-08-01' },
      { c1: 'C2', c2: 850, c3: '2026-08-02' },
    ]);
    // 原始 xlsx 一并保留，便于代码执行直接读取原始工作簿
    const original = harness.workspace.getArtifact({
      artifactId: result.file.artifactId,
      userId: harness.user.id,
    });
    assert.equal(original.payload.format, 'xlsx');
    assert.equal(original.metadata.source.extension, 'xlsx');
  } finally {
    harness.database.close();
  }
});

test('column names are normalized and duplicated headers stay addressable', () => {
  const parsed = parseTabularContent({
    content: Buffer.from('金额,金额,,sales_amount\n1,2,3,4\n', 'utf8'),
    format: 'csv',
  });
  assert.deepEqual(
    parsed.columns.map((column) => column.name),
    ['金额', '金额_2', '列3', 'sales_amount'],
  );
  assert.deepEqual(
    parsed.columns.map((column) => column.bizName),
    ['c1', 'c2', 'c3', 'sales_amount'],
  );
  assert.equal(detectDelimiter('only-one-column\n1\n'), ',');
});

test('upload writes original file, parsed table and process artifacts', () => {
  const harness = createHarness();
  try {
    const result = harness.uploads.upload({
      userId: harness.user.id,
      sessionId: harness.session.id,
      name: '回款明细.csv',
      contentBase64: toBase64('客户编码,回款额\nC1,100\nC2,250\n'),
    });

    assert.equal(result.sessionId, harness.session.id);
    assert.equal(result.table.rowCount, 2);
    assert.equal(result.table.columnCount, 2);
    assert.equal(result.table.columns[1].showType, 'NUMBER');

    const artifacts = harness.workspace.listArtifacts({
      workspaceId: result.workspaceId,
      userId: harness.user.id,
    });
    const file = artifacts.find((item) => item.id === result.file.artifactId);
    const table = artifacts.find((item) => item.id === result.table.artifactId);
    const process = artifacts.find((item) => item.id === result.processArtifactId);
    assert.equal(file.artifactType, 'FILE');
    assert.equal(file.metadata.source.type, 'UPLOAD');
    assert.equal(file.metadata.source.name, '回款明细.csv');
    assert.match(file.metadata.source.sha256, /^[0-9a-f]{64}$/);
    assert.equal(table.artifactType, 'TABLE');
    assert.equal(table.metadata.source.type, 'UPLOAD_FILE');
    assert.equal(table.metadata.rowCount, 2);
    assert.equal(table.metadata.derivedFromArtifactId, file.id);
    assert.equal(process.artifactType, 'PROCESS_STEP');
    assert.equal(process.metadata.tool, 'upload_local_file');
    assert.equal(process.metadata.rowCount, 2);
    assert.equal(process.metadata.outputArtifactIds[0], table.id);

    const stored = harness.workspace.getArtifact({
      artifactId: table.id,
      userId: harness.user.id,
    });
    assert.deepEqual(stored.payload.data.rows, [{ c1: 'C1', c2: 100 }, { c1: 'C2', c2: 250 }]);

    const audit = harness.database.listAuditLogs(50);
    assert.ok(audit.some((entry) => entry.action === 'FILE_UPLOAD'));
  } finally {
    harness.database.close();
  }
});

test('upload rejects unsupported, oversized, binary and session-less requests', () => {
  const harness = createHarness({ maxBytes: 64, maxFilesPerSession: 1 });
  try {
    const base = { userId: harness.user.id, sessionId: harness.session.id };

    assert.throws(
      () => harness.uploads.upload({ ...base, name: '报表.pdf', contentBase64: toBase64('a,b\n1,2\n') }),
      /暂不支持 \.pdf/,
    );
    // 声明为 xlsx 但不是 Excel 容器时必须拒绝
    assert.throws(
      () => harness.uploads.upload({ ...base, name: '假表.xlsx', contentBase64: toBase64('a,b\n1,2\n') }),
      /不是有效的 xlsx 工作簿/,
    );
    assert.throws(
      () => harness.uploads.upload({ ...base, name: '报表', contentBase64: toBase64('a,b\n1,2\n') }),
      /缺少扩展名/,
    );
    assert.throws(
      () => harness.uploads.upload({ ...base, name: '报表.exe', contentBase64: toBase64('a,b\n1,2\n') }),
      /暂不支持 \.exe/,
    );
    // 伪装成 csv 的 zip/xlsx 容器必须被签名检查拦下
    const zip = Buffer.concat([Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.alloc(16)]);
    assert.throws(
      () => harness.uploads.upload({ ...base, name: '伪装.csv', contentBase64: zip.toString('base64') }),
      /不是纯文本表格/,
    );
    assert.throws(
      () => harness.uploads.upload({ ...base, name: '空.csv', contentBase64: '' }),
      /上传内容为空/,
    );
    assert.throws(
      () => harness.uploads.upload({
        ...base,
        name: '过大.csv',
        contentBase64: toBase64('header\n1\n'.repeat(40)),
      }),
      /超过单次上传上限/,
    );
    assert.throws(
      () => harness.uploads.upload({
        userId: harness.user.id,
        sessionId: 999999,
        name: '孤儿.csv',
        contentBase64: toBase64('a\n1\n'),
      }),
      /先建立会话/,
    );

    const audit = harness.database.listAuditLogs(50);
    assert.ok(audit.some((entry) => entry.action === 'FILE_REJECTED'));
  } finally {
    harness.database.close();
  }
});

test('upload enforces the per-session quota', () => {
  const harness = createHarness({ maxFilesPerSession: 1 });
  try {
    const base = { userId: harness.user.id, sessionId: harness.session.id };
    harness.uploads.upload({ ...base, name: '第一份.csv', contentBase64: toBase64('a\n1\n') });
    assert.throws(
      () => harness.uploads.upload({ ...base, name: '第二份.csv', contentBase64: toBase64('a\n2\n') }),
      /最多上传 1 个文件/,
    );
  } finally {
    harness.database.close();
  }
});

test('uploaded table is materialized into the analysis sandbox input', async (context) => {
  const pythonBin = loadConfig().pythonBin;
  // 没有可用解释器时跳过：本用例验证的是沙箱输入物化，不是 Python 安装状态。
  const available = spawnSync(pythonBin, ['-c', 'print(1)'], { encoding: 'utf8' }).status === 0;
  if (!available) {
    context.skip(`未找到可用的 Python 解释器（${pythonBin}），跳过沙箱端到端校验`);
    return;
  }
  const harness = createHarness();
  const codeExecution = new CodeExecutionService({
    database: harness.database,
    workspace: harness.workspace,
    config: {
      codeExecutionRoot: path.join(harness.directory, 'code-runs'),
      pythonBin,
    },
  });
  try {
    const result = harness.uploads.upload({
      userId: harness.user.id,
      sessionId: harness.session.id,
      name: '回款明细.csv',
      contentBase64: toBase64('客户编码,回款额\nC1,100\nC2,250\n'),
    });
    const run = await codeExecution.run({
      userId: harness.user.id,
      workspaceId: result.workspaceId,
      sessionId: harness.session.id,
      inputArtifactIds: [result.file.artifactId, result.table.artifactId],
      purpose: '汇总上传文件回款额',
      code: `
import csv, json
manifest = json.load(open('input/manifest.json', encoding='utf-8'))
original = manifest['inputs'][0]
with open('input/' + original['files'][0], encoding='utf-8-sig', newline='') as handle:
    rows = list(csv.DictReader(handle))
total = sum(float(row['回款额']) for row in rows)
with open('output/summary.csv', 'w', encoding='utf-8', newline='') as handle:
    writer = csv.writer(handle)
    writer.writerow(['total'])
    writer.writerow([int(total)])
print('total', int(total))
`,
    });
    assert.equal(run.success, true, run.stderr);
    assert.match(run.stdout, /total 350/);
    const summary = run.outputs.find((item) => item.format === 'csv');
    const exported = harness.workspace.exportArtifact({
      artifactId: summary.artifactId,
      userId: harness.user.id,
      format: 'csv',
    });
    assert.match(exported.content, /350/);
  } finally {
    harness.database.close();
  }
});

// 受限执行环境是威慑而非安全边界（见 docs/architecture.md），但已覆盖的越界读路径
// 不能再退化：builtins.open / os.open / pathlib 三条路都必须被拦住。
test('analysis code cannot read files outside its run directory', async (context) => {
  const pythonBin = loadConfig().pythonBin;
  const available = spawnSync(pythonBin, ['-c', 'print(1)'], { encoding: 'utf8' }).status === 0;
  if (!available) {
    context.skip(`未找到可用的 Python 解释器（${pythonBin}），跳过越界读路径校验`);
    return;
  }
  const harness = createHarness();
  const codeExecution = new CodeExecutionService({
    database: harness.database,
    workspace: harness.workspace,
    config: { codeExecutionRoot: path.join(harness.directory, 'code-runs'), pythonBin },
  });
  try {
    const work = harness.workspace.ensureForSession({
      userId: harness.user.id,
      themeId: harness.theme.id,
      sessionId: harness.session.id,
      name: '越界读路径校验',
    });
    const run = await codeExecution.run({
      userId: harness.user.id,
      workspaceId: work.id,
      sessionId: harness.session.id,
      purpose: '校验越界读路径被拦截',
      code: `
import os
import pathlib

target = os.sep.join(['', 'etc', 'hosts'])

def probe(label, action):
    try:
        action()
    except PermissionError:
        print(label, 'BLOCKED')
    else:
        print(label, 'LEAKED')

probe('builtins.open', lambda: open(target).read())
probe('pathlib.read_text', lambda: pathlib.Path(target).read_text())
probe('os.open', lambda: os.open(target, os.O_RDONLY))
`,
    });
    assert.equal(run.success, true, run.stderr);
    assert.match(run.stdout, /builtins\.open BLOCKED/);
    assert.match(run.stdout, /pathlib\.read_text BLOCKED/);
    assert.match(run.stdout, /os\.open BLOCKED/);
    assert.doesNotMatch(run.stdout, /LEAKED/);
  } finally {
    harness.database.close();
  }
});

function testConfig(directory, overrides = {}) {
  return {
    projectRoot: process.cwd(),
    port: 0,
    dbPath: path.join(directory, 'test.db'),
    supersonic: { baseUrl: '', token: '', timeoutMs: 5_000 },
    deepseek: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      timeoutMs: 5_000,
      maxToolRounds: 3,
    },
    chatMemoryMessageLimit: 20,
    datasourceSecretKey: '',
    datasourceSecretKeyPath: path.join(directory, '.credential-key'),
    bootstrapDatasource: { enabled: false },
    uploads: { maxBytes: 64 * 1024, maxFilesPerSession: 5 },
    ...overrides,
  };
}

test('upload route requires login in session mode and returns artifacts in dev mode', async () => {
  const strictDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-upload-auth-'));
  const strict = await startServer(
    testConfig(strictDirectory, { authMode: 'session' }),
    new FakeIndicatorClient(),
  );
  try {
    const denied = await fetch(
      `http://127.0.0.1:${strict.server.address().port}/api/workspaces/files`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 1, name: 'a.csv', contentBase64: toBase64('a\n1\n') }),
      },
    );
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).message, '请先登录');
  } finally {
    await new Promise((resolve) => strict.server.close(resolve));
    strict.application.database.close();
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-upload-http-'));
  const { server, application } = await startServer(
    testConfig(directory),
    new FakeIndicatorClient(),
  );
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const admin = { 'content-type': 'application/json', 'x-user-id': '1' };
    const unknownSession = await fetch(`${baseUrl}/api/workspaces/files`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        sessionId: 999999,
        name: 'a.csv',
        contentBase64: toBase64('a\n1\n'),
      }),
    });
    assert.equal(unknownSession.status, 404);
    assert.equal((await unknownSession.json()).message, '上传前需要先建立会话');

    const session = await (await fetch(`${baseUrl}/api/chat/sessions`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ themeId: 1 }),
    })).json();

    const response = await fetch(`${baseUrl}/api/workspaces/files`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        sessionId: session.id,
        name: '渠道映射.csv',
        contentBase64: toBase64('渠道,目标\nA,10\nB,20\n'),
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.table.rowCount, 2);
    assert.ok(result.file.artifactId);

    const artifacts = await (await fetch(
      `${baseUrl}/api/workspaces/${result.workspaceId}/artifacts`,
      { headers: admin },
    )).json();
    assert.ok(artifacts.some((item) => item.id === result.table.artifactId));

    // 路由表里存在且 OpenAPI 可生成（P0-8 单表来源）
    assert.ok(buildRouteTable().match('POST', '/api/workspaces/files'));
    assert.ok(application.uploads);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    application.database.close();
  }
});

test('legacy binary xls is stored and flagged instead of being guessed', () => {
  const harness = createHarness();
  try {
    // 旧版 xls 的 OLE 容器签名
    const ole = Buffer.concat([
      Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]),
      Buffer.alloc(64),
    ]);
    const binary = harness.uploads.upload({
      userId: harness.user.id,
      sessionId: harness.session.id,
      name: '旧版回款.xls',
      contentBase64: ole.toString('base64'),
    });
    assert.equal(binary.table, null);
    assert.ok(binary.file.artifactId);
    assert.ok(binary.warnings.length > 0);

    // 文本伪装成 .xls（把 CSV 另存为 xls 是常见情况）按文本表格解析
    const textXls = harness.uploads.upload({
      userId: harness.user.id,
      sessionId: harness.session.id,
      name: '文本回款.xls',
      contentBase64: toBase64('客户编码,回款额\nC9,10\n'),
    });
    assert.equal(textXls.table.rowCount, 1);

    // HTML 表格伪装成 .xls 时只保存并提示，不做猜测
    const htmlXls = harness.uploads.upload({
      userId: harness.user.id,
      sessionId: harness.session.id,
      name: '网页导出.xls',
      contentBase64: toBase64('<html><body><table><tr><td>1</td></tr></table></body></html>'),
    });
    assert.equal(htmlXls.table, null);
    assert.match(htmlXls.warnings[0], /HTML 表格/);
  } finally {
    harness.database.close();
  }
});

test('question attachments bind only own session files and are stored on the user message', () => {
  const harness = createHarness();
  try {
    const uploaded = harness.uploads.upload({
      userId: harness.user.id,
      sessionId: harness.session.id,
      name: '回款明细.csv',
      contentBase64: toBase64('客户编码,回款额\nC1,1200\n'),
    });
    const fileArtifactId = uploaded.file.artifactId;

    // 同一会话内的上传文件可以被识别为提问附件
    const own = resolveQuestionAttachments({
      workspace: harness.workspace,
      userId: harness.user.id,
      sessionId: harness.session.id,
      artifactIds: [fileArtifactId, 'not-an-artifact', uploaded.table.artifactId],
    });
    assert.deepEqual(own.map((item) => item.artifactId), [fileArtifactId]);
    assert.equal(own[0].name, '回款明细.csv');

    // 其他会话的产物不能被挂到本会话提问上
    const otherSession = harness.database.createChatSession({
      userId: harness.user.id,
      themeId: harness.theme.id,
      title: '另一个会话',
    });
    const otherUpload = harness.uploads.upload({
      userId: harness.user.id,
      sessionId: otherSession.id,
      name: '别处的表.csv',
      contentBase64: toBase64('a,b\n1,2\n'),
    });
    assert.deepEqual(resolveQuestionAttachments({
      workspace: harness.workspace,
      userId: harness.user.id,
      sessionId: harness.session.id,
      artifactIds: [otherUpload.file.artifactId],
    }), []);

    // 落库后提问气泡能拿到附件，且产物被绑定到这条用户消息
    const memory = new SessionMemoryStore(harness.database);
    const appended = appendUserQuestionWithAttachments({
      memory,
      workspace: harness.workspace,
      session: harness.session,
      user: harness.user,
      question: '用这份文件核对回款',
      artifactIds: [fileArtifactId],
    });
    assert.equal(appended.message.role, 'user');
    assert.equal(appended.attachments.length, 1);

    const messages = memory.listMessages(harness.session.id, harness.user.id);
    const userMessage = messages.find((message) => message.id === appended.message.id);
    assert.equal(userMessage.content, '用这份文件核对回款');
    assert.deepEqual(
      userMessage.result.attachments.map((item) => item.name),
      ['回款明细.csv'],
    );
    const bound = harness.database.getWorkspaceArtifact(fileArtifactId, harness.user.id);
    assert.equal(Number(bound.messageId), appended.message.id);
  } finally {
    harness.database.close();
  }
});
