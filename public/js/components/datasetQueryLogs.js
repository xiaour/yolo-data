// 数据集查询审计：原先挂在「数据集」页的标签下，现统一并入「运行审计」页。
// 独立成组件，避免 audit 与 admin 两个页面模块互相引用。
import * as core from '../core/runtime.js';

const {
  escapeHtml,
  formatDate,
  formatDurationSeconds,
  openModal,
} = core;

export function renderDatasetQueryLogs(logs) {
  const list = Array.isArray(logs) ? logs : [];
  return `
    <div class="data-table-wrap">
      <table class="data-table">
        <thead><tr><th>时间</th><th>用户</th><th>数据集</th><th>行数</th><th>耗时</th><th>状态</th><th>SQL</th></tr></thead>
        <tbody>
          ${list.map((log) => `
            <tr class="is-clickable" data-dataset-log-id="${log.id}">
              <td>${escapeHtml(formatDate(log.createdAt))}</td>
              <td>${escapeHtml(log.userName || '-')}</td>
              <td>${escapeHtml(log.datasetName || '-')}</td>
              <td>${log.rowCount}</td>
              <td>${formatDurationSeconds(log.latencyMs)}</td>
              <td><span class="tag ${log.success ? 'tag-teal' : 'tag-red'}">${log.success ? '成功' : '失败'}</span></td>
              <td class="mono"><span class="table-cell-clamp">${escapeHtml(log.sqlText || log.errorMessage || '-')}</span></td>
            </tr>
          `).join('') || '<tr><td colspan="7">暂无查询记录</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

// 点击行查看完整 SQL。
export function bindDatasetQueryLogs(root, logs) {
  const list = Array.isArray(logs) ? logs : [];
  root.querySelectorAll('[data-dataset-log-id]').forEach((row) => {
    row.addEventListener('click', () => {
      const log = list.find((item) => String(item.id) === String(row.dataset.datasetLogId));
      if (!log) {
        return;
      }
      openModal({
        title: 'SQL 查询详情',
        editor: true,
        body: `
          <div class="answer-meta">
            <span class="meta-pill">${escapeHtml(log.userName || '-')}</span>
            <span class="meta-pill">${escapeHtml(log.datasetName || '-')}</span>
            <span class="meta-pill">${log.rowCount} 行</span>
            <span class="meta-pill">${formatDurationSeconds(log.latencyMs)}</span>
          </div>
          <pre class="sql-review">${escapeHtml(log.sqlText || log.errorMessage || '-')}</pre>
        `,
      });
    });
  });
}
