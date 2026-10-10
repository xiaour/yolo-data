export function openLocalIndicatorEditor({
  indicator = null,
  api,
  toast,
  openModal,
  closeModal,
  setBusy,
  escapeHtml,
  escapeAttr,
  loadBootstrap,
  renderPage,
  state,
}) {
  const isEdit = Boolean(indicator);
  const modal = openModal({
    title: isEdit ? '编辑本地指标' : '新增本地指标',
    wide: true,
    body: `
      <div class="form-grid">
        <div class="form-field"><label>指标名称</label><input class="field" id="localIndicatorName" value="${escapeAttr(indicator?.name ?? '')}" /></div>
        <div class="form-field"><label>指标标识</label><input class="field mono" id="localIndicatorBizName" value="${escapeAttr(indicator?.bizName ?? '')}" /></div>
        <div class="form-field"><label>指标类型</label><input class="field" id="localIndicatorTypeName" value="${escapeAttr(indicator?.typeName ?? '')}" placeholder="例如：经营指标" /></div>
        <div class="form-field">
          <label>指标层级</label>
          <select class="select" id="localIndicatorLevel">
            ${['ATOMIC', 'DERIVED'].map((level) => `<option value="${level}"${String(indicator?.indicatorLevel ?? 'ATOMIC').toUpperCase() === level ? ' selected' : ''}>${level === 'DERIVED' ? '派生指标' : '原子指标'}</option>`).join('')}
          </select>
        </div>
        <div class="form-field"><label>负责人</label><input class="field" id="localIndicatorOwner" value="${escapeAttr(indicator?.owner ?? '')}" /></div>
        <div class="form-field"><label>部门</label><input class="field" id="localIndicatorDepartment" value="${escapeAttr(indicator?.department ?? '')}" /></div>
        <div class="form-field span-2"><label>业务口径</label><textarea class="textarea" id="localIndicatorCaliber">${escapeHtml(indicator?.businessCaliber ?? '')}</textarea></div>
        <div class="form-field span-2"><label>指标说明</label><textarea class="textarea" id="localIndicatorDescription">${escapeHtml(indicator?.description ?? '')}</textarea></div>
        <div class="form-field span-2"><label class="inline-check"><input type="checkbox" id="localIndicatorStatus"${indicator?.status !== 0 ? ' checked' : ''} /><span>启用指标</span></label></div>
      </div>
    `,
    footer: `
      <button class="btn" type="button" data-close-modal>取消</button>
      <button class="btn btn-primary" type="button" id="saveLocalIndicatorBtn">${isEdit ? '保存修改' : '新增指标'}</button>
    `,
  });
  modal.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', closeModal);
  });
  modal.querySelector('#saveLocalIndicatorBtn').addEventListener('click', async (event) => {
    setBusy(event.currentTarget, true, '保存中');
    try {
      const typeName = modal.querySelector('#localIndicatorTypeName').value.trim();
      const payload = {
        name: modal.querySelector('#localIndicatorName').value.trim(),
        bizName: modal.querySelector('#localIndicatorBizName').value.trim(),
        typeId: typeName,
        typeName: typeName || '通用指标',
        indicatorLevel: modal.querySelector('#localIndicatorLevel').value,
        owner: modal.querySelector('#localIndicatorOwner').value.trim(),
        department: modal.querySelector('#localIndicatorDepartment').value.trim(),
        businessCaliber: modal.querySelector('#localIndicatorCaliber').value.trim(),
        description: modal.querySelector('#localIndicatorDescription').value.trim(),
        status: modal.querySelector('#localIndicatorStatus').checked ? 1 : 0,
      };
      await api(isEdit ? `/api/local-indicators/${encodeURIComponent(indicator.id)}` : '/api/local-indicators', {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      toast(isEdit ? '本地指标已更新' : '本地指标已新增');
      closeModal();
      await loadBootstrap(state.currentUser.id);
      renderPage();
    } catch (error) {
      toast(error.message, 'error');
      setBusy(event.currentTarget, false);
    }
  });
}

export function bindLocalIndicatorRows({
  root = document,
  state,
  api,
  toast,
  openModal,
  closeModal,
  setBusy,
  escapeHtml,
  escapeAttr,
  loadBootstrap,
  renderPage,
}) {
  root.querySelectorAll('[data-indicator-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const indicator = state.indicators.find(
        (item) => String(item.id) === String(button.dataset.indicatorEdit),
      );
      if (!indicator) {
        return;
      }
      openLocalIndicatorEditor({
        indicator,
        api,
        toast,
        openModal,
        closeModal,
        setBusy,
        escapeHtml,
        escapeAttr,
        loadBootstrap,
        renderPage,
        state,
      });
    });
  });
  root.querySelectorAll('[data-indicator-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm('确认删除该本地指标？')) {
        return;
      }
      setBusy(button, true, '删除中');
      try {
        await api(`/api/local-indicators/${encodeURIComponent(button.dataset.indicatorDelete)}`, {
          method: 'DELETE',
        });
        toast('本地指标已删除');
        await loadBootstrap(state.currentUser.id);
        renderPage();
      } catch (error) {
        toast(error.message, 'error');
        setBusy(button, false);
      }
    });
  });
}
