// 工作区过程文件：把 agent 每个产出数据的环节落成用户可直接读懂的数据文件。
// 只保留数据行和人话元信息，不保存环节参数、原始响应等技术载荷，也不承载业务口径。

const ROW_LIMIT = 200;
const MAX_STEPS_PER_RUN = 60;

const KIND_LABELS = {
  TABLE: '数据表',
  SQL_RESULT: '查询结果',
};

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 工具返回的数据形态可能是完整结果、抽样结果或嵌套在 data 下，这里统一识别。
function extractTable(result) {
  if (!isRecord(result)) {
    return null;
  }
  const columns = Array.isArray(result.columns) ? result.columns : null;
  const rows = Array.isArray(result.rows)
    ? result.rows
    : Array.isArray(result.data?.rows) ? result.data.rows : null;
  const sampleRows = Array.isArray(result.sampleRows) ? result.sampleRows : null;
  const source = rows ?? sampleRows;
  if (!columns || !source || columns.length === 0 || source.length === 0) {
    return null;
  }
  return {
    columns,
    rows: source.slice(0, ROW_LIMIT),
    truncated: source.length > ROW_LIMIT,
    sampled: !rows,
  };
}

function collectRelatedArtifactIds(result) {
  if (!isRecord(result)) {
    return [];
  }
  const ids = [
    result.workspaceArtifactId,
    result.codeArtifactId,
    ...(Array.isArray(result.artifactIds) ? result.artifactIds : []),
    ...(Array.isArray(result.inputArtifactIds) ? result.inputArtifactIds : []),
    ...(Array.isArray(result.outputs) ? result.outputs.map((item) => item?.artifactId) : []),
  ];
  return [...new Set(ids.filter(Boolean).map(String))];
}

// 把一次工具调用整理成过程文件草稿。
// 只有产出可读数据表的环节才落盘；目录、契约、原始 JSON 等纯技术载荷直接跳过。
function buildProcessArtifact({
  tool,
  result = null,
  error = null,
  step = {},
  previousArtifactId = null,
}) {
  const table = error ? null : extractTable(result);
  if (!table) {
    return null;
  }
  const sequence = Number(step.sequence) > 0 ? Number(step.sequence) : null;
  const label = String(step.title ?? tool ?? '执行步骤');
  const dataKind = result?.sql ? 'SQL_RESULT' : 'TABLE';
  const relatedArtifactIds = collectRelatedArtifactIds(result);
  const inputArtifactIds = [
    ...new Set([...(previousArtifactId ? [previousArtifactId] : []), ...relatedArtifactIds]),
  ];
  const rowCount = Number(result?.rowCount ?? table.rows.length);
  const durationMs = Number(step.durationMs);
  const metadata = {
    process: true,
    dataKind,
    dataKindLabel: KIND_LABELS[dataKind],
    stepId: step.id ?? null,
    sequence,
    tool: tool ?? null,
    toolTitle: label,
    stageCode: step.stageCode ?? null,
    skillCode: step.skillCode ?? null,
    skillName: step.skillName ?? null,
    status: error ? 'error' : 'success',
    startedAt: step.startedAt ?? null,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    summary: String(step.detail ?? ''),
    rowCount,
    columnCount: table.columns.length,
    capturedRowCount: table.rows.length,
    sampled: Boolean(table.sampled),
    truncated: Boolean(table.truncated),
    inputArtifactIds,
    parentArtifactIds: inputArtifactIds,
    outputArtifactIds: relatedArtifactIds,
  };
  const payload = {
    step: {
      id: step.id ?? null,
      sequence,
      tool: tool ?? null,
      title: label,
      stageCode: step.stageCode ?? null,
      status: metadata.status,
      durationMs: metadata.durationMs,
    },
    dataKind,
    summary: metadata.summary,
    truncated: { rows: Boolean(table.truncated) },
    data: { columns: table.columns, rows: table.rows },
  };
  const rowLabel = ` · ${rowCount} 行`;
  const title = `${sequence ? `步骤 ${String(sequence).padStart(2, '0')} · ` : ''}${label}${rowLabel}`;
  return { title, metadata, payload };
}

export { buildProcessArtifact, KIND_LABELS, MAX_STEPS_PER_RUN };
