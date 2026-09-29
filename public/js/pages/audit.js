import * as core from '../core/runtime.js';

const {
  ICONS,
  PAGE_META,
  state,
  icon,
  hydrateIcons,
  customSelectRegistry,
  optionText,
  customSelectParts,
  closeCustomSelects,
  positionCustomSelectMenu,
  rebuildCustomSelectMenu,
  syncCustomSelect,
  enhanceCustomSelect,
  enhanceCustomSelects,
  escapeHtml,
  escapeAttr,
  parseJson,
  formatNumber,
  formatPresentationText,
  formatPresentationCell,
  presentationChartValue,
  formatDurationSeconds,
  formatDate,
  formatTemporalValue,
  isTemporalColumn,
  formatSessionTime,
  initials,
  api,
  streamApi,
  toast,
  openModal,
  closeModal,
  setBusy,
  getUserDisplay,
  getTheme,
  hideThemeBreadcrumb,
  syncThemeBreadcrumb,
  formatModelName,
  formatSourceMode,
  formatProvenance,
  renderRuntime,
  renderUserSelect,
  setActivePage,
  loadBootstrap,
  renderPage,
  emptyState,
  clearSidebarSessions,
  updateWorkspaceChrome,
  setWorkspaceDrawer,
  navigate,
  registerQueryHooks,
  renderSafeMarkdown,
  visibleExecutionStages,
} = core;

async function renderAuditPage(root) {
  if (state.currentUser.role !== 'ADMIN') {
    root.innerHTML = `<div class="section-band">${emptyState('运行审计仅对平台管理员开放', 'scroll-text')}</div>`;
    return;
  }
  root.innerHTML = `<div class="loading-state"><span class="spinner"></span>正在读取审计记录</div>`;
  const logs = await api('/api/audit?limit=200');
  root.innerHTML = `
    <div class="audit-grid">
      <section class="section-band">
        <div class="section-head">
          <div><h2>运行审计</h2><p>记录指标连接、主题配置、权限变更和智能问数执行。</p></div>
          <button class="btn" id="refreshAuditBtn" type="button">${icon('refresh', '刷新')}刷新</button>
        </div>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead><tr><th>时间</th><th>用户</th><th>主题</th><th>操作</th><th>摘要</th></tr></thead>
            <tbody>
              ${logs.map((log, index) => `
                <tr class="is-clickable${index === 0 ? ' is-selected' : ''}" data-audit-id="${log.id}">
                  <td>${escapeHtml(formatDate(log.createdAt))}</td>
                  <td>${escapeHtml(log.userName || '-')}</td>
                  <td>${escapeHtml(log.themeName || '-')}</td>
                  <td><span class="tag tag-blue">${escapeHtml(log.action)}</span></td>
                  <td class="mono"><span class="table-cell-clamp">${escapeHtml(auditSummary(log.detail ?? {}))}</span></td>
                </tr>
              `).join('') || '<tr><td colspan="5">暂无审计记录</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
      <aside class="section-band audit-detail" id="auditDetail">
        ${renderAuditDetail(logs[0])}
      </aside>
    </div>
  `;
  document.getElementById('refreshAuditBtn').addEventListener('click', renderPage);
  root.querySelectorAll('[data-audit-id]').forEach((row) => {
    row.addEventListener('click', () => {
      root.querySelectorAll('[data-audit-id]').forEach((item) => item.classList.remove('is-selected'));
      row.classList.add('is-selected');
      const log = logs.find((item) => String(item.id) === String(row.dataset.auditId));
      document.getElementById('auditDetail').innerHTML = renderAuditDetail(log);
    });
  });
}

function auditSummary(detail) {
  const value = detail && typeof detail === 'object'
    ? Object.values(detail).find((item) => typeof item === 'string' || typeof item === 'number')
    : null;
  return value == null || value === ''
    ? JSON.stringify(detail ?? {})
    : String(value);
}

function renderAuditDetail(log) {
  if (!log) {
    return emptyState('选择左侧审计记录查看详情', 'scroll-text');
  }
  return `
    <div class="section-head">
      <div><h3>审计详情</h3><p>${escapeHtml(log.action)}</p></div>
    </div>
    <div class="detail-list">
      <div class="detail-row"><span>用户</span><strong>${escapeHtml(log.userName || '-')}</strong></div>
      <div class="detail-row"><span>主题</span><strong>${escapeHtml(log.themeName || '-')}</strong></div>
      <div class="detail-row"><span>时间</span><strong>${escapeHtml(formatDate(log.createdAt))}</strong></div>
    </div>
    <pre class="json-review">${escapeHtml(JSON.stringify(log.detail ?? {}, null, 2))}</pre>
  `;
}



export {
  renderAuditPage,
  auditSummary,
  renderAuditDetail,
};
