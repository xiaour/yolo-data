import { ICONS } from './icons.js';
import { renderSafeMarkdown } from '../../markdown.js';
import { visibleExecutionStages } from '../../executionDetails.js';
import {
  mountAuthGate,
  notifyUnauthorized,
  readSession,
  renderUserSelect,
  setReplayGuideHandler, setOpenMemoryHandler,
  showLogin,
} from '../components/authGate.js';


const PAGE_META = {
  query: ['开始问数', '面向业务主题的自然语言指标查询'],
  indicators: ['指标管理', '管理指标快照、主题挂载关系和在线指标口径'],
  models: ['模型管理', '统一管理模型连接、运行参数和平台默认模型'],
  themes: ['智能体', '按业务主题限定指标范围、维度和回答策略'],
  skills: ['公共 Skills', '管理平台级 Skill 资产池：查看来源与引用、启停公共 Skill、上传新 Skill'],
  mcp: ['MCP 令牌', '开放 MCP 能力给外部客户端：服务开关、访问令牌与连接器下载'],
  eval: ['评测看板', 'L1/L2/L3 语义评测的可量化准确率、门禁分布与回归 diff'],
  themeEditor: ['编辑智能体', '配置主题的数据范围、运行模型、Skills 和独立提示词'],
  datasets: ['数据集', '管理数据源、业务数据集和字段语义'],
  permissions: ['数据权限', '配置用户可见主题、指标、行级过滤和列级脱敏'],
  growth: ['质量运营', '跟踪用户反馈、知识缺口与 LLM 调用质量'],
  audit: ['运行审计', '跟踪指标连接、权限变更、智能问数执行和数据集查询记录'],
  settings: ['系统设置', '配置指标平台模块和平台运行策略'], memory: ['记忆管理', '查看与维护用户沉淀的长期记忆'],
  guide: ['使用引导', '按角色完成关键动作，从登录到第一次自主问数'], help: ['帮助中心', '搜索问题，或按角色浏览文档'],
};

const state = {
  page: 'query',
  bootstrap: null,
  currentUser: null,
  allUsers: [],
  themes: [],
  managedThemes: [],
  skills: [],
  datasetOptions: [],
  businessDatasets: [],
  dataSources: [],
  models: [],
  preferences: {},
  datasetTab: 'datasets',
  auditTab: 'platform',
  memoryUserId: null,
  memoryScope: 'self',
  selectedThemeId: null, indicatorThemeId: '',
  selectedModelId: null,
  indicators: [],
  indicatorTypes: [],
  chatSessions: [],
  activeSessionId: null,
  chatMessages: [],
  chatLoading: false,
  chatStream: null,
  chatAbortController: null,
  chatLoaded: false,
  chatDensity: 'detailed',
  openingSuggestions: null,
  workspaceDrawerOpen: false,
  workspace: null,
  workspaceArtifacts: [],
  permissionUserId: null,
  permissionProfile: null,
  permissionLoading: false,
  themeEditorThemeId: null,
  chatChartInstances: new Map(),
};

function icon(name, label = '') {
  return `<span class="icon" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><svg viewBox="0 0 24 24">${ICONS[name] ?? ICONS['circle-alert']}</svg></span>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((element) => {
    element.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[element.dataset.icon] ?? ICONS['circle-alert']}</svg>`;
  });
}

const customSelectRegistry = new WeakMap();

function optionText(option) {
  return String(option?.textContent ?? option?.value ?? '').trim();
}

function customSelectParts(wrapper) {
  return wrapper?.__customSelectParts ?? null;
}

function closeCustomSelects(except = null) {
  document.querySelectorAll('.ui-select-menu').forEach((menu) => {
    if (menu.__ownerWrapper && !menu.__ownerWrapper.isConnected) {
      menu.remove();
    }
  });
  document.querySelectorAll('.ui-select.is-open').forEach((wrapper) => {
    if (wrapper !== except) {
      wrapper.classList.remove('is-open');
      const parts = customSelectParts(wrapper);
      parts?.trigger?.setAttribute('aria-expanded', 'false');
      parts?.menu?.classList.remove('is-open');
      if (parts?.menu && !wrapper.isConnected) {
        parts.menu.remove();
      }
    }
  });
}

function positionCustomSelectMenu(wrapper) {
  const parts = customSelectParts(wrapper);
  const { trigger, menu } = parts ?? {};
  if (!trigger || !menu) {
    return;
  }
  const rect = trigger.getBoundingClientRect();
  const menuWidth = wrapper.classList.contains('is-icon-only')
    ? Math.max(220, menu.scrollWidth)
    : Math.max(rect.width, menu.scrollWidth, 180);
  const spaceBelow = window.innerHeight - rect.bottom - 10;
  const openUp = spaceBelow < Math.min(menu.scrollHeight, 280) && rect.top > spaceBelow;
  menu.style.width = `${menuWidth}px`;
  if (wrapper.classList.contains('is-icon-only')) {
    menu.style.left = `${Math.max(8, rect.right - menuWidth)}px`;
  } else {
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8))}px`;
  }
  if (openUp) {
    menu.style.top = 'auto';
    menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    menu.classList.add('is-drop-up');
  } else {
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.bottom = 'auto';
    menu.classList.remove('is-drop-up');
  }
}

function rebuildCustomSelectMenu(select, wrapper) {
  const { menu } = customSelectParts(wrapper) ?? {};
  if (!menu) {
    return;
  }
  menu.replaceChildren();
  for (const option of select.options) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'ui-select-option';
    item.dataset.value = option.value;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', option.selected ? 'true' : 'false');
    item.disabled = option.disabled;

    const label = document.createElement('span');
    label.className = 'ui-select-option-label';
    label.textContent = optionText(option);
    const check = document.createElement('span');
    check.className = 'ui-select-check';
    check.innerHTML = '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>';
    item.append(label, check);
    item.addEventListener('click', () => {
      if (option.disabled) {
        return;
      }
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncCustomSelect(select, wrapper);
      closeCustomSelects();
      wrapper.querySelector('.ui-select-trigger')?.focus();
    });
    menu.append(item);
  }
}

function syncCustomSelect(select, wrapper) {
  const parts = customSelectParts(wrapper);
  const { trigger, label, menu } = parts ?? {};
  if (!trigger || !menu) {
    return;
  }
  const selected = select.selectedOptions?.[0] ?? select.options[select.selectedIndex];
  if (label) {
    label.textContent = optionText(selected) || '请选择';
  }
  trigger.disabled = Boolean(select.disabled);
  wrapper.classList.toggle('is-disabled', Boolean(select.disabled));
  menu.querySelectorAll('.ui-select-option').forEach((item) => {
    const isSelected = item.dataset.value === select.value;
    item.classList.toggle('is-selected', isSelected);
    item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
  });
}

function enhanceCustomSelect(select) {
  if (
    !(select instanceof HTMLSelectElement)
    || customSelectRegistry.has(select)
    || select.closest('.ui-select')
  ) {
    return;
  }
  const wrapper = document.createElement('span');
  wrapper.className = 'ui-select';
  if (select.closest('.topbar-icon-btn')) {
    wrapper.classList.add('is-icon-only');
  }
  select.parentNode.insertBefore(wrapper, select);
  wrapper.append(select);
  select.classList.add('ui-select-native');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'ui-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span');
  label.className = 'ui-select-label';
  const chevron = document.createElement('span');
  chevron.className = 'ui-select-chevron';
  chevron.innerHTML = icon('chevron-down');
  trigger.append(label, chevron);

  const menu = document.createElement('div');
  menu.className = 'ui-select-menu';
  if (wrapper.classList.contains('is-icon-only')) {
    menu.classList.add('is-icon-only');
  }
  if (select.closest('.theme-breadcrumb')) {
    menu.classList.add('is-theme-menu');
  }
  menu.setAttribute('role', 'listbox');
  wrapper.append(trigger);
  document.body.append(menu);
  menu.__ownerWrapper = wrapper;
  wrapper.__customSelectParts = { trigger, label, menu };

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    const opening = !wrapper.classList.contains('is-open');
    closeCustomSelects(wrapper);
    wrapper.classList.toggle('is-open', opening);
    menu.classList.toggle('is-open', opening);
    trigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
    if (opening) {
      rebuildCustomSelectMenu(select, wrapper);
      syncCustomSelect(select, wrapper);
      requestAnimationFrame(() => positionCustomSelectMenu(wrapper));
    }
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeCustomSelects();
    }
  });
  select.addEventListener('change', () => syncCustomSelect(select, wrapper));
  new MutationObserver(() => syncCustomSelect(select, wrapper)).observe(select, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled'],
  });

  customSelectRegistry.set(select, wrapper);
  syncCustomSelect(select, wrapper);
}

function enhanceCustomSelects(root = document) {
  if (root instanceof HTMLSelectElement) {
    enhanceCustomSelect(root);
  }
  root.querySelectorAll?.('select').forEach(enhanceCustomSelect);
}

document.addEventListener('click', () => closeCustomSelects());
window.addEventListener('resize', () => closeCustomSelects());
window.addEventListener('scroll', () => closeCustomSelects(), true);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('\n', ' ');
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return value ?? '-';
  }
  return number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function formatPresentationText(value, column) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return '-';
  }
  const decimals = Number.isInteger(column?.displayDecimals)
    ? column.displayDecimals
    : 2;
  const text = number.toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const prefix = String(column?.prefix ?? '');
  const suffix = String(column?.suffix ?? '');
  if (column?.presentationType === 'percent') {
    return `${prefix}${text}%${suffix && suffix !== '%' ? suffix : ''}`;
  }
  return `${prefix}${text}${suffix}`;
}

function formatPresentationCell(value, column) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return '-';
  }
  const scaled = number * (Number(column?.displayScale) || 1);
  return formatPresentationText(scaled, column);
}

function presentationChartValue(value, column) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return column?.presentationType
    ? number * (Number(column?.displayScale) || 1)
    : number;
}

function formatDurationSeconds(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) {
    return '-';
  }
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds === 0) {
    return '<0.001 秒';
  }
  if (seconds < 1) {
    return `${seconds.toFixed(3)} 秒`;
  }
  if (seconds < 10) {
    return `${seconds.toFixed(2)} 秒`;
  }
  return `${seconds.toFixed(1)} 秒`;
}

function formatDate(value) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatTemporalValue(value, timeGrain) {
  const text = String(value ?? '');
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (!match) {
    return text;
  }
  const [, year, month, day] = match;
  switch (String(timeGrain ?? '').toUpperCase()) {
    case 'MONTH':
      return `${year}-${month}`;
    case 'QUARTER':
      return `${year}-Q${Math.floor((Number(month) - 1) / 3) + 1}`;
    case 'YEAR':
      return year;
    case 'WEEK': {
      const date = new Date(`${text}T00:00:00Z`);
      const weekday = date.getUTCDay() || 7;
      date.setUTCDate(date.getUTCDate() + 4 - weekday);
      const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
      const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
      return `${year}-W${String(week).padStart(2, '0')}`;
    }
    default:
      return text;
  }
}

function isTemporalColumn(column) {
  const showType = String(column?.showType ?? '').toUpperCase();
  return showType === 'DATE'
    || showType === 'TIME'
    || /日期|时间|月份|月度|年份|年度|季度|周次/.test(String(column?.name ?? ''));
}

function formatSessionTime(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${
      String(date.getMinutes()).padStart(2, '0')
    }`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return '昨天';
  }
  const monthDay = `${String(date.getMonth() + 1).padStart(2, '0')}-${
    String(date.getDate()).padStart(2, '0')
  }`;
  return date.getFullYear() === now.getFullYear()
    ? monthDay
    : `${date.getFullYear()}-${monthDay}`;
}

function initials(name) {
  const text = String(name ?? '?').trim();
  return text.slice(0, 1).toUpperCase();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { message: text };
  }
  if (!response.ok) {
    if (response.status === 401) {
      notifyUnauthorized();
    }
    throw new Error(payload?.message ?? `请求失败（${response.status}）`);
  }
  return payload;
}

let preferenceSaveTimer = null;

function persistPreferences(patch = {}) {
  state.preferences = {
    ...(state.preferences ?? {}),
    ...patch,
  };
  if (preferenceSaveTimer) {
    clearTimeout(preferenceSaveTimer);
  }
  preferenceSaveTimer = setTimeout(() => {
    api('/api/preferences', {
      method: 'PUT',
      body: JSON.stringify(state.preferences),
    }).catch(() => {});
  }, 120);
}

async function streamApi(path, options = {}, onEvent) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    if (response.status === 401) {
      notifyUnauthorized();
    }
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { message: text };
    }
    throw new Error(payload?.message ?? `请求失败（${response.status}）`);
  }
  if (!response.body) {
    throw new Error('当前浏览器不支持流式响应');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalAnswer = null;
  const consumeLine = (line) => {
    const text = line.trim();
    if (!text) {
      return;
    }
    const event = JSON.parse(text);
    if (event.type === 'stream_error') {
      const error = new Error(event.message ?? 'query failed');
      error.code = event.code ?? null;
      error.statusCode = event.statusCode ?? null;
      error.providerStatus = event.providerStatus ?? null;
      error.providerDetail = event.providerDetail ?? null;
      error.recovery = event.recovery ?? null;
      onEvent?.(event);
      throw error;
    }
    if (event.type === 'final') {
      finalAnswer = event.answer;
      return;
    }
    if (event.type !== 'stream_done') {
      onEvent?.(event);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      consumeLine(line);
    }
    if (done) {
      break;
    }
  }
  if (buffer.trim()) {
    consumeLine(buffer);
  }
  if (!finalAnswer) {
    throw new Error('流式响应未返回最终结果');
  }
  return finalAnswer;
}

function toast(message, type = 'success') {
  const stack = document.getElementById('toastStack');
  const element = document.createElement('div');
  element.className = `toast${type === 'error' ? ' is-error' : ''}`;
  element.textContent = message;
  stack.appendChild(element);
  setTimeout(() => element.remove(), 3200);
}

function openModal({ title, body, footer = '', wide = false, editor = false }) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <section class="modal${wide ? ' is-wide' : ''}${editor ? ' is-editor' : ''}" role="dialog" aria-modal="true">
        <header class="modal-head">
          <h2>${escapeHtml(title)}</h2>
          <button class="btn btn-quiet btn-icon" type="button" data-close-modal aria-label="关闭">
            ${icon('x', '关闭')}
          </button>
        </header>
        <div class="modal-body">${body}</div>
        ${footer ? `<footer class="modal-foot">${footer}</footer>` : ''}
      </section>
    </div>
  `;
  root.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', closeModal);
  });
  root.querySelector('[data-modal-backdrop]').addEventListener('click', (event) => {
    if (event.target.dataset.modalBackdrop !== undefined) {
      closeModal();
    }
  });
  return root.querySelector('.modal');
}

function closeModal() {
  document.getElementById('modalRoot').innerHTML = '';
}

function setBusy(button, busy, label = '处理中') {
  if (!button) {
    return;
  }
  if (busy) {
    button.dataset.original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span>${escapeHtml(label)}`;
  } else {
    button.disabled = false;
    button.innerHTML = button.dataset.original ?? button.innerHTML;
  }
}

function getUserDisplay(userId) {
  return state.allUsers.find((user) => Number(user.id) === Number(userId))
    ?? state.bootstrap?.users?.find((user) => Number(user.id) === Number(userId));
}

function getTheme(themeId = state.selectedThemeId) {
  const managed = state.managedThemes?.length ? state.managedThemes : state.themes;
  return managed.find((theme) => Number(theme.id) === Number(themeId));
}

// 普通分析员只保留「开始问数」和只读的「智能体」，其余管理面直接不展示。
function applyRoleVisibility() {
  const admin = String(state.currentUser?.role ?? '').toUpperCase() === 'ADMIN';
  document.getElementById('mainNav').dataset.role = admin ? 'ADMIN' : 'ANALYST';
  const page = state.page === 'themeEditor' ? 'themes' : state.page;
  if (!admin && !['query', 'themes', 'guide', 'help'].includes(page)) {
    navigate('/', { replace: true });
  }
}

function hideThemeBreadcrumb() {
  const container = document.getElementById('themeBreadcrumb');
  const select = document.getElementById('themeSelect');
  if (container) {
    container.hidden = true;
  }
  if (select) {
    select.onchange = null;
  }
}

function syncThemeBreadcrumb() {
  const container = document.getElementById('themeBreadcrumb');
  const select = document.getElementById('themeSelect');
  if (!container || !select || state.page !== 'query') {
    hideThemeBreadcrumb();
    return;
  }
  if (state.themes.length === 0) {
    hideThemeBreadcrumb();
    return;
  }
  container.hidden = false;
  select.innerHTML = state.themes.map((theme) => (
    `<option value="${theme.id}"${Number(theme.id) === Number(state.selectedThemeId) ? ' selected' : ''}>${escapeHtml(theme.name)}</option>`
  )).join('');
  select.value = String(state.selectedThemeId ?? state.themes[0].id);
  select.onchange = (event) => {
    state.selectedThemeId = Number(event.target.value);
    state.selectedModelId = null;
    state.activeSessionId = null;
    state.chatMessages = [];
    state.chatStream = null;
    persistPreferences({ selectedThemeId: state.selectedThemeId });
    queryHooks.beforeQueryReset?.();
    renderPage();
  };
  const subtitle = document.getElementById('pageSubtitle');
  if (subtitle) {
    subtitle.textContent = getTheme()?.description || PAGE_META.query[1];
  }
}

function formatModelName(runtime) {
  const model = String(runtime?.model ?? '').trim();
  if (model) {
    return model;
  }
  if (runtime?.mode === 'deepseek') {
    return 'DeepSeek';
  }
  if (runtime?.mode === 'local-rule') {
    return '本地规则';
  }
  return '模型待确认';
}

function formatSourceMode(mode) {
  if (mode === 'remote-indicator') {
    return '指标平台指标源';
  }
  if (mode === 'local-indicator-catalog') {
    return '指标平台指标查询';
  }
  if (mode === 'unconfigured') {
    return '指标平台未配置';
  }
  if (mode === 'unconfigured-indicator') {
    return '指标平台未配置';
  }
  const datasetLabel = { __proto__: null, 'doris-dataset': 'Doris', 'mysql-dataset': 'MySQL', 'tidb-dataset': 'TiDB', 'postgresql-dataset': 'PostgreSQL' }[mode];
  if (datasetLabel) return `${datasetLabel} 业务数据集`;

  return mode ? String(mode) : '指标源待确认';
}

function formatProvenance(provenance) {
  if (!provenance) {
    return null;
  }
  const mode = String(provenance.mode ?? '').toUpperCase();
  const config = {
    INDICATOR_LIBRARY: {
      label: '指标库口径',
      className: 'is-indicator',
      iconName: 'database',
    },
    DATASET_EXACT: {
      label: '数据集字段精确匹配',
      className: 'is-dataset',
      iconName: 'table',
    },
    DATASET_ALIAS: {
      label: '数据集字段语义匹配',
      className: 'is-dataset',
      iconName: 'table',
    },
    LLM_FUZZY: {
      label: '大模型模糊匹配',
      className: 'is-fuzzy',
      iconName: 'sparkles',
    },
  }[mode] ?? {
    label: provenance.label || mode || '口径来源未知',
    className: 'is-unknown',
    iconName: 'circle-alert',
  };
  return {
    ...config,
    label: String(provenance.label || config.label),
    reason: String(provenance.reason || ''),
  };
}

function renderRuntime(health) {
  const source = health?.source;
  const llm = health?.llm;
  // Distinguish "not configured yet" from "configured but unreachable" so the
  // merged status does not claim a connection error when nothing is set up.
  const directLlm = source?.mode === 'direct-llm';
  const unconfigured = !directLlm
    && (source?.mode === 'unconfigured' || source?.configured === false);
  const connectionError = !directLlm && !unconfigured && Boolean(source?.error);
  const indicatorSource = source?.indicatorSource;
  const snapshot = !directLlm && indicatorSource === 'SNAPSHOT';
  const catalogUnavailable = !directLlm && indicatorSource === 'UNAVAILABLE';
  // 集成指标管理是平台默认形态：不接外部指标平台时，指标侧由平台内置指标库承担，
  // 属于正常就绪状态，不再按"外部平台已停用"降级展示；仅库为空时提示待录入。
  const localMgmt = directLlm || source?.localIndicatorManagement === true;
  const localCount = Number(source?.localIndicatorCount ?? 0);
  const indicatorLabel = localMgmt ? '指标库' : '指标平台';
  const indicatorReady = localMgmt ? localCount > 0 : !unconfigured && !connectionError && !catalogUnavailable;
  const indicatorDetail = localMgmt
    ? (localCount > 0 ? `已录入 ${localCount} 个指标` : '暂无指标')
    : unconfigured ? '未配置'
      : connectionError ? '连接异常'
        : catalogUnavailable ? '目录不可用'
          : snapshot ? '快照模式' : '已连接';
  const themeCredentials = Number(llm?.themeCredentials ?? 0);
  const llmConfigured = Boolean(llm?.configured);
  const llmReady = llmConfigured || themeCredentials > 0;
  const llmDetail = llmConfigured
    ? `已配置 · ${llm.model}`
    : themeCredentials > 0
      ? `本地规则 · ${themeCredentials} 个主题已配置`
      : '未配置';
  // 三色状态：绿=指标侧与大模型都就绪，黄=仅一侧可用，橙=两侧都未就绪。
  // 指标平台已启用却连接异常或目录不可用时，直接标记为橙色异常。
  const indicatorBroken = !directLlm && !unconfigured && (connectionError || catalogUnavailable);
  const level = indicatorReady && llmReady
    ? 'ready'
    : indicatorBroken ? 'alert' : (indicatorReady || llmReady) ? 'warning' : 'alert';
  // 运行状态同时体现在右上角的头像状态点和账号面板里的状态行。
  const runtimeBox = document.getElementById('runtimeBox');
  const statusDot = document.getElementById('userMenuStatus');
  for (const element of [runtimeBox, statusDot]) {
    element?.classList.toggle('is-ready', level === 'ready');
    element?.classList.toggle('is-warning', level === 'warning');
    element?.classList.toggle('is-alert', level === 'alert');
  }
  document.getElementById('runtimeTitle').textContent = level === 'ready'
    ? '运行就绪'
    : level === 'warning' ? '部分就绪' : indicatorBroken ? '运行异常' : '尚未就绪';
  document.getElementById('runtimeDetail').textContent =
    `${indicatorLabel} ${indicatorDetail} · 大模型 ${llmDetail}`;
  const syncText = localMgmt
    ? (localCount > 0 ? `本地指标管理 · ${localCount} 个指标，无需外部同步` : '本地指标管理 · 尚未录入指标')
    : unconfigured
      ? '尚未配置指标平台服务地址'
      : connectionError
        ? `指标读取失败${source?.error ? `：${source.error}` : ''}`
        : source?.lastSyncAt
          ? `${source.lastSyncCount} 个指标 · 同步于 ${formatDate(source.lastSyncAt)}`
          : '尚无同步记录';
  const snapshotText = snapshot
    ? `快照时间 ${source?.indicatorSourceDetail?.freshAt ? formatDate(source.indicatorSourceDetail.freshAt) : '未知'}，可能已过期`
    : '';
  const tooltip = [
    `${indicatorLabel}：${indicatorDetail}`,
    syncText,
    snapshotText,
    `大模型：${llmDetail}`,
  ].filter(Boolean).join(' · ');
  runtimeBox?.setAttribute('title', tooltip);
  runtimeBox?.setAttribute('aria-label', tooltip);
  statusDot?.setAttribute('title', tooltip);
}

function setActivePage(page) {
  if (page !== 'themeEditor') {
    state.themeEditorThemeId = null;
  }
  state.page = page;
  document.body.classList.toggle('is-query-page', page === 'query');
  const appMain = document.getElementById('appMain');
  appMain.classList.toggle('is-chat', page === 'query');
  appMain.classList.toggle(
    'density-compact',
    page === 'query' && state.chatDensity === 'compact',
  );
  appMain.dataset.page = page;
  const densitySeg = document.getElementById('densitySeg');
  if (densitySeg) {
    densitySeg.hidden = page !== 'query';
    densitySeg.querySelectorAll('.density-option').forEach((button) => {
      button.classList.toggle(
        'is-active',
        button.dataset.density === state.chatDensity,
      );
    });
  }
  const workspaceToggle = document.getElementById('workspaceToggle');
  if (workspaceToggle) {
    workspaceToggle.hidden = page !== 'query';
  }
  // 合并入口的导航高亮：/guide 归「帮助中心」，/models、/skills 与主题编辑页归「智能体」。
  const navPageMap = { themeEditor: 'themes', models: 'themes', skills: 'themes', guide: 'help' };
  const activeNavPage = navPageMap[page] ?? page;
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('is-active', item.dataset.page === activeNavPage);
  });
  const meta = page === 'memory' && state.memoryScope !== 'all'
    ? ['我的记忆', '查看与维护你自己的长期记忆']
    : PAGE_META[page] ?? PAGE_META.themes;
  const [title, subtitle] = meta;
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('pageSubtitle').textContent = subtitle;
  renderPage();
}

async function loadBootstrap(userId) {
  const previousUserId = state.currentUser?.id;
  state.bootstrap = await api('/api/bootstrap');
  state.currentUser = state.bootstrap.currentUser;
  if (previousUserId && Number(previousUserId) !== Number(state.currentUser.id)) {
    queryHooks.beforeQueryReset?.();
    state.chatSessions = [];
    state.activeSessionId = null;
    state.chatMessages = [];
    state.chatStream = null;
    state.selectedModelId = null;
    state.chatLoaded = false;
    state.workspace = null;
    state.workspaceArtifacts = [];
  }
  state.themes = state.bootstrap.themes;
  state.managedThemes = state.bootstrap.managedThemes ?? state.themes;
  state.skills = state.bootstrap.skills ?? [];
  state.datasetOptions = state.bootstrap.datasetOptions ?? [];
  state.businessDatasets = state.bootstrap.businessDatasets ?? [];
  state.dataSources = state.bootstrap.dataSources ?? [];
  state.models = state.bootstrap.models ?? [];
  state.indicatorTypes = state.bootstrap.indicatorTypes ?? [];
  state.preferences = state.bootstrap.preferences ?? {};
  state.chatDensity = ['detailed', 'compact'].includes(state.preferences.chatDensity)
    ? state.preferences.chatDensity
    : state.chatDensity;
  state.datasetTab = ['datasets', 'sources'].includes(state.preferences.datasetTab)
    ? state.preferences.datasetTab
    : state.datasetTab;
  state.auditTab = ['platform', 'datasets'].includes(state.preferences.auditTab)
    ? state.preferences.auditTab
    : state.auditTab;
  const preferredThemeId = Number(state.preferences.selectedThemeId);
  const preferredModelId = Number(state.preferences.selectedModelId);
  state.selectedThemeId = preferredThemeId
    && state.themes.some((theme) => Number(theme.id) === preferredThemeId)
    ? preferredThemeId
    : state.themes[0]?.id ?? null;
  state.selectedModelId = preferredModelId
    && state.models.some((model) => Number(model.id) === preferredModelId)
    ? preferredModelId
    : null;
  if (state.currentUser.role === 'ADMIN' && state.allUsers.length === 0) {
    state.allUsers = await api('/api/users');
  }
  if (state.allUsers.length === 0) {
    state.allUsers = state.bootstrap.users ?? [state.currentUser];
  }
  renderRuntime(state.bootstrap.health);
  renderUserSelect(state.currentUser);
  setReplayGuideHandler(() => guideTour('replay'));
  setOpenMemoryHandler(() => {
    state.memoryUserId = null;
    navigate('/memory');
  });
  applyRoleVisibility();
}


const pageModuleSpecs = {
  query: () => import('../pages/query.js'),
  indicators: () => import('../pages/indicators.js'),
  models: () => import('../pages/models.js'),
  themes: () => import('../pages/themes.js'),
  skills: () => import('../pages/skills.js'),
  mcp: () => import('../pages/mcp.js'),
  eval: () => import('../pages/eval.js'),
  datasets: () => import('../pages/admin.js'),
  permissions: () => import('../pages/admin.js'),
  growth: () => import('../pages/growth.js'),
  audit: () => import('../pages/audit.js'),
  settings: () => import('../pages/settings.js'), memory: () => import('../pages/memory.js'),
  guide: () => import('../pages/guide.js'), help: () => import('../pages/help.js'),
};
const pageModuleCache = new Map();
const pageRenderers = {
  query: 'renderQueryPage',
  indicators: 'renderIndicatorsPage',
  models: 'renderModelsPage',
  themeEditor: 'renderThemeEditorPage',
  themes: 'renderThemesPage',
  skills: 'renderSkillsPage',
  mcp: 'renderMcpPage',
  eval: 'renderEvalPage',
  datasets: 'renderDatasetsPage',
  permissions: 'renderPermissionsPage',
  growth: 'renderGrowthPage',
  audit: 'renderAuditPage',
  settings: 'renderSettingsPage', memory: 'renderMemoryPage',
  guide: 'renderGuidePage', help: 'renderHelpPage',
};
const queryHooks = {};
const routeMatchers = [
  { pattern: /^\/$/, page: 'query' },
  { pattern: /^\/indicators$/, page: 'indicators' },
  { pattern: /^\/models$/, page: 'models' },
  { pattern: /^\/themes\/new$/, page: 'themeEditor', themeId: null },
  { pattern: /^\/themes\/(\d+)$/, page: 'themeEditor' },
  { pattern: /^\/themes$/, page: 'themes' },
  { pattern: /^\/skills$/, page: 'skills' },
  { pattern: /^\/mcp$/, page: 'mcp' },
  { pattern: /^\/eval$/, page: 'eval' },
  { pattern: /^\/datasets$/, page: 'datasets' },
  { pattern: /^\/permissions$/, page: 'permissions' },
  { pattern: /^\/growth$/, page: 'growth' },
  { pattern: /^\/audit$/, page: 'audit' },
  { pattern: /^\/settings$/, page: 'settings' },
  { pattern: /^\/memory$/, page: 'memory', memoryScope: 'self' },
  { pattern: /^\/memory\/all$/, page: 'memory', memoryScope: 'all' },
  { pattern: /^\/guide$/, page: 'guide' }, { pattern: /^\/help$/, page: 'help' },
];

export function registerQueryHooks(hooks = {}) {
  Object.assign(queryHooks, hooks);
}

function clearSidebarSessions() {
  const container = document.getElementById('sessionSidebar');
  if (!container) {
    return;
  }
  container.hidden = true;
  container.innerHTML = '';
}

function setWorkspaceDrawer(open) {
  state.workspaceDrawerOpen = Boolean(open);
  const drawer = document.getElementById('workspaceDrawer');
  document.body.classList.toggle('workspace-open', state.workspaceDrawerOpen);
  drawer.classList.toggle('is-open', state.workspaceDrawerOpen);
  drawer.setAttribute('aria-hidden', state.workspaceDrawerOpen ? 'false' : 'true');
}

function updateWorkspaceChrome() {
  const toggle = document.getElementById('workspaceToggle');
  if (!toggle) {
    return;
  }
  const visible = state.page === 'query';
  toggle.hidden = !visible;
  const artifactCount = state.workspaceArtifacts.length;
  document.getElementById('workspaceCount').textContent = String(artifactCount);
  const workspaceTooltip = state.workspace
    ? `${state.workspace.name} · ${artifactCount} 个产物`
    : '工作区产物 · 暂无产物';
  toggle.dataset.tooltip = workspaceTooltip;
  toggle.setAttribute('aria-label', workspaceTooltip);
  const subtitle = document.getElementById('workspaceSubtitle');
  subtitle.textContent = state.workspace
    ? `${state.workspaceArtifacts.length} 个产物`
    : '当前会话暂无产物';
  pageModuleCache.get('query')?.renderWorkspaceDrawer?.();
}

function routeFromPath(pathname = window.location.pathname) {
  for (const matcher of routeMatchers) {
    const match = pathname.match(matcher.pattern);
    if (!match) {
      continue;
    }
    const route = { page: matcher.page };
    if (matcher.memoryScope) {
      route.memoryScope = matcher.memoryScope;
    }
    if (matcher.themeId === null) {
      route.themeId = null;
    } else if (matcher.page === 'themeEditor') {
      route.themeId = Number(match[1] ?? 0);
    }
    return route;
  }
  return { page: 'query' };
}

export function navigate(path, { replace = false } = {}) {
  const method = replace ? 'replaceState' : 'pushState';
  window.history[method](null, '', path);
  applyLocation();
}

function applyLocation() {
  const route = routeFromPath(window.location.pathname);
  if (route.page === 'themeEditor') {
    state.themeEditorThemeId = route.themeId ?? null;
  }
  if (route.page === 'memory') {
    // 「我的记忆」只看本人，「记忆管理」（系统设置进入）才允许管理员查看全部用户。
    state.memoryScope = route.memoryScope === 'all' ? 'all' : 'self';
    if (state.memoryScope !== 'all') {
      state.memoryUserId = null;
    }
  }
  setActivePage(route.page);
}

async function loadPageModule(page) {
  const modulePage = page === 'themeEditor' ? 'themes' : page;
  const cached = pageModuleCache.get(modulePage);
  if (cached) {
    return cached;
  }
  const loader = pageModuleSpecs[modulePage];
  if (!loader) {
    throw new Error(`未注册前端页面模块: ${modulePage}`);
  }
  const module = await loader();
  pageModuleCache.set(modulePage, module);
  return module;
}
async function renderPage() {
  const root = document.getElementById('appMain');
  try {
    if (state.page !== 'query') {
      clearSidebarSessions();
      hideThemeBreadcrumb();
      setWorkspaceDrawer(false);
    }
    const module = await loadPageModule(state.page);
    const renderer = module[pageRenderers[state.page]];
    if (typeof renderer !== 'function') {
      throw new Error(`页面模块未提供渲染函数: ${state.page}`);
    }
    if (state.page === 'themeEditor') {
      await renderer(
        root,
        state.themeEditorThemeId ? getTheme(state.themeEditorThemeId) : null,
      );
    } else {
      await renderer(root);
    }
    updateWorkspaceChrome();
  } catch (error) {
    root.innerHTML = emptyState(error.message, 'circle-alert');
    toast(error.message, 'error');
  }
}

function emptyState(message, iconName = 'library') {
  return `<div class="empty-state"><div>${icon(iconName)}<p>${escapeHtml(message)}</p></div></div>`;
}


export async function initialize() {
  try {
    hydrateIcons();
    enhanceCustomSelects(document);
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            enhanceCustomSelects(node);
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
    mountAuthGate(document.getElementById('appMain'), {
      onAuthenticated: enterWorkspace,
      toast,
    });
    const session = await readSession();
    if (!session?.authenticated) {
      showLogin();
      return;
    }
    await enterWorkspace();
  } catch (error) {
    document.getElementById('appMain').innerHTML = emptyState(
      `平台初始化失败：${error.message}`,
      'circle-alert',
    );
  }
}

async function enterWorkspace() {
  await loadBootstrap();
  applyLocation();
  await guideTour('auto');
}

// 首登分步引导的编排（首次标记、重播、跨页跳转）都在 guide 页面模块内，运行时只做桥接。
async function guideTour(mode) {
  const module = await loadPageModule('guide');
  return mode === 'replay'
    ? module.startOnboardingTour?.({ force: true })
    : module.autoStartOnboardingTour?.();
}

document.getElementById('mainNav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-page]');
  if (button) {
    const page = button.dataset.page;
    if (page === 'query') {
      pageModuleCache.get('query')?.startNewSession?.(false);
      navigate('/');
      return;
    }
    navigate(page === 'query' ? '/' : `/${page}`);
  }
});

window.addEventListener('popstate', applyLocation);

document.getElementById('densitySeg').addEventListener('click', (event) => {
  const option = event.target.closest('[data-density]');
  if (!option) {
    return;
  }
  state.chatDensity = option.dataset.density;
  persistPreferences({ chatDensity: state.chatDensity });
  document.querySelectorAll('#densitySeg .density-option').forEach((button) => {
    button.classList.toggle('is-active', button === option);
  });
  document.getElementById('appMain').classList.toggle(
    'density-compact',
    state.chatDensity === 'compact',
  );
});

document.getElementById('workspaceToggle').addEventListener('click', () => {
  setWorkspaceDrawer(!state.workspaceDrawerOpen);
});
document.getElementById('workspaceClose').addEventListener('click', () => {
  setWorkspaceDrawer(false);
});
window.addEventListener('resize', () => {
  for (const chart of state.chatChartInstances.values()) {
    chart.resize();
  }
});

export {
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
  renderSafeMarkdown,
  visibleExecutionStages,
};
