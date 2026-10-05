import { buildArtifactFileName, buildArtifactTitle } from './fileName.js';
import { createXlsxBuffer } from './xlsx.js';
import { buildArtifactCapabilities } from './artifactCapabilities.js';
import { formatPresentationCell } from './resultPresentation.js';

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function columnKey(column) {
  return String(column?.bizName ?? column?.nameEn ?? column?.name ?? '').trim();
}

function isNumericColumn(column) {
  return String(column?.showType ?? column?.type ?? '').toUpperCase() === 'NUMBER'
    || String(column?.type ?? '').toUpperCase() === 'DECIMAL';
}

function clonePayload(payload) {
  return JSON.parse(JSON.stringify(payload ?? {}));
}

function addSummaryRow(payload, params = {}) {
  const columns = payload.data?.columns ?? [];
  const rows = payload.data?.rows ?? [];
  const summary = {};
  let labelKey = String(
    params.labelColumn
    ?? columnKey(columns.find((column) => !isNumericColumn(column)) ?? {}),
  );
  if (!labelKey) {
    labelKey = '__row_label';
    payload.data.columns = [
      {
        name: String(params.labelColumnName ?? '汇总项'),
        bizName: labelKey,
        showType: 'CATEGORY',
        type: 'STRING',
      },
      ...columns,
    ];
  }
  if (labelKey) {
    summary[labelKey] = String(params.label ?? '汇总');
  }
  for (const column of columns) {
    const key = columnKey(column);
    if (!key || key === labelKey || !isNumericColumn(column)) {
      continue;
    }
    const values = rows.map((row) => asNumber(row?.[key])).filter((value) => value !== null);
    if (values.length === 0) {
      continue;
    }
    const label = String(column.name ?? '');
    const isAverage = /率|占比|比例|单价|均价|均值/.test(label)
      || String(params.averageColumns ?? '').split(',').includes(key);
    summary[key] = isAverage
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : values.reduce((sum, value) => sum + value, 0);
  }
  const position = String(params.position ?? 'top');
  payload.data.rows = position === 'bottom'
    ? [...rows, summary]
    : [summary, ...rows];
  return payload;
}

function sortRows(payload, params = {}) {
  const field = String(params.field ?? '');
  if (!field) {
    throw new Error('sort requires field');
  }
  const direction = String(params.direction ?? 'DESC').toUpperCase() === 'ASC' ? 1 : -1;
  payload.data.rows = [...(payload.data?.rows ?? [])].sort((left, right) => {
    const leftNumber = asNumber(left?.[field]);
    const rightNumber = asNumber(right?.[field]);
    if (leftNumber !== null && rightNumber !== null) {
      return (leftNumber - rightNumber) * direction;
    }
    return String(left?.[field] ?? '').localeCompare(
      String(right?.[field] ?? ''),
      'zh-CN',
      { numeric: true },
    ) * direction;
  });
  return payload;
}

function renameColumn(payload, params = {}) {
  const field = String(params.field ?? params.bizName ?? '');
  const name = String(params.name ?? '').trim();
  if (!field || !name) {
    throw new Error('rename_column requires field and name');
  }
  const column = (payload.data?.columns ?? []).find((item) => columnKey(item) === field);
  if (!column) {
    throw new Error(`column not found: ${field}`);
  }
  column.name = name;
  return payload;
}

function formatColumn(payload, params = {}) {
  const field = String(params.field ?? params.bizName ?? '');
  const column = (payload.data?.columns ?? []).find((item) => columnKey(item) === field);
  if (!column) {
    throw new Error(`column not found: ${field}`);
  }
  column.decimals = Number.isFinite(Number(params.decimals))
    ? Number(params.decimals)
    : column.decimals;
  column.unit = params.unit ?? column.unit;
  return payload;
}

function addRatioColumn(payload, params = {}) {
  const numerator = String(params.numerator ?? '');
  const denominator = String(params.denominator ?? '');
  const field = String(params.field ?? 'ratio');
  if (!numerator || !denominator) {
    throw new Error('add_ratio_column requires numerator and denominator');
  }
  payload.data.columns = [
    ...(payload.data?.columns ?? []),
    {
      name: String(params.name ?? '比例'),
      bizName: field,
      showType: 'NUMBER',
      type: 'DECIMAL',
      unit: params.unit ?? '%',
    },
  ];
  payload.data.rows = (payload.data?.rows ?? []).map((row) => {
    const top = asNumber(row?.[numerator]);
    const bottom = asNumber(row?.[denominator]);
    return {
      ...row,
      [field]: top === null || bottom === null || bottom === 0
        ? null
        : Number(params.percent ?? true) ? (top / bottom) * 100 : top / bottom,
    };
  });
  return payload;
}

function filterRows(payload, params = {}) {
  const field = String(params.field ?? '');
  if (!field) {
    throw new Error('filter_rows requires field');
  }
  const operator = String(params.operator ?? '=').toUpperCase();
  const expected = params.value;
  payload.data.rows = (payload.data?.rows ?? []).filter((row) => {
    const actual = row?.[field];
    if (operator === '!=') {
      return String(actual) !== String(expected);
    }
    if (operator === '>') {
      return Number(actual) > Number(expected);
    }
    if (operator === '>=') {
      return Number(actual) >= Number(expected);
    }
    if (operator === '<') {
      return Number(actual) < Number(expected);
    }
    if (operator === '<=') {
      return Number(actual) <= Number(expected);
    }
    return String(actual) === String(expected);
  });
  return payload;
}

function limitRows(payload, params = {}) {
  const limit = Math.max(1, Math.min(Number(params.limit) || 200, 5000));
  payload.data.rows = (payload.data?.rows ?? []).slice(0, limit);
  return payload;
}

const OPERATIONS = {
  add_summary_row: addSummaryRow,
  sort: sortRows,
  rename_column: renameColumn,
  format_column: formatColumn,
  add_ratio_column: addRatioColumn,
  filter_rows: filterRows,
  limit_rows: limitRows,
};

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
  const text = value === null || value === undefined ? '' : String(value);
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

  listForUser({ userId, sessionId = null }) {
    if (sessionId) {
      const workspace = this.database.getWorkspaceBySession(sessionId, userId);
      return workspace ? [workspace] : [];
    }
    return [];
  }

  listArtifacts({ workspaceId, userId }) {
    const workspace = this.database.getWorkspace(workspaceId, userId);
    if (!workspace) {
      throw new Error('workspace not found');
    }
    return this.database.listWorkspaceArtifacts(workspace.id, userId);
  }

  getArtifact({ artifactId, userId }) {
    const artifact = this.database.getWorkspaceArtifact(artifactId, userId);
    if (!artifact) {
      throw new Error('workspace artifact not found');
    }
    return artifact;
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

  bindArtifactsToMessage({ artifactIds, userId, messageId }) {
    return this.database.bindWorkspaceArtifactsToMessage({
      artifactIds,
      userId,
      messageId,
    });
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
      const workspace = this.database.getWorkspace(artifact.workspaceId, userId);
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
      const workspace = this.database.getWorkspace(artifact.workspaceId, userId);
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
      const workspace = this.database.getWorkspace(artifact.workspaceId, userId);
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
