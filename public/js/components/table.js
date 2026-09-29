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

function renderDataTable(columns, rows, { timeGrain = null } = {}) {
  if (!rows.length) {
    return `<div class="data-table-wrap">${emptyState('当前权限与筛选条件下没有数据', 'table')}</div>`;
  }
  return `
    <div class="data-table-wrap">
      <table class="data-table">
        <thead><tr>${columns.map((column) => `<th>${escapeHtml(column.name ?? column.bizName)}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.slice(0, 500).map((row) => `
            <tr>${columns.map((column) => {
              const field = column.bizName ?? column.name;
              const numeric = String(column.showType).toUpperCase() === 'NUMBER';
              const value = row[field];
              const displayValue = numeric
                ? column.presentationType
                  ? formatPresentationCell(value, column)
                  : formatNumber(value)
                : isTemporalColumn(column)
                  ? formatTemporalValue(value, timeGrain)
                  : value ?? '-';
              return `<td class="${numeric ? 'numeric-cell' : ''}">${escapeHtml(displayValue)}</td>`;
            }).join('')}</tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}



export {
  renderDataTable,
};
