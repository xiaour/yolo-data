// 工作区产物展示：结果产物与 agent 过程文件分区呈现，过程文件按步骤顺序可追踪。

import * as core from '../core/runtime.js';
import { renderDataTable } from './table.js';

const {
  icon,
  escapeHtml,
  escapeAttr,
  formatDurationSeconds,
  emptyState,
} = core;

const PROCESS_ARTIFACT_TYPE = 'PROCESS_STEP';

const KIND_ICONS = {
  TABLE: { iconName: 'file-spreadsheet', className: 'is-excel' },
  SQL_RESULT: { iconName: 'file-spreadsheet', className: 'is-excel' },
  CATALOG: { iconName: 'list-checks', className: 'is-text' },
  CONTRACT: { iconName: 'scroll-text', className: 'is-text' },
  ERROR: { iconName: 'circle-alert', className: 'is-text' },
  JSON: { iconName: 'file-json', className: 'is-json' },
};

function isProcessArtifact(artifact) {
  return String(artifact?.artifactType ?? '') === PROCESS_ARTIFACT_TYPE;
}

function processMeta(artifact) {
  const metadata = artifact?.metadata ?? {};
  const sequence = Number(metadata.sequence) > 0 ? Number(metadata.sequence) : null;
  const parts = [
    sequence ? `步骤 ${String(sequence).padStart(2, '0')}` : '过程步骤',
    metadata.dataKindLabel ?? metadata.toolTitle ?? metadata.tool ?? '过程文件',
  ];
  if (metadata.rowCount) {
    parts.push(`${metadata.rowCount} 行`);
  }
  if (metadata.durationMs != null) {
    parts.push(formatDurationSeconds(metadata.durationMs));
  }
  if (metadata.status === 'error') {
    parts.push('执行失败');
  }
  return { sequence, label: parts.join(' · ') };
}

function workspaceArtifactFileMeta(artifact) {
  const metadata = artifact?.metadata ?? {};
  if (isProcessArtifact(artifact)) {
    const kind = KIND_ICONS[String(metadata.dataKind ?? 'JSON').toUpperCase()]
      ?? KIND_ICONS.JSON;
    return { ...kind, label: metadata.dataKindLabel ?? '过程文件' };
  }
  const source = [
    artifact?.artifactType,
    metadata.format,
    metadata.fileType,
    metadata.mimeType,
    metadata.fileName,
  ].filter(Boolean).join(' ').toLowerCase();
  if (source.includes('code')) {
    return { iconName: 'file-code', label: '代码运行记录', className: 'is-code' };
  }
  if (source.includes('query_result')) {
    return { iconName: 'file-spreadsheet', label: '查询数据快照', className: 'is-excel' };
  }
  if (source.includes('derived_result')) {
    return { iconName: 'file-spreadsheet', label: '派生数据结果', className: 'is-excel' };
  }
  if (source.includes('json')) {
    return { iconName: 'file-json', label: 'JSON 文件', className: 'is-json' };
  }
  if (source.includes('csv') || source.includes('tsv')) {
    return { iconName: 'file-spreadsheet', label: 'CSV 文件', className: 'is-csv' };
  }
  if (source.includes('xlsx') || source.includes('xls') || source.includes('excel')) {
    return { iconName: 'file-spreadsheet', label: 'Excel 文件', className: 'is-excel' };
  }
  if (source.includes('table')) {
    return { iconName: 'file-spreadsheet', label: '表格产物', className: 'is-excel' };
  }
  if (source.includes('markdown') || source.includes('text') || source.includes('md')) {
    return { iconName: 'file-text', label: '文本文件', className: 'is-text' };
  }
  return { iconName: 'file', label: '文件产物', className: 'is-file' };
}

function renderArtifactCard(artifact, lineage) {
  const file = workspaceArtifactFileMeta(artifact);
  const process = isProcessArtifact(artifact);
  const meta = processMeta(artifact);
  const downloadable = artifact.artifactType !== 'CODE';
  const hasTable = Number(artifact.metadata?.columnCount ?? 0) > 0;
  const subtitle = process
    ? meta.label
    : `${file.label} · ${artifact.metadata?.rowCount ?? 0} 行 · v${artifact.currentVersion}`;
  return `
      <article class="workspace-artifact-card" data-artifact-id="${escapeAttr(artifact.id)}">
        <span class="workspace-artifact-file-icon ${escapeAttr(file.className)}">
          ${icon(file.iconName, file.label)}
        </span>
        <div class="workspace-artifact-copy">
          <strong title="${escapeAttr(artifact.title || '问数产物')}">${escapeHtml(artifact.title || '问数产物')}</strong>
          <small title="${escapeAttr(subtitle)}">${escapeHtml(subtitle)}</small>
          ${lineage ? `<small class="workspace-artifact-lineage">上游：${escapeHtml(lineage)}</small>` : ''}
        </div>
        <div class="workspace-artifact-actions">
          <button class="btn btn-quiet btn-icon workspace-action-icon" type="button"
            data-artifact-view="${escapeAttr(artifact.id)}"
            title="查看产物" aria-label="查看产物">
            ${icon('eye', '查看产物')}
          </button>
          ${downloadable && hasTable ? `
          <button class="btn btn-quiet btn-icon workspace-action-icon is-csv" type="button"
            data-artifact-download="${escapeAttr(artifact.id)}" data-format="xlsx"
            title="下载 Excel 文件" aria-label="下载 Excel 文件">
            ${icon('file-spreadsheet', '下载 Excel 文件')}
          </button>
          <button class="btn btn-quiet btn-icon workspace-action-icon is-csv" type="button"
            data-artifact-download="${escapeAttr(artifact.id)}" data-format="csv"
            title="下载 CSV 文件" aria-label="下载 CSV 文件">
            ${icon('file-spreadsheet', '下载 CSV 文件')}
          </button>
          ` : ''}
          ${downloadable ? `
          <button class="btn btn-quiet btn-icon workspace-action-icon is-json" type="button"
            data-artifact-download="${escapeAttr(artifact.id)}" data-format="json"
            title="下载 JSON 文件" aria-label="下载 JSON 文件">
            ${icon('file-json', '下载 JSON 文件')}
          </button>
          ` : ''}
        </div>
      </article>
    `;
}

// 结果产物优先展示；过程文件按步骤顺序排列，并标注上游步骤便于追踪。
function renderWorkspaceArtifactList(artifacts = []) {
  const results = artifacts.filter((artifact) => !isProcessArtifact(artifact));
  const processes = artifacts
    .filter(isProcessArtifact)
    .sort((left, right) => (
      Number(left.metadata?.sequence ?? 0) - Number(right.metadata?.sequence ?? 0)
      || String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))
    ));
  const labels = new Map(processes.map((artifact) => {
    const sequence = Number(artifact.metadata?.sequence ?? 0);
    return [artifact.id, `${sequence ? `步骤 ${String(sequence).padStart(2, '0')} ` : ''}${artifact.metadata?.toolTitle ?? artifact.title ?? ''}`.trim()];
  }));
  const sections = [];
  if (results.length > 0) {
    sections.push(`
      <div class="workspace-artifact-group">
        <div class="workspace-artifact-group-head">
          <span>结果产物</span><span>${results.length}</span>
        </div>
        ${results.map((artifact) => renderArtifactCard(artifact, '')).join('')}
      </div>
    `);
  }
  if (processes.length > 0) {
    sections.push(`
      <div class="workspace-artifact-group">
        <div class="workspace-artifact-group-head">
          <span>过程文件（按执行步骤）</span><span>${processes.length}</span>
        </div>
        ${processes.map((artifact) => {
          const parents = (artifact.metadata?.inputArtifactIds ?? [])
            .map((id) => labels.get(id))
            .filter(Boolean);
          return renderArtifactCard(artifact, parents.join('、'));
        }).join('')}
      </div>
    `);
  }
  return sections.join('');
}

function renderProcessArtifactView(artifact) {
  const metadata = artifact?.metadata ?? {};
  const payload = artifact?.payload ?? {};
  const columns = payload.data?.columns ?? [];
  const rows = payload.data?.rows ?? [];
  const facts = [
    ['环节', metadata.toolTitle ?? payload.step?.title ?? metadata.tool ?? '-'],
    ['类型', metadata.dataKindLabel ?? payload.dataKind ?? '-'],
    ['耗时', metadata.durationMs == null ? '-' : formatDurationSeconds(metadata.durationMs)],
    ['记录行数', String(metadata.rowCount ?? 0)],
  ];
  if (metadata.sampled) {
    facts.push(['行数说明', `已记录前 ${metadata.capturedRowCount ?? rows.length} 行样本`]);
  }
  if (metadata.truncated) {
    facts.push(['截断', '内容超出单次记录上限，已截断']);
  }
  return `
    <div class="answer-meta">
      <span class="meta-pill">过程文件</span>
      ${metadata.sequence ? `<span class="meta-pill">步骤 ${String(metadata.sequence).padStart(2, '0')}</span>` : ''}
      <span class="meta-pill">${escapeHtml(metadata.status === 'error' ? '执行失败' : '执行成功')}</span>
      ${metadata.stageCode ? `<span class="meta-pill">${escapeHtml(metadata.stageCode)}</span>` : ''}
    </div>
    <div class="execution-review-facts">
      ${facts.map(([label, value]) => `
        <div class="execution-review-fact">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `).join('')}
    </div>
    ${payload.summary ? `<div class="chat-answer-text">${escapeHtml(payload.summary)}</div>` : ''}
    ${columns.length > 0
      ? renderDataTable(columns, rows, { timeGrain: metadata.timeGrain ?? null })
      : emptyState('该环节没有可展示的数据表')}
  `;
}

export {
  isProcessArtifact,
  renderProcessArtifactView,
  renderWorkspaceArtifactList,
  workspaceArtifactFileMeta,
};
