// Shared dataset field-scope console.
//
// Field enable/disable is stored on dataset_fields.enabled and every
// query/agent path reads fields with enabledOnly: true, so a disabled field is
// unreachable for the agent. The dataset management page and the theme
// editor's 数据范围 section both open this component, so the two entry points
// always edit the same setting.

import * as core from '../core/runtime.js';

const {
  api,
  toast,
  setBusy,
  openModal,
  escapeHtml,
  escapeAttr,
} = core;

async function openDatasetFields(datasetId, options = {}) {
  const { onChange, title = '数据集字段' } = options;
  let fields;
  try {
    fields = await api(`/api/business-datasets/${datasetId}/fields`);
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  const disabledCount = fields.filter((field) => field.enabled === false).length;
  const modal = openModal({
    title,
    editor: true,
    wide: true,
    body: `
      <div class="answer-meta">
        <span class="meta-pill">字段 ${fields.length}</span>
        <span class="meta-pill">启用 ${fields.length - disabledCount}</span>
        <span class="meta-pill">禁用 ${disabledCount}</span>
      </div>
      <p class="muted">默认全部启用。禁用的字段仍保留配置，但不会再进入智能体的查询流程（不可作为维度、指标或时间字段）。</p>
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr><th>字段</th><th>名称</th><th>类型</th><th>语义角色</th><th>聚合</th><th>状态</th><th></th></tr></thead>
          <tbody>
            ${fields.map((field) => {
              const enabled = field.enabled !== false;
              return `
                <tr class="${enabled ? '' : 'field-row-disabled'}">
                  <td class="mono">${escapeHtml(field.fieldName)}</td>
                  <td>${escapeHtml(field.displayName)}</td>
                  <td>${escapeHtml(field.dataType)}</td>
                  <td><span class="tag ${field.role === 'METRIC' ? 'tag-blue' : field.role === 'TIME' ? 'tag-amber' : 'tag-teal'}">${escapeHtml(field.role)}</span></td>
                  <td>${escapeHtml(field.aggregator)}</td>
                  <td><span class="tag ${enabled ? 'tag-teal' : 'tag-red'}">${enabled ? '启用' : '已禁用'}</span></td>
                  <td><button class="btn btn-quiet btn-small" type="button" data-field-toggle data-field-name="${escapeAttr(field.fieldName)}" data-field-enabled="${enabled}">${enabled ? '禁用' : '启用'}</button></td>
                </tr>
              `;
            }).join('') || '<tr><td colspan="7">该数据集暂无字段</td></tr>'}
          </tbody>
        </table>
      </div>
    `,
  });
  modal.querySelectorAll('[data-field-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      const enabled = button.dataset.fieldEnabled !== 'true';
      setBusy(button, true);
      try {
        const result = await api(
          `/api/business-datasets/${datasetId}/fields/${encodeURIComponent(button.dataset.fieldName)}`,
          { method: 'PUT', body: JSON.stringify({ enabled }) },
        );
        toast(enabled ? '字段已启用' : '字段已禁用');
        if (typeof onChange === 'function') {
          onChange(result);
        }
        await openDatasetFields(datasetId, options);
      } catch (error) {
        toast(error.message, 'error');
        setBusy(button, false);
      }
    });
  });
}

export { openDatasetFields };
