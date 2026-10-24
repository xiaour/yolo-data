import { buildArtifactFileName, buildArtifactTitle } from './fileName.js';
import { createXlsxBuffer } from './xlsx.js';
import { buildArtifactCapabilities } from './artifactCapabilities.js';
import { callPlatformDatabase } from './platformDatabaseAccess.js';
import { formatPresentationCell } from './resultPresentation.js';
import { clonePayload, columnKey, OPERATIONS } from './workspaceTransforms.js';

const ARTIFACT_OPERATION_LABELS = {
  add_summary_row: '汇总行',
  sort: '排序',
  rename_column: '重命名字段',
  format_column: '格式化字段',
  add_ratio_column: '新增比例',
  filter_rows: '筛选',
  limit_rows: '截取行',
};

function csvEscape(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  // 上传文件等外部内容会进入导出；文本以公式字符开头时加前导单引号，避免表格软件按公式执行。
  const text = typeof value === 'string' && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export class WorkspaceService {
  constructor(database) {
    this.database = database;
  }

  ensureForSession({ userId, themeId, sessionId, name }) {
    const existing = this.database.getWorkspaceBySession(sessionId, userId);
    if (existing && name && existing.name !== String(name).trim()) {
      return this.database.updateWorkspace(existing.id, userId, { name });
    }
    return this.database.ensureWorkspace({
      userId,
      themeId,
      sessionId,
      name,
    });
  }

  async ensureForSessionAsync(args) {
    const existing = await callPlatformDatabase(this.database, 'getWorkspaceBySessionAsync', 'getWorkspaceBySession', args.sessionId, args.userId);
    if (existing && args.name && existing.name !== String(args.name).trim()) {
      return callPlatformDatabase(this.database, 'updateWorkspaceAsync', 'updateWorkspace', existing.id, args.userId, { name: args.name });
    }
    return callPlatformDatabase(this.database, 'ensureWorkspaceAsync', 'ensureWorkspace', args);
  }

  listForUser({ userId, sessionId = null }) {
    if (sessionId) {
      const workspace = this.database.getWorkspaceBySession(sessionId, userId);
      return workspace ? [workspace] : [];
    }
    return [];
  }

  async listForUserAsync({ userId, sessionId = null }) {
    if (!sessionId) return [];
    const workspace = await callPlatformDatabase(this.database, 'getWorkspaceBySessionAsync', 'getWorkspaceBySession', sessionId, userId);
    return workspace ? [workspace] : [];
  }

  listArtifacts({ workspaceId, userId }) {
    const workspace = this.database.getWorkspace(workspaceId, userId);
    if (!workspace) {
      throw new Error('workspace not found');
    }
    return this.database.listWorkspaceArtifacts(workspace.id, userId);
  }

  async listArtifactsAsync({ workspaceId, userId }) {
    const workspace = await callPlatformDatabase(this.database, 'getWorkspaceAsync', 'getWorkspace', workspaceId, userId);
    if (!workspace) throw new Error('workspace not found');
    return callPlatformDatabase(this.database, 'listWorkspaceArtifactsAsync', 'listWorkspaceArtifacts', workspace.id, userId);
  }

  getArtifact({ artifactId, userId }) {
    const artifact = this.database.getWorkspaceArtifact(artifactId, userId);
    if (!artifact) {
      throw new Error('workspace artifact not found');
    }
    return artifact;
  }

  async getArtifactAsync({ artifactId, userId }) {
    const artifact = await callPlatformDatabase(this.database, 'getWorkspaceArtifactAsync', 'getWorkspaceArtifact', artifactId, userId);
    if (!artifact) throw new Error('workspace artifact not found');
    return artifact;
  }

  async createResultArtifactAsync(params) {
    const result = this.createResultArtifactPayload(params);
    return callPlatformDatabase(this.database, 'createWorkspaceArtifactAsync', 'createWorkspaceArtifact', result);
  }

  createResultArtifactPayload({ workspaceId, userId, sessionId, messageId, conversationId, answer, artifactType = 'QUERY_RESULT', inputArtifactIds = [], runId = null, source = null }) {
    const fallbackSubject = answer.indicator?.name ?? answer.dataset?.name ?? answer.chart?.title ?? '问数结果';
    const subject = buildArtifactTitle(answer.resolvedQuestion ?? answer.question, { fallback: fallbackSubject });
    const metadata = { question: answer.question, resolvedQuestion: answer.resolvedQuestion ?? answer.question, rowCount: answer.data?.rows?.length ?? 0, columnCount: answer.data?.columns?.length ?? 0, chartType: answer.chart?.type ?? 'table', queryFingerprint: answer.queryFingerprint ?? null, dataHash: answer.dataHash ?? null, timeGrain: answer.semanticParse?.timeGrain ?? null, columns: answer.data?.columns ?? [], source, inputArtifactIds, parentArtifactIds: inputArtifactIds, runId, lineageQuestion: answer.resolvedQuestion ?? answer.question ?? '', capabilities: buildArtifactCapabilities({ sourceType: source?.type, source, data: answer.data, semanticParse: answer.semanticParse, queryFingerprint: answer.queryFingerprint, dataHash: answer.dataHash }) };
    return { workspaceId, userId, sessionId, messageId, conversationId, artifactType, title: subject, metadata, payload: { data: answer.data ?? { columns: [], rows: [] }, chart: answer.chart ?? null, semanticParse: answer.semanticParse ?? null, runtime: answer.runtime ?? null, question: answer.question, resolvedQuestion: answer.resolvedQuestion ?? answer.question } };
  }

  createResultArtifact({
    workspaceId,
    userId,
    sessionId,
    messageId,
    conversationId,
    answer,
    artifactType = 'QUERY_RESULT',
    inputArtifactIds = [],
    runId = null,
    source = null,
  }) {
    const fallbackSubject = answer.indicator?.name
      ?? answer.dataset?.name
      ?? answer.chart?.title
      ?? '问数结果';
    const subject = buildArtifactTitle(
      answer.resolvedQuestion ?? answer.question,
      { fallback: fallbackSubject },
    );
    const metadata = {
      question: answer.question,
      resolvedQuestion: answer.resolvedQuestion ?? answer.question,
      rowCount: answer.data?.rows?.length ?? 0,
      columnCount: answer.data?.columns?.length ?? 0,
      chartType: answer.chart?.type ?? 'table',
      queryFingerprint: answer.queryFingerprint ?? null,
      dataHash: answer.dataHash ?? null,
      timeGrain: answer.semanticParse?.timeGrain ?? null,
      columns: answer.data?.columns ?? [],
      source,
      inputArtifactIds,
      parentArtifactIds: inputArtifactIds,
      runId,
      lineageQuestion: answer.resolvedQuestion ?? answer.question ?? '',
      capabilities: buildArtifactCapabilities({
        sourceType: source?.type,
        source,
        data: answer.data,
        semanticParse: answer.semanticParse,
        queryFingerprint: answer.queryFingerprint,
        dataHash: answer.dataHash,
      }),
    };
    return this.database.createWorkspaceArtifact({
      workspaceId,
      userId,
      sessionId,
      messageId,
      conversationId,
      artifactType,
      title: subject,
      metadata,
      payload: {
        data: answer.data ?? { columns: [], rows: [] },
        chart: answer.chart ?? null,
        semanticParse: answer.semanticParse ?? null,
        runtime: answer.runtime ?? null,
        question: answer.question,
        resolvedQuestion: answer.resolvedQuestion ?? answer.question,
      },
    });
  }

  // 过程文件：记录 agent 单个工作环节的输入、输出和耗时，供用户追踪核查。
  createProcessArtifact({
    workspaceId,
    userId,
    sessionId,
    messageId = null,
    conversationId = null,
    title,
    metadata = {},
    payload = {},
  }) {
    return this.database.createWorkspaceArtifact({
      workspaceId,
      userId,
      sessionId,
      messageId,
      conversationId,
      artifactType: 'PROCESS_STEP',
      title,
      metadata,
      payload,
    });
  }

  async createProcessArtifactAsync(input) {
    return callPlatformDatabase(this.database, 'createWorkspaceArtifactAsync', 'createWorkspaceArtifact', { ...input, artifactType: 'PROCESS_STEP' });
  }

  createFileArtifact({
    workspaceId,
    userId,
    sessionId,
    messageId = null,
    title,
    content,
    encoding = 'utf8',
    format,
    mimeType,
    purpose = '',
    runId = null,
    inputArtifactIds = [],
    size = 0,
    source = null,
  }) {
    return this.database.createWorkspaceArtifact({
      workspaceId,
      userId,
      sessionId,
      messageId,
      artifactType: 'FILE',
      title,
      metadata: {
        format,
        mimeType,
        size,
        purpose,
        source,
        runId,
        inputArtifactIds,
        parentArtifactIds: inputArtifactIds,
      },
      payload: {
        encoding,
        content,
        format,
        mimeType,
      },
    });
  }

  async createFileArtifactAsync(input) {
    const { workspaceId, userId, sessionId, messageId = null, title, content, encoding = 'utf8', format, mimeType, purpose = '', runId = null, inputArtifactIds = [], size = 0, source = null } = input;
    return callPlatformDatabase(this.database, 'createWorkspaceArtifactAsync', 'createWorkspaceArtifact', { workspaceId, userId, sessionId, messageId, artifactType: 'FILE', title, metadata: { format, mimeType, size, purpose, source, runId, inputArtifactIds, parentArtifactIds: inputArtifactIds }, payload: { encoding, content, format, mimeType } });
  }

  // 通用表格产物写入：用于本地上传解析等非查询来源的表格数据。
  createTableArtifact({ artifactType = 'TABLE', ...params }) {
    return this.database.createWorkspaceArtifact({ artifactType, ...params });
  }

  async createTableArtifactAsync({ artifactType = 'TABLE', ...params }) {
    return callPlatformDatabase(this.database, 'createWorkspaceArtifactAsync', 'createWorkspaceArtifact', { artifactType, ...params });
  }

  createCodeArtifact({
    workspaceId,
    userId,
    sessionId,
    messageId = null,
    title,
    code,
    stdout = '',
    stderr = '',
    success = true,
    durationMs = 0,
    runId,
    inputArtifacts = [],
    outputs = [],
    purpose = '',
  }) {
    return this.database.createWorkspaceArtifact({
      workspaceId,
      userId,
      sessionId,
      messageId,
      artifactType: 'CODE',
      title,
      metadata: {
        runId,
        purpose,
        success,
        durationMs,
        inputArtifactIds: inputArtifacts.map((item) => item.artifactId),
        outputArtifactIds: outputs.map((item) => item.artifactId),
        inputArtifacts,
        outputs,
      },
      payload: {
        code: String(code ?? ''),
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      },
    });
  }

  async createCodeArtifactAsync(input) {
    const { workspaceId, userId, sessionId, messageId = null, title, code, stdout = '', stderr = '', success = true, durationMs = 0, runId, inputArtifacts = [], outputs = [], purpose = '' } = input;
    return callPlatformDatabase(this.database, 'createWorkspaceArtifactAsync', 'createWorkspaceArtifact', { workspaceId, userId, sessionId, messageId, artifactType: 'CODE', title, metadata: { runId, purpose, success, durationMs, inputArtifactIds: inputArtifacts.map((item) => item.artifactId), outputArtifactIds: outputs.map((item) => item.artifactId), inputArtifacts, outputs }, payload: { code: String(code ?? ''), stdout: String(stdout ?? ''), stderr: String(stderr ?? '') } });
  }

  bindArtifactsToMessage({ artifactIds, userId, messageId }) {
    return this.database.bindWorkspaceArtifactsToMessage({
      artifactIds,
      userId,
      messageId,
    });
  }

  async bindArtifactsToMessageAsync(args) {
    return callPlatformDatabase(this.database, 'bindWorkspaceArtifactsToMessageAsync', 'bindWorkspaceArtifactsToMessage', args);
  }

  async transformArtifactAsync({ artifactId, userId, operation, params = {} }) {
    if (!this.database.isAsyncPlatformStore && !this.database.createWorkspaceArtifactAsync) {
      return this.transformArtifact({ artifactId, userId, operation, params });
    }
    const artifact = await this.getArtifactAsync({ artifactId, userId });
    const handler = OPERATIONS[String(operation)];
    if (!handler) throw new Error(`unsupported artifact operation: ${operation}`);
    const payload = clonePayload(artifact.payload);
    handler(payload, params);
    const metadata = { ...artifact.metadata, rowCount: payload.data?.rows?.length ?? 0, columnCount: payload.data?.columns?.length ?? 0, parentArtifactIds: [artifact.id], derivedFromArtifactId: artifact.id, operation, operationParams: params };
    const input = { workspaceId: artifact.workspaceId, userId, sessionId: artifact.sessionId, messageId: artifact.messageId, conversationId: artifact.conversationId, artifactType: 'DERIVED_RESULT', title: `${artifact.title} · ${ARTIFACT_OPERATION_LABELS[operation] ?? operation}`, metadata, payload };
    return callPlatformDatabase(this.database, 'createWorkspaceArtifactAsync', 'createWorkspaceArtifact', input);
  }

  transformArtifact({
    artifactId,
    userId,
    operation,
    params = {},
  }) {
    const artifact = this.getArtifact({ artifactId, userId });
    const handler = OPERATIONS[String(operation)];
    if (!handler) {
      throw new Error(`unsupported artifact operation: ${operation}`);
    }
    const payload = clonePayload(artifact.payload);
    handler(payload, params);
    const metadata = {
      ...artifact.metadata,
      rowCount: payload.data?.rows?.length ?? 0,
      columnCount: payload.data?.columns?.length ?? 0,
      parentArtifactIds: [artifact.id],
      derivedFromArtifactId: artifact.id,
      operation,
      operationParams: params,
    };
    return this.database.createWorkspaceArtifact({
      workspaceId: artifact.workspaceId,
      userId,
      sessionId: artifact.sessionId,
      messageId: artifact.messageId,
      conversationId: artifact.conversationId,
      artifactType: 'DERIVED_RESULT',
      title: `${artifact.title} · ${ARTIFACT_OPERATION_LABELS[operation] ?? operation}`,
      metadata,
      payload,
    });
  }

  exportArtifact({ artifactId, userId, format = 'json' }) {
    const artifact = this.getArtifact({ artifactId, userId });
    const workspace = this.database.getWorkspace(artifact.workspaceId, userId);
    return this.exportArtifactRecord(artifact, workspace, format);
  }

  async exportArtifactAsync({ artifactId, userId, format = 'json' }) {
    const artifact = await this.getArtifactAsync({ artifactId, userId });
    const workspace = await callPlatformDatabase(this.database, 'getWorkspaceAsync', 'getWorkspace', artifact.workspaceId, userId);
    return this.exportArtifactRecord(artifact, workspace, format);
  }

  exportArtifactRecord(artifact, workspace, format) {
    const normalizedFormat = String(format).toLowerCase();
    if (
      artifact.artifactType === 'FILE'
      && artifact.payload?.content !== undefined
    ) {
      const storedFormat = String(
        artifact.payload.format
        ?? artifact.metadata?.format
        ?? 'bin',
      ).toLowerCase();
      const content = artifact.payload.encoding === 'base64'
        ? Buffer.from(String(artifact.payload.content), 'base64')
        : String(artifact.payload.content);
      return {
        filename: artifact.title || `artifact.${storedFormat}`,
        contentType: artifact.metadata?.mimeType
          ?? (storedFormat === 'xlsx'
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : storedFormat === 'csv'
              ? 'text/csv; charset=utf-8'
              : storedFormat === 'json'
                ? 'application/json; charset=utf-8'
                : 'application/octet-stream'),
        content,
      };
    }
    if (normalizedFormat === 'json') {
      return {
        filename: buildArtifactFileName({
          workspaceName: workspace?.name,
          artifactTitle: artifact.title,
          extension: 'json',
        }),
        contentType: 'application/json; charset=utf-8',
        content: JSON.stringify(artifact.payload, null, 2),
      };
    }
    if (
      ['csv', 'xlsx', 'excel'].includes(normalizedFormat)
      && (artifact.payload?.data?.columns ?? []).length === 0
    ) {
      throw new Error('该产物不含表格数据，请改用 JSON 格式导出');
    }
    if (normalizedFormat === 'csv') {
      const columns = artifact.payload?.data?.columns ?? [];
      const rows = artifact.payload?.data?.rows ?? [];
      const lines = [
        columns.map((column) => csvEscape(column.name ?? columnKey(column))).join(','),
        ...rows.map((row) => columns
          .map((column) => {
            const value = row?.[columnKey(column)];
            return csvEscape(
              column?.presentationType
                ? formatPresentationCell(value, column)
                : value,
            );
          })
          .join(',')),
      ];
      return {
        filename: buildArtifactFileName({
          workspaceName: workspace?.name,
          artifactTitle: artifact.title,
          extension: 'csv',
        }),
        contentType: 'text/csv; charset=utf-8',
        content: `\ufeff${lines.join('\r\n')}`,
      };
    }
    if (normalizedFormat === 'xlsx' || normalizedFormat === 'excel') {
      const columns = artifact.payload?.data?.columns ?? [];
      const rows = artifact.payload?.data?.rows ?? [];
      return {
        filename: buildArtifactFileName({
          workspaceName: workspace?.name,
          artifactTitle: artifact.title,
          extension: 'xlsx',
        }),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        content: createXlsxBuffer({
          sheetName: artifact.title || '数据',
          columns,
          rows,
        }),
      };
    }
    throw new Error(`unsupported export format: ${format}`);
  }
}

export { OPERATIONS };
