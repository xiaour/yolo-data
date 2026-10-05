import * as core from '../core/runtime.js';
import { renderDataTable } from '../components/table.js';
import {
  isProcessArtifact,
  renderProcessArtifactView,
  renderWorkspaceArtifactList,
  workspaceArtifactFileMeta,
} from '../components/workspaceArtifacts.js';

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
  navigate,
  registerQueryHooks,
  renderSafeMarkdown,
  visibleExecutionStages,
} = core;

async function renderQueryPage(root) {
  await ensureChatLoaded();
  await loadWorkspaceForSession();
  disposeChatCharts();
  const theme = getTheme();
  const session = state.chatSessions.find(
    (item) => Number(item.id) === Number(state.activeSessionId),
  );
  const modelOptions = availableThemeModels(theme);
  const selectedModelId = currentModelSelection(theme, session?.modelId);
  const canSwitchModel = state.chatMessages.length === 0;
  const examples = getExampleQuestions(theme);
  const questionAxis = renderQuestionAxis();

  root.innerHTML = `
    <div class="chat-layout">
      <section class="chat-panel">
        <div class="chat-timeline" id="chatScroll">
          ${questionAxis ? `
            <div class="chat-question-layout">
              ${questionAxis}
              <div class="chat-thread" id="chatTimeline">
                ${renderChatTimeline()}
              </div>
            </div>
          ` : `
            <div class="chat-thread" id="chatTimeline">
              ${renderChatTimeline()}
            </div>
          `}
        </div>
        <footer class="chat-composer">
          <div class="chat-composer-inner">
            ${state.chatMessages.length === 0 ? `
              <div class="chat-example-row">
                ${examples.map((question) => (
                  `<button class="example-chip" type="button" data-question="${escapeAttr(question)}">${escapeHtml(question)}</button>`
                )).join('')}
              </div>
            ` : ''}
            <div class="chat-input-shell">
              <textarea class="chat-input" id="questionInput" rows="1" placeholder="继续追问，例如：那按渠道拆开呢" aria-label="问数问题"></textarea>
              <div class="chat-input-actions">
                ${modelOptions.length > 0 ? `
                  <span class="chat-model-picker${canSwitchModel ? '' : ' is-locked'}" title="${canSwitchModel ? '新会话可选择运行模型' : '会话开始后模型已锁定'}">
                    <select class="chat-model-select" id="chatModelSelect"${canSwitchModel ? '' : ' disabled'}>
                      ${modelOptions.map((model) => (
                        `<option value="${model.id}"${Number(selectedModelId) === Number(model.id) ? ' selected' : ''}>${escapeHtml(model.name)}</option>`
                      )).join('')}
                    </select>
                  </span>
                ` : `
                  <span class="chat-model-picker is-locked">
                    <span class="chat-model-static">${state.models.length > 0 ? '默认模型' : '未配置模型'}</span>
                  </span>
                `}
                <button class="btn btn-primary chat-send-btn" id="runQueryBtn" type="button" aria-label="发送">
                  ${icon('send', '发送')}
                </button>
                <button class="btn btn-quiet chat-stop-btn" id="stopQueryBtn" type="button" title="停止生成" aria-label="停止生成" hidden>
                  ${icon('square', '停止生成')}
                </button>
              </div>
            </div>
            <div class="composer-hint">
              <span>Enter 发送，Shift + Enter 换行</span>
            </div>
          </div>
        </footer>
      </section>
    </div>
  `;

  syncThemeBreadcrumb();
  document.getElementById('runQueryBtn').addEventListener('click', runQuestion);
  document.getElementById('stopQueryBtn').addEventListener('click', stopQuestion);
  document.getElementById('chatModelSelect')?.addEventListener('change', (event) => {
    if (!canSwitchModel) {
      return;
    }
    state.selectedModelId = Number(event.target.value);
  });
  const input = document.getElementById('questionInput');
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      runQuestion();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  });
  if (state.chatMessages.length === 0) {
    startWelcomePlaceholderRotation(theme);
  } else {
    stopWelcomePlaceholderRotation();
    input.placeholder = '继续追问，例如：那按渠道拆开呢';
  }
  renderSidebarSessions();
  bindExampleQuestions();
  bindQuestionAxis();
  bindChatActions();
  mountChatCharts();
  scrollChatToBottom(false);
}

async function ensureChatLoaded() {
  if (state.chatLoaded) {
    return;
  }
  state.chatSessions = await api('/api/chat/sessions');
  state.chatLoaded = true;
  if (!state.activeSessionId && state.chatSessions.length > 0) {
    const latest = state.chatSessions[0];
    state.activeSessionId = latest.id;
    state.selectedThemeId = latest.themeId;
    state.selectedModelId = latest.modelId ?? null;
    state.chatMessages = await api(`/api/chat/sessions/${latest.id}/messages`);
  }
}

function getExampleQuestions(theme) {
  if (theme?.examples?.length > 0) {
    return theme.examples;
  }
  return [];
}

let welcomePlaceholderTimer = null;
const FALLBACK_WELCOME_EXAMPLES = [
  '本月业绩是多少？',
  '本期与上期相比变化如何？',
  '按地区拆分最近趋势',
  '帮我分析变化的主要原因',
];

function stopWelcomePlaceholderRotation() {
  if (welcomePlaceholderTimer) {
    clearInterval(welcomePlaceholderTimer);
    welcomePlaceholderTimer = null;
  }
}

function startWelcomePlaceholderRotation(theme) {
  stopWelcomePlaceholderRotation();
  const examples = getExampleQuestions(theme).length > 0
    ? getExampleQuestions(theme)
    : FALLBACK_WELCOME_EXAMPLES;
  let index = 0;
  const apply = () => {
    const input = document.getElementById('questionInput');
    if (
      !input
      || state.chatMessages.length > 0
      || document.activeElement === input
    ) {
      return;
    }
    input.placeholder = examples[index % examples.length];
    index += 1;
  };
  apply();
  welcomePlaceholderTimer = setInterval(apply, 4000);
}

function availableThemeModels(theme) {
  const allowed = new Set((theme?.modelIds ?? []).map(Number));
  return state.models.filter((model) => (
    model.status !== 0
    && (allowed.size === 0 || allowed.has(Number(model.id)))
  ));
}

function currentModelSelection(theme, sessionModelId = null) {
  const models = availableThemeModels(theme);
  const valid = (modelId) => (
    modelId && models.some((model) => Number(model.id) === Number(modelId))
  );
  const selected = valid(state.selectedModelId)
    ? state.selectedModelId
    : valid(sessionModelId)
      ? sessionModelId
      : valid(theme?.defaultModelId)
        ? theme.defaultModelId
        : models[0]?.id ?? null;
  if (selected && Number(state.selectedModelId) !== Number(selected)) {
    state.selectedModelId = selected;
  }
  return selected;
}

function renderSessionList() {
  if (state.chatSessions.length === 0) {
    return `<div class="session-empty">${icon('message-square', '暂无会话')}<span>暂无会话记录</span></div>`;
  }
  return state.chatSessions.map((session) => `
    <div class="session-item${Number(session.id) === Number(state.activeSessionId) ? ' is-active' : ''}" data-session="${session.id}">
      <button class="session-main" type="button" data-select-session="${session.id}">
        <strong>${escapeHtml(session.title || '新会话')}</strong>
        <time>${escapeHtml(formatSessionTime(session.updatedAt))}</time>
      </button>
      <button class="btn btn-quiet btn-icon session-delete" type="button" data-delete-session="${session.id}" aria-label="删除会话">
        ${icon('trash', '删除会话')}
      </button>
    </div>
  `).join('');
}

function renderSidebarSessions() {
  const container = document.getElementById('sessionSidebar');
  if (!container) {
    return;
  }
  if (state.page !== 'query') {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  container.innerHTML = `
    <div class="sidebar-session-head">
      <div>
        <strong>会话记录</strong>
        <small id="sessionCountLabel">${state.chatSessions.length} 个记忆会话</small>
      </div>
      <button class="btn btn-quiet btn-icon" id="newSessionBtn" type="button" aria-label="新建会话">
        ${icon('plus', '新建会话')}
      </button>
    </div>
    <div class="session-list" id="sessionList">
      ${renderSessionList()}
    </div>
  `;
  document.getElementById('newSessionBtn').addEventListener('click', startNewSession);
  bindSessionList();
}

function bindSessionList() {
  document.querySelectorAll('[data-select-session]').forEach((button) => {
    button.addEventListener('click', async () => {
      await loadChatSession(Number(button.dataset.selectSession));
    });
  });
  document.querySelectorAll('[data-delete-session]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const session = state.chatSessions.find(
        (item) => Number(item.id) === Number(button.dataset.deleteSession),
      );
      if (!window.confirm(`确认删除会话「${session?.title ?? ''}」及其记忆？`)) {
        return;
      }
      await api(`/api/chat/sessions/${button.dataset.deleteSession}`, { method: 'DELETE' });
      if (Number(state.activeSessionId) === Number(button.dataset.deleteSession)) {
        state.activeSessionId = null;
        state.chatMessages = [];
      }
      state.chatSessions = await api('/api/chat/sessions');
      toast('会话记忆已删除');
      renderPage();
    });
  });
}

async function loadChatSession(sessionId) {
  const session = state.chatSessions.find((item) => Number(item.id) === Number(sessionId));
  if (!session) {
    return;
  }
  state.activeSessionId = session.id;
  state.selectedThemeId = session.themeId;
  state.selectedModelId = session.modelId ?? null;
  state.chatStream = null;
  state.chatMessages = await api(`/api/chat/sessions/${session.id}/messages`);
  await loadWorkspaceForSession();
  renderPage();
}

function startNewSession(render = true) {
  stopWelcomePlaceholderRotation();
  state.activeSessionId = null;
  state.chatMessages = [];
  state.chatStream = null;
  state.selectedModelId = null;
  state.workspace = null;
  state.workspaceArtifacts = [];
  disposeChatCharts();
  if (render) {
    renderPage();
  }
}

async function loadWorkspaceForSession() {
  if (!state.activeSessionId) {
    state.workspace = null;
    state.workspaceArtifacts = [];
    updateWorkspaceChrome();
    return;
  }
  const workspaces = await api(`/api/workspaces?sessionId=${state.activeSessionId}`);
  state.workspace = workspaces[0] ?? null;
  state.workspaceArtifacts = state.workspace
    ? await api(`/api/workspaces/${state.workspace.id}/artifacts`)
    : [];
  updateWorkspaceChrome();
}

function setWorkspaceDrawer(open) {
  state.workspaceDrawerOpen = Boolean(open);
  const drawer = document.getElementById('workspaceDrawer');
  document.body.classList.toggle('workspace-open', state.workspaceDrawerOpen);
  drawer.classList.toggle('is-open', state.workspaceDrawerOpen);
  drawer.setAttribute('aria-hidden', state.workspaceDrawerOpen ? 'false' : 'true');
}

function renderWorkspaceDrawer() {
  const container = document.getElementById('workspaceArtifactList');
  if (!container) {
    return;
  }
  if (state.workspaceArtifacts.length === 0) {
    container.innerHTML = `
      <div class="workspace-empty">
        ${icon('file', '暂无工作区产物')}
        <p>当前会话暂无产物</p>
      </div>
    `;
    return;
  }
  container.innerHTML = renderWorkspaceArtifactList(state.workspaceArtifacts);
  bindWorkspaceActions();
}

function bindWorkspaceActions() {
  document.querySelectorAll('[data-artifact-view]').forEach((button) => {
    button.addEventListener('click', () => openWorkspaceArtifact(button.dataset.artifactView));
  });
  document.querySelectorAll('[data-artifact-download]').forEach((button) => {
    button.addEventListener('click', () => downloadWorkspaceArtifact(
      button.dataset.artifactDownload,
      button.dataset.format,
    ));
  });
}

async function openWorkspaceArtifactFromChat(artifactId) {
  setWorkspaceDrawer(true);
  try {
    await loadWorkspaceForSession();
    const card = [...document.querySelectorAll('[data-artifact-id]')].find(
      (element) => element.dataset.artifactId === String(artifactId),
    );
    if (!card) {
      toast('未找到对应的工作区产物', 'error');
      return;
    }
    document.querySelectorAll('.workspace-artifact-card.is-located').forEach((element) => {
      element.classList.remove('is-located');
    });
    requestAnimationFrame(() => {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('is-located');
      window.setTimeout(() => card.classList.remove('is-located'), 2200);
    });
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function openWorkspaceArtifact(artifactId) {
  try {
    const artifact = await api(`/api/artifacts/${encodeURIComponent(artifactId)}`);
    const columns = artifact.payload?.data?.columns ?? [];
    const rows = artifact.payload?.data?.rows ?? [];
    if (isProcessArtifact(artifact)) {
      openModal({
        title: artifact.title || '过程文件',
        wide: true,
        body: renderProcessArtifactView(artifact),
      });
      return;
    }
    if (artifact.artifactType === 'CODE') {
      openModal({
        title: artifact.title || '代码运行记录',
        wide: true,
        body: `
          <div class="answer-meta">
            <span class="meta-pill">${artifact.metadata?.success ? '执行成功' : '执行失败'}</span>
            <span class="meta-pill">${formatDurationSeconds(artifact.metadata?.durationMs ?? 0)}</span>
            <span class="meta-pill">${escapeHtml(artifact.metadata?.runId ?? '')}</span>
          </div>
          <details class="execution-review-raw" open>
            <summary>生成代码</summary>
            <pre>${escapeHtml(truncateReviewText(artifact.payload?.code ?? '', 30000))}</pre>
          </details>
          ${artifact.payload?.stdout ? `
            <details class="execution-review-raw">
              <summary>标准输出</summary>
              <pre>${escapeHtml(truncateReviewText(artifact.payload.stdout, 12000))}</pre>
            </details>
          ` : ''}
          ${artifact.payload?.stderr ? `
            <details class="execution-review-raw is-error">
              <summary>错误输出</summary>
              <pre>${escapeHtml(truncateReviewText(artifact.payload.stderr, 12000))}</pre>
            </details>
          ` : ''}
        `,
      });
      return;
    }
    openModal({
      title: artifact.title || '工作区结果',
      wide: true,
      body: `
        <div class="answer-meta">
          <span class="meta-pill">版本 v${artifact.currentVersion}</span>
          <span class="meta-pill">${rows.length} 行</span>
          <span class="meta-pill">${columns.length} 列</span>
        </div>
        <div class="chat-answer-text">${renderSafeMarkdown(
          artifact.payload?.semanticParse?.question
            ? `**问题**\n${artifact.payload.semanticParse.question}`
            : '',
        )}</div>
        ${columns.length > 0
          ? renderDataTable(columns, rows, {
            timeGrain: artifact.metadata?.timeGrain
              ?? artifact.payload?.semanticParse?.timeGrain,
          })
          : emptyState('该结果没有表格数据')}
      `,
    });
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function downloadWorkspaceArtifact(artifactId, format) {
  try {
    const response = await fetch(
      `/api/artifacts/${encodeURIComponent(artifactId)}/download?format=${encodeURIComponent(format)}`,
      { headers: { 'x-user-id': String(state.currentUser.id) } },
    );
    if (!response.ok) {
      throw new Error(`下载失败：HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const filename = match ? decodeURIComponent(match[1]) : `artifact.${format}`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function renderChatTimeline() {
  if (state.chatMessages.length === 0 && !state.chatLoading) {
    const theme = getTheme();
    const primaryDatasetId = Number(theme?.primaryBusinessDatasetId) || null;
    const dataset = state.businessDatasets.find((item) => (
      Number(item.id) === primaryDatasetId
    )) ?? state.businessDatasets[0];
    const indicatorCount = state.indicators?.length
      || state.bootstrap?.health?.source?.lastSyncCount
      || 0;
    const datasetLabel = dataset?.name ?? '已接入业务数据集';
    return `
      <div class="chat-welcome welcome-mini">
        <div class="welcome-mini-mark">
          <img src="/yolo-mark.svg" alt="YOLO" />
        </div>
        <h2 class="welcome-mini-title">今天想问点什么？</h2>
        <p class="welcome-mini-sub">${escapeHtml(theme?.name ?? '当前主题')} · ${escapeHtml(datasetLabel)} · ${indicatorCount} 个在线指标 · 支持查数 / 对比 / 趋势 / 归因</p>
      </div>
    `;
  }
  const messages = state.chatMessages.map(renderChatMessage).join('');
  return `${messages}${state.chatLoading ? `
    <div class="chat-message is-assistant" id="liveChatMessage">
      <span class="agent-avatar agent-avatar-text">YOLO</span>
      <div class="chat-bubble assistant-bubble live-execution" id="liveExecution">
        ${renderLiveExecution()}
      </div>
    </div>
  ` : ''}`;
}

function renderQuestionAxis() {
  const questions = state.chatMessages.filter((message) => message.role === 'user');
  if (questions.length < 5) {
    return '';
  }
  return `
    <aside class="chat-question-rail" id="chatQuestionAxis" aria-label="会话问题导航">
      <div class="question-rail-label">问题轴</div>
      <div class="question-rail-track">
        ${questions.map((message, index) => `
          <button class="question-rail-item" type="button"
            data-question-target="${message.id}"
            title="${escapeAttr(message.content)}"
            aria-label="跳转到问题 ${index + 1}">
            <span class="question-rail-dot"></span>
            <span class="question-rail-copy">${escapeHtml(message.content)}</span>
          </button>
        `).join('')}
      </div>
    </aside>
  `;
}

function bindQuestionAxis() {
  const axis = document.getElementById('chatQuestionAxis');
  const scroll = document.getElementById('chatScroll');
  if (!axis || !scroll) {
    return;
  }
  const items = [...axis.querySelectorAll('[data-question-target]')];
  const messages = [...document.querySelectorAll('[data-user-question]')];
  const updateActive = () => {
    const containerTop = scroll.getBoundingClientRect().top;
    const threshold = containerTop + 110;
    let activeIndex = -1;
    messages.forEach((message, index) => {
      if (message.getBoundingClientRect().top <= threshold) {
        activeIndex = index;
      }
    });
    if (activeIndex < 0) {
      activeIndex = 0;
    }
    items.forEach((item, index) => {
      const active = index === activeIndex;
      item.classList.toggle('is-active', active);
      if (active) {
        item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  };
  items.forEach((item) => {
    item.addEventListener('click', () => {
      const message = messages.find(
        (candidate) => String(candidate.dataset.userQuestion) === String(item.dataset.questionTarget),
      );
      if (message) {
        message.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
    item.addEventListener('mouseenter', () => {
      items.forEach((candidate) => candidate.classList.remove('is-hovered'));
      item.classList.add('is-hovered');
      const message = messages.find(
        (candidate) => String(candidate.dataset.userQuestion) === String(item.dataset.questionTarget),
      );
      if (message) {
        message.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
    item.addEventListener('mouseleave', () => {
      item.classList.remove('is-hovered');
    });
  });
  scroll.addEventListener('scroll', updateActive, { passive: true });
  requestAnimationFrame(updateActive);
}

function renderLiveExecution() {
  const stream = state.chatStream ?? {};
  const workflow = stream.workflow;
  const activeStage = workflow?.stages?.find((stage) => stage.status === 'RUNNING')
    ?? [...(workflow?.stages ?? [])].reverse().find((stage) => stage.summary);
  const warnings = stream.warnings ?? [];
  const modelText = formatModelName(stream.runtime);
  const sourceText = formatSourceMode(stream.source?.mode);
  return `
    <div class="live-execution-head">
      <span class="spinner"></span>
      <div>
        <strong>${escapeHtml(activeStage?.summary || activeStage?.name || '正在启动 DataAgent 工作流')}</strong>
        <small>${escapeHtml(modelText)} · Data Agent · ${escapeHtml(sourceText)} · ${workflow?.progress?.completed ?? 0}/${workflow?.progress?.total ?? 8} 步</small>
      </div>
    </div>
    ${warnings.map((warning) => `
      <div class="live-warning">${escapeHtml(warning.message)}</div>
    `).join('')}
    ${renderExecutionDetails({
      workflow,
      processSteps: stream.processSteps ?? [],
    })}
  `;
}

function renderChatMessage(message) {
  if (message.role === 'user') {
    return `
      <div class="chat-message is-user" data-user-question="${message.id}">
        <div class="chat-bubble user-bubble">${escapeHtml(message.content)}</div>
        <span class="user-avatar">${escapeHtml(initials(state.currentUser?.displayName))}</span>
      </div>
    `;
  }
  return `
    <div class="chat-message is-assistant">
      <span class="agent-avatar agent-avatar-text">YOLO</span>
      <div class="chat-bubble assistant-bubble">
        ${renderAssistantContent(message)}
      </div>
    </div>
  `;
}

function renderClarificationOptions(result) {
  const clarification = result?.clarification;
  if (!clarification?.options?.length) {
    return '';
  }
  return `
    <div class="clarification-options">
      ${clarification.options.map((option) => `
        <button class="btn ${option.recommended ? 'btn-primary' : 'btn-quiet'} clarification-option"
          type="button"
          data-clarification-option="${escapeAttr(option.id)}"
          data-message-id="__MESSAGE_ID__"
          title="${escapeAttr(option.description ?? option.label ?? '')}">
          ${escapeHtml(option.label ?? option.id)}
          ${option.recommended ? '<span class="clarification-recommended">推荐</span>' : ''}
        </button>
      `).join('')}
    </div>
  `;
}

function renderAssistantContent(message) {
  const result = message.result ?? {};
  const columns = result.data?.columns ?? [];
  const rows = result.data?.rows ?? [];
  const chart = result.chart ?? { type: 'table' };
  const numericColumns = columns.filter(
    (column) => String(column.showType).toUpperCase() === 'NUMBER',
  );
  const kpis = chart.type === 'kpi'
    ? numericColumns.map((column) => {
      const value = rows[0]?.[column.bizName] ?? rows[0]?.[column.name];
      const displayValue = column.presentationType
        ? formatPresentationCell(value, column)
        : formatNumber(value);
      return `<div class="kpi-item"><span>${escapeHtml(column.name)}</span><strong>${escapeHtml(displayValue)}</strong></div>`;
    }).join('')
    : '';
  const queryFingerprint = String(result.queryFingerprint ?? '');
  const provenance = formatProvenance(result.provenance);
  return `
    <div class="chat-answer-text">${renderSafeMarkdown(message.content)}</div>
    <div class="answer-meta">
      ${provenance ? `
        <span class="meta-pill provenance-pill ${provenance.className}" title="${escapeAttr(provenance.reason)}">
          ${icon(provenance.iconName, provenance.label)}${escapeHtml(provenance.label)}
        </span>
      ` : ''}
      ${result.indicator?.name ? `<span class="meta-pill">${escapeHtml(result.indicator.name)}</span>` : ''}
      ${result.dataset?.name ? `<span class="meta-pill">${escapeHtml(result.dataset.name)}</span>` : ''}
    </div>
    ${kpis ? `<div class="kpi-grid chat-kpis">${kpis}</div>` : ''}
    ${renderClarificationOptions(result).replaceAll('__MESSAGE_ID__', escapeAttr(message.id))}
    ${chart.type !== 'table' && chart.type !== 'kpi' ? `
      <div class="chat-chart-panel">
        <div class="panel-title">
          <strong>${escapeHtml(chart.title ?? '可视化分析')}</strong>
          <small>${escapeHtml(chart.reason ?? '')}</small>
        </div>
        <div class="chart-canvas chat-chart-canvas" id="chat-chart-${message.id}"></div>
      </div>
    ` : ''}
    ${rows.length > 0 ? `
      <details class="chat-data-details">
        <summary>查看查询明细 · ${rows.length} 行</summary>
        ${renderDataTable(columns, rows, {
          timeGrain: result.semanticParse?.timeGrain ?? result.timeGrain,
        })}
      </details>
    ` : ''}
    ${renderArtifactResultLink(result)}
    ${renderExecutionDetails(result)}
    <div class="chat-answer-actions">
      ${result.semanticParse ? `
        <button class="btn btn-quiet btn-icon chat-action-icon" type="button"
          data-semantic-plan="${escapeAttr(result.semanticParse.planId)}"
          title="查看语义解析" aria-label="查看语义解析">
          ${icon('brain-circuit', '查看语义解析')}
        </button>
      ` : ''}
      <button class="btn btn-quiet btn-icon chat-action-icon" type="button"
        data-feedback="up" data-message-id="${message.id}"
        title="有帮助" aria-label="有帮助">
        ${icon('thumbs-up', '有帮助')}
      </button>
      <button class="btn btn-quiet btn-icon chat-action-icon" type="button"
        data-feedback="down" data-message-id="${message.id}"
        title="需纠正" aria-label="需纠正">
        ${icon('thumbs-down', '需纠正')}
      </button>
      ${queryFingerprint ? `
        <button class="btn btn-quiet btn-icon chat-action-icon fingerprint-copy-btn" type="button"
          data-copy-fingerprint="${escapeAttr(queryFingerprint)}"
          title="复制查询指纹" aria-label="复制查询指纹">
          ${icon('copy', '复制查询指纹')}
        </button>
      ` : ''}
    </div>
  `;
}

function renderArtifactResultLink(result) {
  const artifactId = String(result?.artifactId ?? '').trim();
  if (!artifactId) {
    return '';
  }
  const file = workspaceArtifactFileMeta({
    artifactType: result.artifactType,
    metadata: {},
  });
  const title = result.artifactTitle
    || result.indicator?.name
    || result.dataset?.name
    || '本次问数产物';
  return `
    <button class="chat-artifact-result-link" type="button"
      data-open-artifact="${escapeAttr(artifactId)}"
      data-workspace-id="${escapeAttr(result.workspaceId ?? '')}"
      title="打开工作区并查看 ${escapeAttr(title)}"
      aria-label="打开工作区并查看 ${escapeAttr(title)}">
      <span class="chat-artifact-result-link-icon ${escapeAttr(file.className)}">
        ${icon(file.iconName, file.label)}
      </span>
      <span>查看本次产出 · ${escapeHtml(title)}</span>
      ${icon('arrow-up-right', '打开工作区产物')}
    </button>
  `;
}

const EXECUTION_PHASE_DEFINITIONS = [
  { code: 'INTENT', name: '理解问题', description: '识别意图、上下文和澄清策略' },
  { code: 'SKILL_AUDIT', name: 'Skill 口径审计', description: '按主题 Skill 审计问题口径与数据粒度' },
  { code: 'SEMANTIC_RESOLVE', name: '语义解析', description: '对指标、维度和枚举候选执行多策略裁决' },
  { code: 'SEMANTIC_DISCOVERY', name: '检索语义对象', description: '检索指标或业务数据集' },
  { code: 'SEMANTIC_CONFIRM', name: '确认口径', description: '确认指标、字段和枚举值域' },
  { code: 'PLAN', name: '生成查询计划', description: '编译查询契约和查询计划' },
  { code: 'VALIDATE', name: '校验门禁', description: '校验条件、权限和只读边界' },
  { code: 'EXECUTE', name: '执行查询', description: '执行指标或数据集查询' },
  { code: 'RESULT_ANALYST', name: '结果分析', description: '生成合计、TopN、趋势、异常和业务判断' },
  { code: 'RESULT_VALIDATION', name: 'Skill 结果验证', description: '按主题 Skill 验证结果和回答证据' },
  { code: 'CODE', name: '代码分析', description: '生成并运行分析代码' },
  { code: 'ANALYZE', name: '分析结果', description: '整理透视、校验和可视化' },
  { code: 'RESPOND', name: '生成回答', description: '生成业务回答与交付说明' },
];

function executionStepStageCode(step) {
  if (step?.stageCode) {
    return step.stageCode;
  }
  if (step?.name === 'search_indicators' || step?.name === 'list_business_datasets') {
    return 'SEMANTIC_DISCOVERY';
  }
  if (
    step?.name === 'get_indicator'
    || step?.name === 'get_business_dataset_definition'
  ) {
    return 'SEMANTIC_CONFIRM';
  }
  if (step?.name === 'compile_query_contract') {
    return 'PLAN';
  }
  if (step?.name === 'execute_analysis_code') {
    return 'CODE';
  }
  if (
    step?.name === 'list_workspace_artifacts'
    || step?.name === 'transform_workspace_artifact'
  ) {
    return 'ANALYZE';
  }
  if (step?.type === 'plan') {
    return 'PLAN';
  }
  if (step?.type === 'validation') {
    return 'VALIDATE';
  }
  if (step?.type === 'response') {
    return 'RESPOND';
  }
  if (step?.type === 'reuse' || step?.type === 'tool') {
    return 'EXECUTE';
  }
  return 'INTENT';
}

function executionPhaseStatus(stage, steps) {
  if (
    stage?.status === 'FAILED'
    || steps.some((step) => step.status === 'error' || step.status === 'failed')
  ) {
    return 'failed';
  }
  if (
    stage?.status === 'RUNNING'
    || steps.some((step) => step.status === 'running')
  ) {
    return 'running';
  }
  if (stage?.status === 'SKIPPED') {
    return 'skipped';
  }
  return 'success';
}

function truncateReviewText(value, limit = 12000) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}\n… 内容已截断` : text;
}

function renderExecutionReview(step) {
  const review = step?.review ?? {};
  const facts = review.facts ?? [];
  const blocks = [];
  if (facts.length > 0) {
    blocks.push(`
      <div class="execution-review-facts">
        ${facts.map((fact) => `
          <div class="execution-review-fact">
            <span>${escapeHtml(fact.label)}</span>
            <strong>${escapeHtml(fact.value)}</strong>
          </div>
        `).join('')}
      </div>
    `);
  }
  if (review.details) {
    blocks.push(`
      <details class="execution-review-raw">
        <summary>查看结构化信息</summary>
        <pre>${escapeHtml(truncateReviewText(JSON.stringify(review.details, null, 2), 16000))}</pre>
      </details>
    `);
  }
  if (review.code) {
    blocks.push(`
      <details class="execution-review-raw">
        <summary>查看生成代码</summary>
        <pre>${escapeHtml(truncateReviewText(review.code))}</pre>
      </details>
    `);
  }
  if (review.stdout) {
    blocks.push(`
      <details class="execution-review-raw">
        <summary>查看代码输出</summary>
        <pre>${escapeHtml(truncateReviewText(review.stdout, 8000))}</pre>
      </details>
    `);
  }
  if (review.stderr) {
    blocks.push(`
      <details class="execution-review-raw is-error">
        <summary>查看错误输出</summary>
        <pre>${escapeHtml(truncateReviewText(review.stderr, 8000))}</pre>
      </details>
    `);
  }
  if (step?.artifactId) {
    blocks.push(`
      <div class="execution-review-artifact">
        <button class="btn btn-quiet btn-small" type="button"
          data-open-process-artifact="${escapeAttr(step.artifactId)}">
          ${icon('file-text', '查看过程文件')}查看过程文件
        </button>
      </div>
    `);
  }
  return blocks.join('');
}

function renderExecutionStep(step) {
  const review = renderExecutionReview(step);
  return `
    <details class="execution-operation is-${escapeAttr(step.status ?? 'success')}">
      <summary>
        <span class="execution-operation-type">${step.type === 'tool' ? '工具' : '内部步骤'}</span>
        <strong>${escapeHtml(step.title ?? step.name ?? '执行步骤')}</strong>
        <small>${escapeHtml(step.detail ?? '')}</small>
        <span>${step.durationMs == null ? '执行中' : formatDurationSeconds(step.durationMs)}</span>
      </summary>
      ${review ? `<div class="execution-operation-body">${review}</div>` : ''}
    </details>
  `;
}

function renderExecutionPhase({ definition, stage, steps, index }) {
  const status = executionPhaseStatus(stage, steps);
  const duration = stage?.durationMs
    ?? steps.reduce((sum, step) => sum + Number(step.durationMs ?? 0), 0);
  const successCount = steps.filter((step) => step.status === 'success').length;
  const outputCount = steps.reduce(
    (sum, step) => sum + (step.review?.details?.outputs?.length ?? 0),
    0,
  );
  const summary = definition.code === 'CODE'
    ? `${steps.length} 段代码，${successCount} 段执行成功${outputCount > 0 ? `，生成 ${outputCount} 个文件` : ''}`
    : stage?.summary
      || steps[0]?.detail
      || definition.description;
  const attempts = stage?.attempts ?? [];
  return `
    <details class="execution-phase is-${status}">
      <summary>
        <span class="execution-phase-index">${index + 1}</span>
        <span class="execution-phase-copy">
          <strong>${escapeHtml(definition.name)}</strong>
          <small>${escapeHtml(summary)}</small>
        </span>
        <span class="execution-phase-meta">
          ${steps.length > 0 ? `<em>${steps.length} 项操作</em>` : ''}
          <b>${['PENDING', 'SKIPPED'].includes(stage?.status) || duration == null
            ? '-'
            : formatDurationSeconds(duration)}</b>
        </span>
      </summary>
      <div class="execution-phase-body">
        ${stage?.detail && stage.detail !== summary
          ? `<p>${escapeHtml(stage.detail)}</p>`
          : ''}
        ${steps.length > 0
          ? `<div class="execution-operation-list">${steps.map(renderExecutionStep).join('')}</div>`
          : `<div class="execution-phase-empty">本阶段无单独工具调用</div>`}
        ${attempts.length > 1 ? `
          <details class="execution-attempts">
            <summary>查看 ${attempts.length - 1} 次废弃尝试</summary>
            ${attempts.slice(0, -1).map((attempt) => `
              <div>
                <span>${escapeHtml(attempt.status)}</span>
                <small>${escapeHtml(attempt.summary || attempt.detail || '')}</small>
              </div>
            `).join('')}
          </details>
        ` : ''}
      </div>
    </details>
  `;
}

function renderExecutionDetails(result) {
  const workflow = result?.workflow;
  const stages = visibleExecutionStages(workflow?.stages);
  const steps = result?.processSteps ?? [];
  const visibleSteps = steps.filter((step) => !step.superseded);
  const discardedSteps = steps.filter((step) => step.superseded);
  const duration = workflow?.durationMs
    ?? steps.reduce((sum, step) => sum + Number(step.durationMs ?? 0), 0);
  const fingerprint = String(result?.queryFingerprint ?? '').slice(0, 12);
  const summaryMeta = [
    result?.runtime
      ? `<span class="execution-summary-pill">${escapeHtml(formatModelName(result.runtime))}</span>`
      : '',
    result?.runtime
      ? '<span class="execution-summary-pill">Data Agent</span>'
      : '',
    result?.runtime?.executionAdapter
      ? `<span class="execution-summary-pill">${escapeHtml(formatSourceMode(result.runtime.executionAdapter))}</span>`
      : '',
    result?.permissions
      ? `<span class="execution-summary-pill">${result.permissions.rowPolicyCount} 条行权限</span>`
      : '',
  ].join('');
  if (stages.length === 0 && steps.length === 0 && !summaryMeta) {
    return '';
  }

  const phaseMap = new Map();
  for (const stage of stages) {
    phaseMap.set(stage.code, { stage, steps: [] });
  }
  for (const step of visibleSteps) {
    const code = executionStepStageCode(step);
    if (!phaseMap.has(code)) {
      phaseMap.set(code, { stage: null, steps: [] });
    }
    phaseMap.get(code).steps.push(step);
  }
  const phases = EXECUTION_PHASE_DEFINITIONS
    .map((definition) => {
      const entry = phaseMap.get(definition.code) ?? { stage: null, steps: [] };
      return { definition, ...entry };
    })
    .filter((phase) => phase.steps.length > 0 || Boolean(phase.stage))
    .map((phase, index) => ({ ...phase, index }));

  return `
    <details class="execution-details">
      <summary>
        <span class="execution-summary-title">${icon('workflow', '分析步骤')}分析步骤</span>
        <b class="execution-summary-duration">${formatDurationSeconds(duration)}</b>
        ${summaryMeta ? `<span class="execution-summary-meta">${summaryMeta}</span>` : ''}
        <small>${fingerprint ? `指纹 ${escapeHtml(fingerprint)}` : ''}</small>
      </summary>
      <div class="execution-detail-body">
        <div class="execution-phase-list">
          ${phases.map(renderExecutionPhase).join('')}
        </div>
        ${discardedSteps.length > 0 ? `
          <details class="execution-attempts">
            <summary>查看 ${discardedSteps.length} 次失败或废弃尝试</summary>
            ${discardedSteps.map((step) => `
              <div>
                <span>${escapeHtml(step.status ?? '')}</span>
                <small>${escapeHtml(step.title ?? step.name)}：${escapeHtml(step.detail ?? '')}</small>
              </div>
            `).join('')}
          </details>
        ` : ''}
      </div>
      <div class="execution-detail-note">阶段结果和工具参数可展开 review，不展示模型私有思维链。</div>
    </details>
  `;
}

function bindExampleQuestions() {
  document.querySelectorAll('[data-question]').forEach((button) => {
    button.addEventListener('click', () => {
      document.getElementById('questionInput').value = button.dataset.question;
      runQuestion();
    });
  });
}

function bindChatActions() {
  document.querySelectorAll('[data-open-artifact]').forEach((button) => {
    button.addEventListener('click', () => {
      openWorkspaceArtifactFromChat(button.dataset.openArtifact);
    });
  });
  document.querySelectorAll('[data-open-process-artifact]').forEach((button) => {
    button.addEventListener('click', () => {
      openWorkspaceArtifact(button.dataset.openProcessArtifact);
    });
  });
  document.querySelectorAll('[data-semantic-plan]').forEach((button) => {
    button.addEventListener('click', () => {
      const message = state.chatMessages.find(
        (item) => item.result?.semanticParse?.planId === button.dataset.semanticPlan,
      );
      if (message?.result?.semanticParse) {
        openSemanticParseDrawer(message.result.semanticParse);
      }
    });
  });
  document.querySelectorAll('[data-feedback]').forEach((button) => {
    button.addEventListener('click', () => {
      const messageId = button.dataset.messageId;
      if (button.dataset.feedback === 'up') {
        submitFeedback(messageId, true);
      } else {
        openFeedbackEditor(messageId);
      }
    });
  });
  document.querySelectorAll('[data-copy-fingerprint]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await copyText(button.dataset.copyFingerprint);
        toast('查询指纹已复制');
      } catch (error) {
        toast(`复制失败：${error.message}`, 'error');
      }
    });
  });
  document.querySelectorAll('[data-clarification-option]').forEach((button) => {
    button.addEventListener('click', () => {
      submitClarificationOption(
        button.dataset.messageId,
        button.dataset.clarificationOption,
      );
    });
  });
}

async function submitClarificationOption(messageId, optionId) {
  if (optionId === 'cancel') {
    toast('已停止本轮查询');
    return;
  }
  const sourceMessage = state.chatMessages.find(
    (message) => String(message.id) === String(messageId),
  );
  const question = sourceMessage?.result?.question
    ?? sourceMessage?.result?.resolvedQuestion
    ?? sourceMessage?.content;
  if (!question) {
    toast('未找到原始问题，无法继续', 'error');
    return;
  }
  const input = document.getElementById('questionInput');
  if (input) {
    input.value = question;
  }
  await runQuestion({
    clarificationOptionId: optionId,
  });
}

async function copyText(value) {
  const text = String(value ?? '');
  if (!text) {
    throw new Error('没有可复制的内容');
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for browsers that restrict the Clipboard API on localhost.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) {
    throw new Error('当前浏览器不允许访问剪贴板');
  }
}

function openSemanticParseDrawer(parse) {
  const filters = parse.filters ?? [];
  const issues = parse.validation?.issues ?? [];
  const provenance = formatProvenance(parse.mappingProvenance);
  const matchedEntity = parse.matchedDataset
    ? {
      type: '业务数据集',
      name: parse.matchedDataset.name,
      code: `${parse.matchedDataset.schemaName}.${parse.matchedDataset.tableName}`,
    }
    : {
      type: '指标',
      name: parse.matchedIndicator?.name ?? '-',
      code: parse.matchedIndicator?.id ?? '',
    };
  openModal({
    title: '语义解析与执行证据',
    wide: true,
    body: `
      <div class="parse-drawer-grid">
        <section class="parse-drawer-block">
          <h3>① ${escapeHtml(matchedEntity.type)}匹配</h3>
          <div class="detail-item">
            <span>命中${escapeHtml(matchedEntity.type)}</span>
            <strong>${escapeHtml(matchedEntity.name)}</strong>
            <small class="mono">${escapeHtml(matchedEntity.code)}</small>
          </div>
        </section>
        <section class="parse-drawer-block">
          <h3>② 语义字段</h3>
          <div class="parse-chip-line"><b>指标</b>${(parse.metrics ?? []).map((item) => `<span class="tag tag-blue">${escapeHtml(item)}</span>`).join('') || '<span class="muted">无</span>'}</div>
          <div class="parse-chip-line"><b>维度</b>${(parse.dimensions ?? []).map((item) => `<span class="tag tag-teal">${escapeHtml(item)}</span>`).join('') || '<span class="muted">汇总</span>'}</div>
        </section>
        <section class="parse-drawer-block span-2">
          <h3>③ 查询条件</h3>
          <div class="data-table-wrap">
            <table class="data-table">
              <thead><tr><th>字段</th><th>操作符</th><th>值</th><th>来源</th></tr></thead>
              <tbody>
                ${filters.map((filter) => `
                  <tr>
                    <td class="mono">${escapeHtml(filter.bizName)}</td>
                    <td>${escapeHtml(filter.operator)}</td>
                    <td>${escapeHtml(JSON.stringify(filter.value))}</td>
                    <td><span class="tag ${filter.source === 'POLICY' ? 'tag-amber' : 'tag-blue'}">${escapeHtml(filter.origin ?? filter.source)}</span></td>
                  </tr>
                `).join('') || '<tr><td colspan="4">无额外过滤条件</td></tr>'}
              </tbody>
            </table>
          </div>
        </section>
        <section class="parse-drawer-block">
          <h3>④ 计划校验</h3>
          <div class="parse-status ${parse.validation?.valid ? 'is-success' : 'is-error'}">
            ${parse.validation?.valid ? '计划校验通过' : '计划校验失败'}
          </div>
          <div class="parse-issue-list">
            ${issues.map((issue) => `<div>${escapeHtml(issue.level)} · ${escapeHtml(issue.message)}</div>`).join('') || '<span class="muted">无异常</span>'}
          </div>
        </section>
        <section class="parse-drawer-block">
          <h3>⑤ 执行结果</h3>
          <div class="detail-grid">
            ${provenance ? `
              <div class="detail-item span-2 provenance-detail ${provenance.className}">
                <span>口径来源</span>
                <strong>${icon(provenance.iconName, provenance.label)}${escapeHtml(provenance.label)}</strong>
                <p>${escapeHtml(provenance.reason)}</p>
              </div>
            ` : ''}
            <div class="detail-item"><span>执行适配器</span><strong>${escapeHtml(parse.execution?.adapter ?? '-')}</strong></div>
            <div class="detail-item"><span>返回规模</span><strong>${parse.execution?.rowCount ?? 0} 行 / ${parse.execution?.columnCount ?? 0} 列</strong></div>
            <div class="detail-item"><span>行级权限</span><strong>${parse.security?.rowPolicyCount ?? 0} 条</strong></div>
            <div class="detail-item"><span>列级权限</span><strong>${parse.security?.columnPolicyCount ?? 0} 条</strong></div>
          </div>
        </section>
        <section class="parse-drawer-block span-2">
          <h3>⑥ 证据摘要</h3>
          <div class="parse-evidence-list">
            ${(parse.evidence ?? []).map((item) => `<div><b>${escapeHtml(item.label)}</b><span>${escapeHtml(item.value)}</span></div>`).join('')}
          </div>
          ${parse.execution?.generatedSql ? `
            <details class="parse-sql">
              <summary>查看平台生成的只读 SQL</summary>
              <pre>${escapeHtml(parse.execution.generatedSql)}</pre>
            </details>
          ` : ''}
        </section>
      </div>
    `,
  });
}

async function submitFeedback(messageId, correct, comment = '', corrected = {}) {
  const message = state.chatMessages.find((item) => String(item.id) === String(messageId));
  if (!message) {
    toast('未找到对应回答', 'error');
    return;
  }
  try {
    await api('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: state.activeSessionId,
        messageId: Number(messageId),
        themeId: message.result?.theme?.id ?? state.selectedThemeId,
        question: message.result?.question,
        correct,
        comment,
        corrected,
      }),
    });
    toast(correct ? '感谢反馈' : '反馈已记录，并进入知识缺口池');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function openFeedbackEditor(messageId) {
  const modal = openModal({
    title: '纠正本次回答',
    body: `
      <div class="form-field">
        <label for="feedbackComment">问题说明</label>
        <textarea class="textarea" id="feedbackComment" placeholder="说明指标、维度、权限或回答内容哪里不正确"></textarea>
      </div>
    `,
    footer: `
      <button class="btn" type="button" data-close-modal>取消</button>
      <button class="btn btn-primary" type="button" id="submitFeedbackBtn">提交纠正</button>
    `,
  });
  modal.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', closeModal);
  });
  modal.querySelector('#submitFeedbackBtn').addEventListener('click', async (event) => {
    const comment = modal.querySelector('#feedbackComment').value.trim();
    setBusy(event.currentTarget, true, '提交中');
    await submitFeedback(messageId, false, comment);
    closeModal();
  });
}

function stopQuestion() {
  if (!state.chatAbortController) {
    return;
  }
  state.chatAbortController.abort();
  toast('正在停止生成');
}

async function runQuestion({ clarificationOptionId = '' } = {}) {
  const input = document.getElementById('questionInput');
  const question = input?.value.trim();
  if (!question || state.chatLoading) {
    if (!question) {
      toast('请输入业务问题', 'error');
    }
    return;
  }
  stopWelcomePlaceholderRotation();
  if (input) {
    input.placeholder = '继续追问，例如：那按渠道拆开呢';
  }
  const button = document.getElementById('runQueryBtn');
  const stopButton = document.getElementById('stopQueryBtn');
  setBusy(button, true, '');
  if (button) {
    button.hidden = true;
  }
  state.chatAbortController = new AbortController();
  if (stopButton) {
    stopButton.hidden = false;
  }
  try {
    const session = await ensureActiveSession();
    state.chatMessages.push({
      id: `local-${Date.now()}`,
      role: 'user',
      content: question,
      result: {},
      createdAt: new Date().toISOString(),
    });
    state.chatLoading = true;
    state.chatStream = {
      workflow: null,
      processSteps: [],
      warnings: [],
      runtime: null,
      source: null,
      lastEvent: null,
    };
    input.value = '';
    input.style.height = 'auto';
    refreshChatTimeline();
    scrollChatToBottom(true);
    const answer = await streamApi('/api/chat/query/stream', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: session.id,
        themeId: state.selectedThemeId,
        question,
        preferredChart: 'auto',
        modelId: state.selectedModelId ?? null,
        ...(clarificationOptionId ? { clarificationOptionId } : {}),
      }),
      signal: state.chatAbortController.signal,
    }, handleChatStreamEvent);
    state.chatMessages.push({
      id: answer.messageId,
      role: 'assistant',
      content: answer.message,
      result: answer,
      createdAt: new Date().toISOString(),
    });
    await reloadChatSessions();
    await loadWorkspaceForSession();
    refreshSessionList();
  } catch (error) {
    if (error.name === 'AbortError') {
      state.chatMessages.push({
        id: `stopped-${Date.now()}`,
        role: 'assistant',
        content: '已停止本轮生成，已接收的执行过程仍保留在当前会话中。',
        result: {},
        createdAt: new Date().toISOString(),
      });
      return;
    }
    state.chatMessages.push({
      id: `error-${Date.now()}`,
      role: 'assistant',
      content: `本次查询失败：${error.message}`,
      result: { error: error.message },
      createdAt: new Date().toISOString(),
    });
    toast(error.message, 'error');
  } finally {
    state.chatAbortController = null;
    if (stopButton) {
      stopButton.hidden = true;
    }
    state.chatLoading = false;
    state.chatStream = null;
    setBusy(button, false);
    if (button) {
      button.hidden = false;
    }
    refreshChatTimeline(true);
  }
}

let liveUpdateTimer = null;

function scheduleLiveExecutionUpdate() {
  if (liveUpdateTimer) {
    return;
  }
  liveUpdateTimer = setTimeout(() => {
    liveUpdateTimer = null;
    updateLiveExecution();
  }, 80);
}

function updateLiveExecution() {
  const container = document.getElementById('liveExecution');
  if (!container || !state.chatLoading) {
    return;
  }
  const details = container.querySelector('.execution-details');
  const wasOpen = Boolean(details?.open);
  container.innerHTML = renderLiveExecution();
  if (wasOpen) {
    container.querySelector('.execution-details')?.setAttribute('open', '');
  }
  if (isChatNearBottom()) {
    scrollChatToBottom(false);
  }
}

function isChatNearBottom() {
  const scroll = document.getElementById('chatScroll');
  if (!scroll) {
    return false;
  }
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140;
}

function handleChatStreamEvent(event) {
  if (!state.chatStream) {
    state.chatStream = {
      workflow: null,
      processSteps: [],
      warnings: [],
      runtime: null,
      source: null,
      lastEvent: null,
    };
  }
  const stream = state.chatStream;
  stream.lastEvent = event;
  if (event.type === 'workflow_stage' || event.type === 'workflow_finished') {
    stream.workflow = event.workflow ?? stream.workflow;
  } else if (event.type === 'process_step') {
    const index = stream.processSteps.findIndex((step) => step.id === event.step?.id);
    if (index >= 0) {
      stream.processSteps.splice(index, 1, event.step);
    } else if (event.step) {
      stream.processSteps.push(event.step);
    }
  } else if (event.type === 'runtime_selected') {
    stream.runtime = event.runtime;
    stream.source = event.source;
  } else if (event.type === 'execution_selected') {
    stream.source = event.source;
    stream.execution = event.source;
  } else if (event.type === 'warning') {
    if (!stream.warnings.some((warning) => warning.code === event.code)) {
      stream.warnings.push(event);
    }
  } else if (event.type === 'result') {
    stream.workflow = event.workflow ?? stream.workflow;
    stream.processSteps = event.processSteps ?? stream.processSteps;
    stream.runtime = event.runtime ?? stream.runtime;
  } else if (event.type === 'sql') {
    stream.sql = event.sql;
  } else if (event.type === 'workspace_updated') {
    loadWorkspaceForSession().catch(() => {});
  }
  scheduleLiveExecutionUpdate();
}

async function ensureActiveSession() {
  if (state.activeSessionId) {
    return state.chatSessions.find(
      (session) => Number(session.id) === Number(state.activeSessionId),
    ) ?? { id: state.activeSessionId, themeId: state.selectedThemeId };
  }
  const session = await api('/api/chat/sessions', {
    method: 'POST',
    body: JSON.stringify({ themeId: state.selectedThemeId }),
  });
  state.activeSessionId = session.id;
  state.chatSessions.unshift(session);
  refreshSessionList();
  return session;
}

async function reloadChatSessions() {
  state.chatSessions = await api('/api/chat/sessions');
  state.chatLoaded = true;
}

function refreshSessionList() {
  const list = document.getElementById('sessionList');
  if (!list) {
    return;
  }
  list.innerHTML = renderSessionList();
  const countLabel = document.getElementById('sessionCountLabel');
  if (countLabel) {
    countLabel.textContent = `${state.chatSessions.length} 个记忆会话`;
  }
  bindSessionList();
}

function refreshChatTimeline(scrollToBottom = false) {
  const timeline = document.getElementById('chatTimeline');
  if (!timeline) {
    return;
  }
  disposeChatCharts();
  timeline.innerHTML = renderChatTimeline();
  bindExampleQuestions();
  bindChatActions();
  mountChatCharts();
  if (scrollToBottom) {
    scrollChatToBottom(true);
  }
}

function scrollChatToBottom(smooth) {
  requestAnimationFrame(() => {
    const timeline = document.getElementById('chatTimeline');
    const scroll = document.getElementById('chatScroll');
    if (!timeline || !scroll) {
      return;
    }
    scroll.scrollTo({
      top: scroll.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  });
}

function disposeChatCharts() {
  for (const chart of state.chatChartInstances.values()) {
    chart.dispose();
  }
  state.chatChartInstances.clear();
}

function mountChatCharts() {
  if (!window.echarts) {
    return;
  }
  for (const message of state.chatMessages.filter((item) => item.role === 'assistant')) {
    const result = message.result ?? {};
    if (!result.chart || result.chart.type === 'table' || result.chart.type === 'kpi') {
      continue;
    }
    const element = document.getElementById(`chat-chart-${message.id}`);
    if (!element || state.chatChartInstances.has(message.id)) {
      continue;
    }
    const chart = window.echarts.init(element, null, { renderer: 'canvas' });
    chart.setOption(buildChartOption(
      result.chart,
      result.data?.columns ?? [],
      result.data?.rows ?? [],
      result.semanticParse?.timeGrain ?? result.timeGrain,
    ));
    state.chatChartInstances.set(message.id, chart);
  }
}

function buildChartOption(chart, columns, rows, timeGrain = null) {
  const fieldLabel = new Map(columns.map((column) => [
    column.bizName ?? column.name,
    column.name ?? column.bizName,
  ]));
  const xField = chart.xField;
  const yFields = chart.yFields ?? [];
  const seriesField = chart.seriesField;
  const xColumn = columns.find((column) => (
    String(column?.bizName ?? column?.name) === String(xField)
  ));
  const temporalX = Boolean(timeGrain && isTemporalColumn(xColumn));
  const metricColumns = new Map(columns.map((column) => [
    String(column?.bizName ?? column?.name),
    column,
  ]));
  const seriesColumns = new Map();

  if (chart.type === 'pie') {
    const metric = yFields[0];
    const metricColumn = metricColumns.get(String(metric));
    return {
      tooltip: {
        trigger: 'item',
        valueFormatter: (value) => (
          metricColumn?.presentationType
            ? formatPresentationText(value, metricColumn)
            : formatNumber(value)
        ),
      },
      legend: { bottom: 4, type: 'scroll' },
      color: ['#4c7ef3', '#9db9ef', '#cdd9f3', '#7f6fd4', '#8d9ba9', '#1ea678'],
      series: [{
        type: 'pie',
        radius: ['38%', '68%'],
        center: ['50%', '43%'],
        data: rows.map((row) => ({
          name: row?.[xField],
          value: presentationChartValue(row?.[metric], metricColumn),
        })),
        label: { formatter: '{b}\n{d}%', color: '#4b5563' },
        labelLine: { lineStyle: { color: '#dfe2e6' } },
      }],
    };
  }

  const xValues = seriesField
    ? [...new Set(rows.map((row) => row?.[xField]))]
    : rows.map((row) => row?.[xField]);
  const xAxisValues = temporalX
    ? xValues.map((value) => formatTemporalValue(value, timeGrain))
    : xValues;
  const series = seriesField
    ? [...new Set(rows.map((row) => row?.[seriesField]))].flatMap((seriesValue) => (
      yFields.map((field) => {
        const metricColumn = metricColumns.get(String(field));
        const name = yFields.length === 1
          ? String(seriesValue)
          : `${seriesValue} · ${fieldLabel.get(field) ?? field}`;
        seriesColumns.set(name, metricColumn);
        return {
          name,
          type: chart.type,
          smooth: chart.type === 'line',
          showSymbol: chart.type === 'line' && xValues.length <= 20,
          barMaxWidth: 34,
          data: xValues.map((xValue) => {
            const row = rows.find((item) => (
              String(item?.[xField]) === String(xValue)
              && String(item?.[seriesField]) === String(seriesValue)
            ));
            return presentationChartValue(row?.[field], metricColumn);
          }),
        };
      })
    ))
    : yFields.map((field) => {
      const metricColumn = metricColumns.get(String(field));
      const name = fieldLabel.get(field) ?? field;
      seriesColumns.set(name, metricColumn);
      return {
        name,
        type: chart.type,
        smooth: chart.type === 'line',
        showSymbol: chart.type === 'line' && rows.length <= 20,
        areaStyle: chart.type === 'line' && yFields.length === 1
          ? { color: 'rgba(76,126,243,0.14)' }
          : undefined,
        data: rows.map((row) => presentationChartValue(row?.[field], metricColumn)),
      };
    });
  const chartAxisColumn = yFields.length === 1
    ? metricColumns.get(String(yFields[0]))
    : null;

  return {
    color: ['#4c7ef3', '#9db9ef', '#cdd9f3', '#7f6fd4', '#8d9ba9', '#1ea678'],
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const items = Array.isArray(params) ? params : [params];
        const title = temporalX
          ? formatTemporalValue(items[0]?.axisValue, timeGrain)
          : items[0]?.axisValue;
        return [
          escapeHtml(title),
          ...items.map((item) => {
            const column = seriesColumns.get(String(item.seriesName));
            const value = column?.presentationType
              ? formatPresentationText(item.value, column)
              : formatNumber(item.value);
            return `${item.marker}${escapeHtml(item.seriesName)}: ${value}`;
          }),
        ].join('<br/>');
      },
    },
    legend: { top: 2, type: 'scroll' },
    grid: { left: 58, right: 26, top: yFields.length > 1 ? 48 : 24, bottom: 46 },
    xAxis: {
      type: 'category',
      data: xValues,
      axisLine: { lineStyle: { color: '#dfe2e6' } },
      axisLabel: {
        color: '#8b93a1',
        formatter: temporalX
          ? (value) => formatTemporalValue(value, timeGrain)
          : undefined,
        rotate: xAxisValues.some((value) => String(value ?? '').length > 8) ? 28 : 0,
      },
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        color: '#8b93a1',
        formatter: (value) => (
          chartAxisColumn?.presentationType
            ? formatPresentationText(value, chartAxisColumn)
            : formatNumber(value)
        ),
      },
      splitLine: { lineStyle: { color: '#eef0f3' } },
    },
    series,
  };
}
registerQueryHooks({ beforeQueryReset: disposeChatCharts });

export {
  renderQueryPage,
  ensureChatLoaded,
  getExampleQuestions,
  renderSessionList,
  renderSidebarSessions,
  bindSessionList,
  loadChatSession,
  startNewSession,
  loadWorkspaceForSession,
  renderWorkspaceDrawer,
  workspaceArtifactFileMeta,
  bindWorkspaceActions,
  openWorkspaceArtifactFromChat,
  openWorkspaceArtifact,
  downloadWorkspaceArtifact,
  renderChatTimeline,
  renderQuestionAxis,
  bindQuestionAxis,
  renderLiveExecution,
  renderChatMessage,
  renderClarificationOptions,
  renderAssistantContent,
  renderArtifactResultLink,
  EXECUTION_PHASE_DEFINITIONS,
  executionStepStageCode,
  executionPhaseStatus,
  truncateReviewText,
  renderExecutionReview,
  renderExecutionStep,
  renderExecutionPhase,
  renderExecutionDetails,
  bindExampleQuestions,
  bindChatActions,
  submitClarificationOption,
  copyText,
  openSemanticParseDrawer,
  submitFeedback,
  openFeedbackEditor,
  stopQuestion,
  runQuestion,
  liveUpdateTimer,
  scheduleLiveExecutionUpdate,
  updateLiveExecution,
  isChatNearBottom,
  handleChatStreamEvent,
  ensureActiveSession,
  reloadChatSessions,
  refreshSessionList,
  refreshChatTimeline,
  scrollChatToBottom,
  disposeChatCharts,
  mountChatCharts,
  buildChartOption,
};
