// 本地上传文件服务：把用户上传的本地文件落成会话工作区产物，
// 供 agent 在上下文里看到、并作为 execute_analysis_code 的输入。
// 只做通用的格式校验与解析，不包含任何业务口径或指标名。

import { createHash } from 'node:crypto';
import { profileDataset } from './datasetProfiler.js';
import { getPlatformLexicon } from './businessLexicon.js';
import { buildTable, decodeBuffer, parseTabularContent } from './fileParsing.js';
import { readXlsxSheet } from './xlsxReader.js';

// 问数入口只暴露 csv / xls / xlsx；其余文本格式保留解析能力，可由配置开启。
const TABULAR_EXTENSIONS = new Set(['csv', 'tsv', 'txt', 'json']);
const SPREADSHEET_EXTENSIONS = new Set(['xlsx', 'xls']);
const MIME_TYPES = {
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
};
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
const OLE_SIGNATURE = Buffer.from([0xD0, 0xCF, 0x11, 0xE0]);
// 其它二进制/文档签名：任何扩展名伪装都要拒绝。
const BINARY_SIGNATURES = [
  { signature: Buffer.from([0x25, 0x50, 0x44, 0x46]), label: 'PDF' },
  { signature: Buffer.from([0x7B, 0x5C, 0x72, 0x74, 0x66]), label: 'RTF' },
  { signature: Buffer.from([0x89, 0x50, 0x4E, 0x47]), label: 'PNG' },
  { signature: Buffer.from([0xFF, 0xD8, 0xFF]), label: 'JPEG' },
];

const DEFAULT_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  maxFilesPerSession: 20,
  maxTotalBytesPerSession: 40 * 1024 * 1024,
  maxTableRows: 50_000,
  allowedExtensions: ['csv', 'xls', 'xlsx'],
};

const PROCESS_SAMPLE_ROWS = 200;

function uploadError(message, statusCode = 400, code = 'UPLOAD_REJECTED') {
  return Object.assign(new Error(message), { statusCode, code });
}

export function extensionOf(name) {
  const match = String(name ?? '').trim().match(/\.([A-Za-z0-9]+)$/);
  return match ? match[1].toLowerCase() : '';
}

export function sanitizeUploadName(value, fallback = '上传文件') {
  const base = String(value ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 120) || fallback;
}

// 识别内容形态：zip（xlsx）、ole（旧版 xls）或其它二进制；纯文本返回 null。
function contentKindOf(buffer) {
  const head = buffer.subarray(0, 8);
  if (head.subarray(0, 4).equals(ZIP_SIGNATURE)) {
    return 'zip';
  }
  if (head.subarray(0, 4).equals(OLE_SIGNATURE)) {
    return 'ole';
  }
  const signature = BINARY_SIGNATURES.find((item) => head.subarray(0, item.signature.length)
    .equals(item.signature));
  if (signature) {
    return signature.label;
  }
  return buffer.includes(0) ? '二进制内容' : null;
}

function decodeBase64(content) {
  const text = String(content ?? '').replace(/\s+/g, '');
  if (!text) {
    throw uploadError('上传内容为空');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    throw uploadError('上传内容不是合法的 base64 编码');
  }
  return Buffer.from(text, 'base64');
}

function base64ByteLength(text) {
  const value = String(text ?? '').replace(/\s+/g, '');
  if (!value) {
    return 0;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

// 上传服务：校验 -> 落原始文件产物 -> 解析成表格产物 -> 落识别过程文件。
export class UploadService {
  constructor({ database, workspace, config = {} }) {
    this.database = database;
    this.workspace = workspace;
    const limits = config.uploads ?? {};
    this.limits = {
      ...DEFAULT_LIMITS,
      ...limits,
      allowedExtensions: (limits.allowedExtensions?.length
        ? limits.allowedExtensions
        : DEFAULT_LIMITS.allowedExtensions).map((item) => String(item).toLowerCase()),
    };
  }

  audit(action, { userId, sessionId, detail = {} }) {
    try {
      this.database?.addAuditLog?.({
        userId,
        themeId: detail.themeId ?? null,
        action,
        detail: { sessionId: sessionId ?? null, ...detail },
      });
    } catch {
      // 审计写入失败不影响上传主流程。
    }
  }

  validate({ name, contentBase64 }) {
    const safeName = sanitizeUploadName(name);
    const extension = extensionOf(safeName);
    const supported = this.limits.allowedExtensions.map((item) => item.toUpperCase()).join(' / ');
    if (!extension) {
      throw uploadError(`上传文件缺少扩展名，请使用 ${supported} 文件`);
    }
    if (!this.limits.allowedExtensions.includes(extension)) {
      throw uploadError(`暂不支持 .${extension} 文件，当前支持 ${supported}`);
    }
    const estimatedBytes = base64ByteLength(contentBase64);
    if (estimatedBytes > this.limits.maxBytes) {
      throw uploadError(
        `文件超过单次上传上限 ${Math.floor(this.limits.maxBytes / 1024 / 1024)}MB`,
        413,
        'UPLOAD_TOO_LARGE',
      );
    }
    const buffer = decodeBase64(contentBase64);
    if (buffer.length === 0) {
      throw uploadError('上传内容为空');
    }
    if (buffer.length > this.limits.maxBytes) {
      throw uploadError(
        `文件超过单次上传上限 ${Math.floor(this.limits.maxBytes / 1024 / 1024)}MB`,
        413,
        'UPLOAD_TOO_LARGE',
      );
    }
    const kind = contentKindOf(buffer);
    if (extension === 'xlsx' && kind !== 'zip') {
      throw uploadError('文件不是有效的 xlsx 工作簿（缺少 Excel 容器签名），请重新导出后上传');
    }
    if (extension === 'xls' && kind && kind !== 'ole') {
      throw uploadError(`文件内容看起来是${kind}，不是有效的 Excel 文件`);
    }
    if (!SPREADSHEET_EXTENSIONS.has(extension) && kind) {
      throw uploadError(`文件内容看起来是${kind}，不是纯文本表格；Excel 文件请另存为 CSV 或 xlsx`);
    }
    return { safeName, extension, buffer };
  }

  assertQuota({ workspaceId, userId, incomingBytes }) {
    const artifacts = this.workspace.listArtifacts({ workspaceId, userId })
      .filter((artifact) => artifact.metadata?.source?.type === 'UPLOAD');
    if (artifacts.length >= this.limits.maxFilesPerSession) {
      throw uploadError(
        `单个会话最多上传 ${this.limits.maxFilesPerSession} 个文件，请先清理或新建会话`,
        429,
        'UPLOAD_QUOTA_EXCEEDED',
      );
    }
    const usedBytes = artifacts
      .reduce((total, artifact) => total + Number(artifact.metadata?.size ?? 0), 0);
    if (usedBytes + incomingBytes > this.limits.maxTotalBytesPerSession) {
      throw uploadError(
        `会话内上传文件总大小超过 ${Math.floor(this.limits.maxTotalBytesPerSession / 1024 / 1024)}MB，请新建会话`,
        429,
        'UPLOAD_QUOTA_EXCEEDED',
      );
    }
  }

  buildFieldSpecs(columns = [], rows = []) {
    return columns.map((column) => ({
      fieldName: column.bizName,
      displayName: column.name,
      dataType: column.type,
      semanticType: column.showType === 'NUMBER' ? 'NUMBER' : 'STRING',
      role: column.showType === 'NUMBER' ? 'METRIC' : 'DIMENSION',
      aggregator: column.showType === 'NUMBER' ? 'SUM' : 'NONE',
    }));
  }

  // 字段角色建议复用平台通用的词典识别器，不在本模块内写死业务词。
  // 文本表格：按分隔文本解析。
  parseTextTable({ buffer, extension }) {
    return {
      ...parseTabularContent({
        content: buffer,
        format: extension,
        maxRows: this.limits.maxTableRows,
      }),
      sheetName: null,
    };
  }

  // 表格文件：xlsx 直接解析；旧版 .xls 二进制无法解析，仅保存原始文件并提示转换。
  parseSpreadsheet({ buffer, extension }) {
    if (buffer.subarray(0, 4).equals(OLE_SIGNATURE)) {
      return {
        unparsed: true,
        warnings: ['旧版二进制 .xls 无法直接解析，请另存为 .xlsx 或 .csv 后重新上传'],
      };
    }
    if (!buffer.subarray(0, 4).equals(ZIP_SIGNATURE)) {
      const head = decodeBuffer(buffer.subarray(0, 4096)).text.trim().toLowerCase();
      if (head.startsWith('<') || head.includes('<table')) {
        return {
          unparsed: true,
          warnings: ['该 .xls 实际是 HTML 表格，无法直接解析，请另存为 .xlsx 或 .csv'],
        };
      }
      const text = this.parseTextTable({ buffer, extension: 'csv' });
      return {
        ...text,
        warnings: [
          ...text.warnings,
          '该 .xls 不是 Excel 二进制格式，已按文本表格解析；如结果异常请另存为 .xlsx 或 .csv',
        ],
      };
    }
    const sheet = readXlsxSheet(buffer);
    if (sheet.rows.length === 0) {
      return { unparsed: true, warnings: [`工作表「${sheet.sheetName}」中没有数据行`] };
    }
    const dataRows = Math.max(sheet.totalRows - 1, sheet.rows.length - 1);
    const table = buildTable({
      columns: sheet.rows[0],
      rows: sheet.rows.slice(1),
      maxRows: this.limits.maxTableRows,
    });
    return {
      ...table,
      encoding: 'utf-8',
      delimiter: null,
      sheetName: sheet.sheetName,
      totalRows: dataRows,
      truncated: dataRows > table.rows.length,
    };
  }

  profileTable({ columns, rows }) {
    const fields = this.buildFieldSpecs(columns, rows);
    if (fields.length === 0) {
      return null;
    }
    try {
      const profile = profileDataset({
        fields,
        rows: rows.slice(0, 200),
        options: { sampleSize: Math.min(rows.length, 200) },
        lexicon: getPlatformLexicon(),
      });
      return {
        generatedAt: profile.generatedAt,
        sampleSize: profile.sampleSize,
        timeCondition: profile.timeCondition,
        summary: profile.summary,
        fields: profile.fields.map((field) => ({
          fieldName: field.fieldName,
          displayName: field.displayName,
          suggestedRole: field.suggestedRole,
          suggestedAggregator: field.suggestedAggregator,
          confidence: field.confidence,
        })),
      };
    } catch {
      return null;
    }
  }

  upload({ userId, sessionId, name, contentBase64 }) {
    try {
      return this.performUpload({ userId, sessionId, name, contentBase64 });
    } catch (error) {
      this.audit('FILE_REJECTED', {
        userId,
        sessionId,
        detail: {
          name: sanitizeUploadName(name),
          code: error.code ?? 'UPLOAD_REJECTED',
          message: error.message,
          size: base64ByteLength(contentBase64),
        },
      });
      throw error;
    }
  }

  performUpload({ userId, sessionId, name, contentBase64 }) {
    if (!this.workspace) {
      throw uploadError('workspace service is not configured', 500, 'UPLOAD_UNAVAILABLE');
    }
    const session = this.database?.getChatSession?.(Number(sessionId), userId);
    if (!session) {
      throw uploadError('上传前需要先建立会话', 404, 'UPLOAD_SESSION_REQUIRED');
    }
    const { safeName, extension, buffer } = this.validate({ name, contentBase64 });
    const workspaceRecord = this.workspace.ensureForSession({
      userId,
      themeId: session.themeId,
      sessionId: session.id,
      name: safeName,
    });
    this.assertQuota({
      workspaceId: workspaceRecord.id,
      userId,
      incomingBytes: buffer.length,
    });

    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const source = {
      type: 'UPLOAD',
      name: safeName,
      extension,
      size: buffer.length,
      mimeType: MIME_TYPES[extension] ?? 'text/plain; charset=utf-8',
      sha256,
      uploadedAt: new Date().toISOString(),
    };
    const fileArtifact = this.workspace.createFileArtifact({
      workspaceId: workspaceRecord.id,
      userId,
      sessionId: session.id,
      title: `${safeName}（原始文件）`,
      content: buffer.toString('base64'),
      encoding: 'base64',
      format: extension,
      mimeType: source.mimeType,
      purpose: '用户上传的本地文件',
      size: buffer.length,
      source,
    });

    let tableArtifact = null;
    let parsed = null;
    const warnings = [];
    if (SPREADSHEET_EXTENSIONS.has(extension)) {
      parsed = this.parseSpreadsheet({ buffer, extension });
    } else if (TABULAR_EXTENSIONS.has(extension)) {
      parsed = this.parseTextTable({ buffer, extension });
    }
    if (parsed) {
      warnings.push(...(parsed.warnings ?? []));
      const parseable = !parsed.unparsed && parsed.columns.length > 0;
      if (parsed.truncated) {
        const total = Number(parsed.totalRows) > 0
          ? `共 ${parsed.totalRows} 行，`
          : '';
        warnings.push(
          `文件${total}解析表只保留前 ${parsed.rows.length} 行；如需全量请在代码计算中读取原始文件产物`,
        );
      }
      if (!parseable && !parsed.unparsed) {
        throw uploadError('未能从文件中识别出列，请检查文件是否有表头行');
      }
      if (parseable) {
        tableArtifact = this.workspace.createTableArtifact({
          workspaceId: workspaceRecord.id,
          userId,
          sessionId: session.id,
          title: `${safeName}（解析表）`,
          metadata: {
            source: { type: 'UPLOAD_FILE', id: fileArtifact.id, name: safeName },
            derivedFromArtifactId: fileArtifact.id,
            parentArtifactIds: [fileArtifact.id],
            inputArtifactIds: [fileArtifact.id],
            lineageQuestion: `上传本地文件：${safeName}`,
            format: extension,
            encoding: parsed.encoding,
            delimiter: parsed.delimiter,
            sheetName: parsed.sheetName ?? null,
            rowCount: parsed.rows.length,
            totalRowCount: parsed.totalRows ?? parsed.rows.length,
            columnCount: parsed.columns.length,
            truncated: Boolean(parsed.truncated),
            warnings,
          },
          payload: { data: { columns: parsed.columns, rows: parsed.rows } },
        });
      }
    }

    const profile = tableArtifact ? this.profileTable(parsed) : null;
    const sampleRows = parsed?.rows?.slice(0, PROCESS_SAMPLE_ROWS) ?? [];
    const processArtifact = this.workspace.createProcessArtifact({
      workspaceId: workspaceRecord.id,
      userId,
      sessionId: session.id,
      title: `步骤 01 · 本地文件解析${tableArtifact ? ` · ${parsed.rows.length} 行` : ''}`,
      metadata: {
        process: true,
        dataKind: 'UPLOAD',
        dataKindLabel: '本地上传解析',
        stepId: 'upload',
        sequence: 1,
        tool: 'upload_local_file',
        toolTitle: '本地文件解析',
        status: 'success',
        startedAt: source.uploadedAt,
        durationMs: null,
        summary: tableArtifact
          ? `已识别 ${parsed.columns.length} 列、${parsed.rows.length} 行，编码 ${parsed.encoding}`
          : '文件已保存为原始产物，未解析为表格',
        rowCount: tableArtifact ? parsed.rows.length : 0,
        columnCount: parsed?.columns?.length ?? 0,
        capturedRowCount: sampleRows.length,
        sampled: (parsed?.rows?.length ?? 0) > sampleRows.length,
        truncated: Boolean(tableArtifact && parsed.truncated),
        inputArtifactIds: [fileArtifact.id],
        parentArtifactIds: [fileArtifact.id],
        outputArtifactIds: tableArtifact ? [tableArtifact.id] : [],
        upload: { sha256, size: buffer.length, extension, encoding: parsed?.encoding ?? null },
        warnings,
      },
      payload: {
        step: {
          id: 'upload',
          sequence: 1,
          tool: 'upload_local_file',
          title: '本地文件解析',
          status: 'success',
          durationMs: null,
        },
        dataKind: 'UPLOAD',
        summary: tableArtifact
          ? `已识别 ${parsed.columns.length} 列、${parsed.rows.length} 行`
          : '未解析为表格',
        data: { columns: tableArtifact ? parsed.columns : [], rows: tableArtifact ? sampleRows : [] },
        profile,
      },
    });

    this.audit('FILE_UPLOAD', {
      userId,
      sessionId: session.id,
      detail: {
        themeId: session.themeId,
        name: safeName,
        size: buffer.length,
        sha256,
        fileArtifactId: fileArtifact.id,
        tableArtifactId: tableArtifact?.id ?? null,
        processArtifactId: processArtifact.id,
        rowCount: (tableArtifact && parsed?.rows?.length) || 0,
        columnCount: (tableArtifact && parsed?.columns?.length) || 0,
        encoding: parsed?.encoding ?? null,
        truncated: Boolean(tableArtifact && parsed?.truncated),
      },
    });

    return {
      sessionId: session.id,
      workspaceId: workspaceRecord.id,
      file: {
        artifactId: fileArtifact.id,
        title: fileArtifact.title,
        name: safeName,
        size: buffer.length,
        sha256,
      },
      table: tableArtifact
        ? {
          artifactId: tableArtifact.id,
          title: tableArtifact.title,
          rowCount: parsed.rows.length,
          columnCount: parsed.columns.length,
          columns: parsed.columns,
          encoding: parsed.encoding,
          delimiter: parsed.delimiter,
          sheetName: parsed.sheetName ?? null,
          truncated: parsed.truncated,
        }
        : null,
      processArtifactId: processArtifact.id,
      profile,
      warnings,
    };
  }
}

export { BINARY_SIGNATURES, TABULAR_EXTENSIONS };
