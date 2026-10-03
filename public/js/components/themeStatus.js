// 主题启用状态开关：列表卡片与编辑器顶部标识共用同一套切换逻辑。
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

function mountThemeStatusBadge(modal) {
  const select = modal.querySelector('#themeStatus');
  const badge = modal.querySelector('#themeStatusBadge');
  const sync = () => {
    const enabled = select.value !== '0';
    badge.textContent = enabled ? '已启用' : '已停用';
    badge.classList.toggle('tag-teal', enabled);
    badge.classList.toggle('tag-red', !enabled);
    badge.dataset.themeStatus = enabled ? '1' : '0';
    badge.title = enabled ? '点击停用（保存后生效）' : '点击启用（保存后生效）';
  };
  select.addEventListener('change', sync);
  badge.addEventListener('click', () => {
    select.value = select.value === '0' ? '1' : '0';
    sync();
  });
  sync();
}

export { bindThemeStatusToggles, mountThemeStatusBadge };
