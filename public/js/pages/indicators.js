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

async function renderIndicatorsPage(root) {
  root.innerHTML = `<div class="page-stack"><div class="loading-state"><span class="spinner"></span>正在读取指标目录</div></div>`;
  const keyword = '';
  const data = await api(`/api/indicators?themeId=${state.selectedThemeId ?? ''}&keyword=${encodeURIComponent(keyword)}&limit=1000`);
  state.indicators = data.items ?? [];
  const themeOptions = state.themes.map((theme) => (
    `<option value="${theme.id}"${Number(theme.id) === Number(state.selectedThemeId) ? ' selected' : ''}>${escapeHtml(theme.name)}</option>`
  )).join('');
  const derivedCount = state.indicators.filter(
    (indicator) => String(indicator.indicatorLevel ?? '').toUpperCase() === 'DERIVED',
  ).length;
  const dimensionCount = state.indicators.reduce(
    (sum, indicator) => sum + Number(indicator.dimensions?.length ?? 0),
    0,
  );
  root.innerHTML = `
    <div class="page-stack">
      <section class="section-band">
        <div class="summary-grid indicator-stats">
          <div class="summary-cell"><span>指标总数</span><strong>${state.indicators.length}</strong></div>
          <div class="summary-cell"><span>原子指标</span><strong>${state.indicators.length - derivedCount}</strong></div>
          <div class="summary-cell"><span>派生指标</span><strong>${derivedCount}</strong></div>
          <div class="summary-cell"><span>维度覆盖</span><strong>${dimensionCount}<small>类</small></strong></div>
        </div>
        <div class="toolbar indicator-toolbar">
          <div class="grow"><input class="field" id="indicatorKeyword" placeholder="搜索指标名称、标识或口径" /></div>
          <select class="select" id="indicatorTypeFilter" style="max-width:210px">
            <option value="">全部指标类型</option>
            ${state.indicatorTypes.map((type) => `<option value="${escapeAttr(type.id)}">${escapeHtml(type.name)}</option>`).join('')}
          </select>
          <select class="select" id="indicatorThemeFilter" style="max-width:210px">${themeOptions}</select>
          <button class="btn" id="indicatorSearchBtn" type="button">搜索</button>
          ${state.currentUser.role === 'ADMIN' ? `
            <button class="btn btn-quiet" id="syncIndicatorsBtn" type="button">刷新连接</button>
          ` : ''}
        </div>
      </section>
      <section>
        ${renderIndicatorTable(state.indicators)}
      </section>
    </div>
  `;

  document.getElementById('indicatorThemeFilter').addEventListener('change', (event) => {
    state.selectedThemeId = Number(event.target.value);
    renderPage();
  });
  document.getElementById('indicatorSearchBtn').addEventListener('click', searchIndicators);
  document.getElementById('indicatorKeyword').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      searchIndicators();
    }
  });
  document.getElementById('syncIndicatorsBtn')?.addEventListener('click', async (event) => {
    setBusy(event.currentTarget, true, '检查中');
    try {
      const result = await api('/api/indicators/sync', { method: 'POST' });
      if (result.disabled) {
        toast('指标平台匹配已停用，未执行同步');
      } else if (result.skipped) {
        toast(result.message ?? '指标平台未接入，已跳过同步');
      } else {
        toast(`指标平台连接正常，共 ${result.indicators} 个指标`);
      }
      await loadBootstrap(state.currentUser.id);
      renderPage();
    } catch (error) {
      toast(error.message, 'error');
      setBusy(event.currentTarget, false);
    }
  });
  bindIndicatorRows();
}

async function searchIndicators() {
  const keyword = document.getElementById('indicatorKeyword').value.trim();
  const typeId = document.getElementById('indicatorTypeFilter').value;
  const data = await api(`/api/indicators?themeId=${state.selectedThemeId ?? ''}&keyword=${encodeURIComponent(keyword)}&typeId=${encodeURIComponent(typeId)}&limit=1000`);
  state.indicators = data.items ?? [];
  document.querySelector('.page-stack > section:last-child').innerHTML = renderIndicatorTable(state.indicators);
  bindIndicatorRows();
}

function renderIndicatorTable(indicators) {
  if (!indicators.length) {
    return `<div class="section-band">${emptyState('当前主题和权限范围内没有指标', 'library')}</div>`;
  }
  return `
    <div class="data-table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>指标名称</th><th>标识</th><th>类型</th><th>上游依赖</th><th>维度数</th><th>可用主题</th><th></th></tr>
        </thead>
        <tbody>
          ${indicators.map((indicator) => {
            const attachedThemes = state.themes.filter((theme) => (
              (theme.indicatorIds ?? []).map(String).includes(String(indicator.id))
            ));
            return `
              <tr>
                <td><strong>${escapeHtml(indicator.name)}</strong></td>
                <td class="mono">${escapeHtml(indicator.bizName)}</td>
                <td>${escapeHtml(indicator.indicatorLevel || '原子')}</td>
                <td>${indicator.metrics?.length ?? 0} 个</td>
                <td>${indicator.dimensions?.length ?? 0}</td>
                <td>${attachedThemes.length ? attachedThemes.map((theme) => escapeHtml(theme.name)).join(' · ') : '<span class="muted">未挂主题</span>'}</td>
                <td><button class="btn btn-quiet btn-small" data-indicator-detail="${escapeAttr(indicator.id)}" type="button">详情</button></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function bindIndicatorRows() {
  document.querySelectorAll('[data-indicator-detail]').forEach((button) => {
    button.addEventListener('click', async () => {
      setBusy(button, true);
      try {
        const detail = await api(`/api/indicators/${encodeURIComponent(button.dataset.indicatorDetail)}/detail?themeId=${state.selectedThemeId ?? ''}`);
        const indicator = detail.indicator ?? detail.cached ?? {};
        openModal({
          title: indicator.name ?? '指标详情',
          wide: true,
          body: `
            <div class="detail-grid">
              <div class="detail-item"><span>指标编码</span><strong class="mono">${escapeHtml(indicator.bizName ?? indicator.id)}</strong></div>
              <div class="detail-item"><span>指标类型 / 层级</span><strong>${escapeHtml(indicator.typeName ?? '-')} · ${escapeHtml(indicator.indicatorLevel ?? '-')}</strong></div>
              <div class="detail-item"><span>负责人 / 部门</span><strong>${escapeHtml(indicator.owner ?? '-')} / ${escapeHtml(indicator.department ?? '-')}</strong></div>
              <div class="detail-item"><span>关联模型</span><strong>${escapeHtml((indicator.models ?? []).map((model) => model.modelName).join('、') || '-')}</strong></div>
              <div class="detail-item span-2"><span>业务口径</span><p>${escapeHtml(indicator.businessCaliber ?? '-')}</p></div>
              <div class="detail-item span-2"><span>指标说明</span><p>${escapeHtml(indicator.description ?? '-')}</p></div>
            </div>
            <div class="section-head" style="margin-top:22px"><div><h3>指标与维度</h3><p>智能体只允许使用下列语义字段。</p></div></div>
            <div class="data-table-wrap">
              <table class="data-table">
                <thead><tr><th>指标业务名</th><th>指标名称</th><th>所属模型</th></tr></thead>
                <tbody>
                  ${(detail.metrics ?? []).map((metric) => `<tr><td class="mono">${escapeHtml(metric.metricBizName ?? metric.bizName)}</td><td>${escapeHtml(metric.metricName ?? metric.name)}</td><td>${escapeHtml(metric.modelName ?? '-')}</td></tr>`).join('') || '<tr><td colspan="3">无</td></tr>'}
                </tbody>
              </table>
            </div>
            <div class="section-head" style="margin-top:22px"><div><h3>可用维度</h3></div></div>
            <div class="check-grid">
              ${(detail.dimensions ?? indicator.dimensions ?? []).map((dimension) => `<div class="check-item"><span class="mono">${escapeHtml(dimension.dimensionBizName ?? dimension.bizName)}</span><span>${escapeHtml(dimension.dimensionName ?? dimension.name)}</span></div>`).join('') || '<div class="muted">无</div>'}
            </div>
          `,
        });
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        setBusy(button, false);
      }
    });
  });
}



export {
  renderIndicatorsPage,
  searchIndicators,
  renderIndicatorTable,
  bindIndicatorRows,
};
