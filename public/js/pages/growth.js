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

async function renderGrowthPage(root) {
  if (state.currentUser.role !== 'ADMIN') {
    root.innerHTML = `<div class="section-band">${emptyState('质量运营仅对平台管理员开放', 'sprout')}</div>`;
    return;
  }
  root.innerHTML = `<div class="loading-state"><span class="spinner"></span>正在读取质量运营数据</div>`;
  const [feedback, gaps, llm] = await Promise.all([
    api('/api/feedback?limit=200'),
    api('/api/knowledge-gaps?limit=200'),
    api('/api/llm-logs?limit=200'),
  ]);
  const negativeCount = feedback.filter((item) => !item.correct).length;
  root.innerHTML = `
    <div class="page-stack">
      <section class="summary-grid">
        <div class="summary-cell"><span>用户反馈</span><strong>${feedback.length}</strong></div>
        <div class="summary-cell"><span>待处理缺口</span><strong>${gaps.length}</strong></div>
        <div class="summary-cell"><span>负面反馈</span><strong>${negativeCount}</strong></div>
        <div class="summary-cell"><span>LLM 调用成功率</span><strong>${llm.stats?.successRate ?? 0}%</strong></div>
      </section>
      <section class="section-band">
        <div class="section-head">
          <div><h2>知识缺口</h2><p>未命中指标、失败查询模式和高频纠错会进入这里。</p></div>
          <button class="btn" id="refreshGrowthBtn" type="button">${icon('refresh', '刷新')}刷新</button>
        </div>
        ${gaps.length ? `
          <div class="gap-heat">
            ${gaps.slice(0, 10).map((gap, index) => {
              const max = Math.max(1, ...gaps.map((item) => Number(item.count ?? 1)));
              const width = Math.max(8, Math.round((Number(gap.count ?? 0) / max) * 100));
              return `
                <div class="bar-row">
                  <span class="bar-name">${index + 1}. ${escapeHtml(gap.term)}</span>
                  <span class="bar-track"><span class="bar-fill" style="width:${width}%"></span></span>
                  <span class="bar-value">${gap.count}</span>
                </div>
              `;
            }).join('')}
          </div>
        ` : ''}
        <div class="data-table-wrap">
          <table class="data-table">
            <thead><tr><th>缺口</th><th>类型</th><th>来源</th><th>热度</th><th>最近出现</th><th>状态</th><th></th></tr></thead>
            <tbody>
              ${gaps.map((gap) => `
                <tr>
                  <td><span class="table-cell-clamp"><strong>${escapeHtml(gap.term)}</strong></span></td>
                  <td><span class="tag tag-blue">${escapeHtml(gap.kind)}</span></td>
                  <td>${escapeHtml(gap.source)}</td>
                  <td>${gap.count}</td>
                  <td>${escapeHtml(formatDate(gap.lastSeen))}</td>
                  <td><span class="tag ${gap.resolved ? 'tag-teal' : gap.dismissed ? 'tag-amber' : 'tag-red'}">${gap.resolved ? '已解决' : gap.dismissed ? '已忽略' : '待处理'}</span></td>
                  <td>
                    <button class="btn btn-quiet btn-small" data-gap-action="resolve" data-gap-id="${gap.id}" type="button">解决</button>
                    <button class="btn btn-quiet btn-small" data-gap-action="dismiss" data-gap-id="${gap.id}" type="button">忽略</button>
                  </td>
                </tr>
              `).join('') || '<tr><td colspan="7">暂无知识缺口</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
      <section class="section-band">
        <div class="section-head"><div><h2>用户反馈</h2><p>负面反馈会作为后续语义规划和提示词的纠错样例。</p></div></div>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead><tr><th>时间</th><th>用户</th><th>主题</th><th>问题</th><th>结果</th><th>说明</th></tr></thead>
            <tbody>
              ${feedback.map((item) => `
                <tr>
                  <td>${escapeHtml(formatDate(item.createdAt))}</td>
                  <td>${escapeHtml(item.userName || '-')}</td>
                  <td>${escapeHtml(item.themeName || '-')}</td>
                  <td><span class="table-cell-clamp">${escapeHtml(item.question || '-')}</span></td>
                  <td><span class="tag ${item.correct ? 'tag-teal' : 'tag-red'}">${item.correct ? '正确' : '需纠正'}</span></td>
                  <td><span class="table-cell-clamp">${escapeHtml(item.comment || '-')}</span></td>
                </tr>
              `).join('') || '<tr><td colspan="6">暂无用户反馈</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
      <section class="section-band">
        <div class="section-head"><div><h2>LLM 调用审计</h2><p>统计 ${llm.stats?.total ?? 0} 次调用，平均延迟 ${formatDurationSeconds(llm.stats?.avgLatencyMs ?? 0)}。</p></div></div>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead><tr><th>时间</th><th>类型</th><th>模型</th><th>延迟</th><th>状态</th><th>Prompt 摘要</th><th>错误</th></tr></thead>
            <tbody>
              ${(llm.items ?? []).map((item) => `
                <tr>
                  <td>${escapeHtml(formatDate(item.createdAt))}</td>
                  <td><span class="tag tag-blue">${escapeHtml(item.callType)}</span></td>
                  <td>${escapeHtml(item.model || '-')}</td>
                  <td>${formatDurationSeconds(item.latencyMs)}</td>
                  <td><span class="tag ${item.success ? 'tag-teal' : 'tag-red'}">${item.success ? '成功' : '失败'}</span></td>
                  <td class="mono" title="${escapeAttr(item.promptDigest || '-')}">
                    <span class="table-cell-clamp">${escapeHtml(item.promptDigest || '-')}</span>
                  </td>
                  <td><span class="table-cell-clamp">${escapeHtml(item.errorMessage || '-')}</span></td>
                </tr>
              `).join('') || '<tr><td colspan="7">暂无 LLM 调用记录</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;
  document.getElementById('refreshGrowthBtn').addEventListener('click', renderPage);
  root.querySelectorAll('[data-gap-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      setBusy(button, true);
      try {
        await api(`/api/knowledge-gaps/${button.dataset.gapId}/${button.dataset.gapAction}`, {
          method: 'POST',
          body: JSON.stringify({ note: '质量运营页面人工处理' }),
        });
        toast('知识缺口状态已更新');
        renderPage();
      } catch (error) {
        toast(error.message, 'error');
        setBusy(button, false);
      }
    });
  });
}



export {
  renderGrowthPage,
};
