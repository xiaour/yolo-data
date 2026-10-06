// 侧栏合并入口在页内使用的标签条。
// 现在服务两组入口：帮助中心（使用引导 / 帮助中心）、智能体（智能体 / 模型管理）。
// 组件保持零依赖：只产出标记并绑定跳转回调，navigate 由页面模块传入。

export const HELP_TABS = [
  { id: 'guide', route: '/guide', label: '使用引导' },
  { id: 'help', route: '/help', label: '帮助中心' },
];

export const ASSET_TABS = [
  { id: 'themes', route: '/themes', label: '智能体' },
  { id: 'models', route: '/models', label: '模型管理' },
];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

export function sectionTabsMarkup(tabs, activeId, label = '页面切换') {
  return `
    <div class="section-tabs" role="tablist" aria-label="${escapeHtml(label)}">
      ${tabs.map((tab) => `
        <button type="button" role="tab" data-section-tab="${escapeHtml(tab.id)}"
          data-route="${escapeHtml(tab.route)}" aria-selected="${tab.id === activeId}">${escapeHtml(tab.label)}</button>
      `).join('')}
    </div>
  `;
}

// onActiveTab 用于「已在当前页签时再点一次」的回到本级首页（例如文章页回帮助中心首页）。
export function bindSectionTabs(root, navigate, { onActiveTab } = {}) {
  const container = root.querySelector('.section-tabs');
  if (!container || typeof navigate !== 'function') {
    return;
  }
  container.addEventListener('click', (event) => {
    const button = event.target.closest('[data-section-tab]');
    if (!button) {
      return;
    }
    if (button.getAttribute('aria-selected') === 'true') {
      onActiveTab?.(button.dataset.sectionTab);
      return;
    }
    if (button.dataset.route) {
      navigate(button.dataset.route);
    }
  });
}
