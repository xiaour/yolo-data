export function openIndicatorDetail({
  indicator,
  detail,
  openModal,
  escapeHtml,
}) {
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
}

export function openIndicatorManager({
  indicator,
  themes,
  api,
  toast,
  openModal,
  closeModal,
  setBusy,
  escapeHtml,
  loadBootstrap,
  renderPage,
  state,
}) {
  const selectedThemeIds = new Set(
    themes
      .filter((theme) => (theme.indicatorIds ?? []).map(String).includes(String(indicator.id)))
      .map((theme) => String(theme.id)),
  );
  const modal = openModal({
    title: '指标管理',
    wide: true,
    body: `
      <div class="indicator-manage-head">
        <div><strong>${escapeHtml(indicator.name)}</strong><small class="mono">${escapeHtml(indicator.bizName ?? indicator.id)}</small></div>
        <span class="tag tag-blue">${escapeHtml(indicator.typeName ?? indicator.indicatorLevel ?? '指标')}</span>
      </div>
      <div class="form-field" style="margin-top:16px">
        <label>挂载主题</label>
        <div class="check-grid">
          ${themes.map((theme) => `
            <label class="check-item">
              <input type="checkbox" name="indicatorTheme" value="${theme.id}"${selectedThemeIds.has(String(theme.id)) ? ' checked' : ''} />
              <span><strong>${escapeHtml(theme.name)}</strong><small>${escapeHtml(theme.description || '')}</small></span>
            </label>
          `).join('') || '<div class="muted">暂无可用主题</div>'}
        </div>
      </div>
      <p class="muted" style="margin:14px 0 0">这里只管理指标与主题的挂载关系；指标定义在本地指标管理中维护。</p>
    `,
    footer: `
      <button class="btn" type="button" data-close-modal>取消</button>
      <button class="btn btn-primary" type="button" id="saveIndicatorManagerBtn">保存挂载关系</button>
    `,
  });
  modal.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', closeModal);
  });
  modal.querySelector('#saveIndicatorManagerBtn').addEventListener('click', async (event) => {
    setBusy(event.currentTarget, true, '保存中');
    try {
      const selected = new Set(
        [...modal.querySelectorAll('[name="indicatorTheme"]:checked')]
          .map((input) => String(input.value)),
      );
      await Promise.all(themes.map((theme) => {
        const indicatorIds = new Set((theme.indicatorIds ?? []).map(String));
        if (selected.has(String(theme.id))) {
          indicatorIds.add(String(indicator.id));
        } else {
          indicatorIds.delete(String(indicator.id));
        }
        return api(`/api/themes/${theme.id}`, {
          method: 'PUT',
          body: JSON.stringify({ indicatorIds: [...indicatorIds] }),
        });
      }));
      toast('指标挂载关系已更新');
      closeModal();
      await loadBootstrap(state.currentUser.id);
      renderPage();
    } catch (error) {
      toast(error.message, 'error');
      setBusy(event.currentTarget, false);
    }
  });
}

export function bindIndicatorManagerRows({
  root = document,
  state,
  api,
  toast,
  openModal,
  closeModal,
  setBusy,
  escapeHtml,
  loadBootstrap,
  renderPage,
}) {
  root.querySelectorAll('[data-indicator-manage]').forEach((button) => {
    button.addEventListener('click', () => {
      const indicator = state.indicators.find(
        (item) => String(item.id) === String(button.dataset.indicatorManage),
      );
      if (!indicator) {
        return;
      }
      openIndicatorManager({
        indicator,
        themes: state.themes,
        api,
        toast,
        openModal,
        closeModal,
        setBusy,
        escapeHtml,
        loadBootstrap,
        renderPage,
        state,
      });
    });
  });
}
