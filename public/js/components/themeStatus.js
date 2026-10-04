// 主题启用状态开关：列表卡片与编辑器顶部开关共用同一套即时切换逻辑。
// 停用后的主题仍保留在管理端（便于重新启用），但会退出问数链路。

import * as core from '../core/runtime.js';

const {
  api,
  toast,
  setBusy,
  state,
  loadBootstrap,
  renderPage,
} = core;

function bindThemeStatusToggles(root) {
  root.querySelectorAll('[data-theme-status-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      const nextStatus = button.dataset.themeStatus === '1' ? 0 : 1;
      setBusy(button, true);
      try {
        await api(`/api/themes/${button.dataset.themeStatusToggle}/status`, {
          method: 'PUT',
          body: JSON.stringify({ status: nextStatus }),
        });
        toast(nextStatus === 1 ? '主题已启用' : '主题已停用');
        await loadBootstrap(state.currentUser.id);
        renderPage();
      } catch (error) {
        toast(error.message, 'error');
        setBusy(button, false);
      }
    });
  });
}

// 编辑器顶部开关：点击即调用状态接口，属真实启用/停用，不需要先保存表单。
function mountThemeStatusBadge(modal) {
  const badge = modal.querySelector('#themeStatusBadge');
  const themeId = badge?.dataset.themeStatusToggle;
  if (!badge || !themeId) {
    return;
  }
  const paint = (enabled) => {
    badge.dataset.themeStatus = enabled ? '1' : '0';
    badge.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    badge.textContent = enabled ? '已启用' : '已停用';
    badge.classList.toggle('tag-teal', enabled);
    badge.classList.toggle('tag-red', !enabled);
    badge.title = enabled ? '点击停用该智能体' : '点击启用该智能体';
    const theme = (state.managedThemes ?? state.themes ?? [])
      .find((item) => Number(item.id) === Number(themeId));
    if (theme) {
      theme.status = enabled ? 1 : 0;
    }
  };
  paint(badge.dataset.themeStatus !== '0');
  badge.addEventListener('click', async () => {
    const nextStatus = badge.dataset.themeStatus === '1' ? 0 : 1;
    setBusy(badge, true, '切换中');
    try {
      await api(`/api/themes/${themeId}/status`, {
        method: 'PUT',
        body: JSON.stringify({ status: nextStatus }),
      });
    } catch (error) {
      toast(error.message, 'error');
      setBusy(badge, false);
      return;
    }
    setBusy(badge, false);
    paint(nextStatus === 1);
    toast(nextStatus === 1 ? '智能体已启用' : '智能体已停用');
    // 刷新内存态，但不重绘页面，避免丢掉表单里未保存的其它编辑。
    await loadBootstrap(state.currentUser.id);
  });
}

export { bindThemeStatusToggles, mountThemeStatusBadge };
