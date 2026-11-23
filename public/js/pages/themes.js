import * as core from '../core/runtime.js';
import { bindThemeStatusToggles } from '../components/themeStatus.js';
import { ASSET_TABS, bindSectionTabs, sectionTabsMarkup } from '../components/sectionTabs.js';
import {
  isAdminUser,
  managedThemes,
  renderThemeTable,
} from '../components/themeCards.js';

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
  persistPreferences,
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


async function renderThemesPage(root) {
  const canManage = isAdminUser();
  root.innerHTML = `
    <div class="page-stack">
      ${canManage ? sectionTabsMarkup(ASSET_TABS, 'themes', '智能体与模型管理') : ''}
      <div class="page-toolbar">
        <div class="section-head">
          <div>
            <h2>智能体</h2>
            <p>${canManage ? '每个智能体独立限定指标范围、分析维度和策略。' : '这里列出你已授权的智能体，点击可进入问数。'}</p>
          </div>
          ${canManage ? `<button class="btn btn-primary" id="addThemeBtn" type="button">${icon('plus', '新建智能体')}新建智能体</button>` : ''}
        </div>
      </div>
      <div>
        ${renderThemeTable()}
      </div>
    </div>
  `;
  bindSectionTabs(root, navigate);
  root.querySelectorAll('[data-theme-query]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedThemeId = Number(button.dataset.themeQuery);
      state.activeSessionId = null;
      state.chatMessages = [];
      state.chatStream = null;
      persistPreferences({ selectedThemeId: state.selectedThemeId });
      navigate('/');
    });
  });
  if (!canManage) {
    return;
  }
  document.getElementById('addThemeBtn').addEventListener('click', () => openThemeEditor(null));
  root.querySelectorAll('[data-theme-edit]').forEach((button) => {
    button.addEventListener('click', () => openThemeEditor(
      managedThemes().find((theme) => Number(theme.id) === Number(button.dataset.themeEdit)),
    ));
  });
  bindThemeStatusToggles(root);
  root.querySelectorAll('[data-theme-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      const theme = getTheme(button.dataset.themeDelete);
      if (!window.confirm(`确认删除主题「${theme?.name ?? ''}」？`)) {
        return;
      }
      try {
        await api(`/api/themes/${button.dataset.themeDelete}`, { method: 'DELETE' });
        toast('主题已删除');
        await loadBootstrap(state.currentUser.id);
        renderPage();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
}

function openThemeEditor(theme) {
  navigate(theme ? `/themes/${theme.id}` : '/themes/new');
}




export {
  renderThemesPage,
  renderThemeTable,
  openThemeEditor,
};
export { renderThemeEditorPage } from './themeEditor.js';
