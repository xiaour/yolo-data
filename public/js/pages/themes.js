import * as core from '../core/runtime.js';
import { openDatasetFields } from '../components/datasetFields.js';
import { bindThemeStatusToggles, mountThemeStatusBadge } from '../components/themeStatus.js';
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

async function renderThemeEditorPage(root, theme) {
  if (state.themeEditorThemeId && !theme) {
    state.themeEditorThemeId = null;
    navigate('/themes');
    toast('主题不存在或已被删除', 'error');
    return;
  }
  root.innerHTML = '<div class="loading-state"><span class="spinner"></span>正在加载智能体配置</div>';
  const allIndicators = (await api('/api/indicators?limit=2000')).items ?? [];
  const indicatorSource = state.bootstrap?.health?.source?.indicatorSource ?? null;
  const models = await api('/api/models');
  const selectedIds = new Set(theme?.indicatorIds ?? []);
  const selectedSkillCodes = new Set(
    theme?.skillCodes
      ?? state.skills.filter((skill) => skill.defaultEnabled).map((skill) => skill.code),
  );
  const selectedBusinessDatasetIds = new Set(
    (theme?.businessDatasetIds ?? []).map((id) => String(id)),
  );
  const selectedModelIds = new Set(
    (theme?.modelIds ?? []).map((id) => String(id)),
  );
  const effectiveDefaultModelId = theme?.defaultModelId
    ?? [...selectedModelIds][0]
    ?? models.find((model) => model.isDefault)?.id
    ?? models[0]?.id
    ?? null;
  const semanticValueConfig = theme?.semanticValueConfig ?? {};
  document.getElementById('pageTitle').textContent = theme
    ? `编辑「${theme.name}」`
    : '新建智能体';
  document.getElementById('pageSubtitle').textContent = theme
    ? '调整数据范围、运行模型、Skills 和独立提示词'
    : '创建绑定指标、数据集和运行策略的业务智能体';
  root.innerHTML = `
    <div class="theme-editor-page">
      ${isAdminUser() ? sectionTabsMarkup(ASSET_TABS, 'themes', '智能体与模型管理') : ''}
      <header class="theme-editor-page-head">
        <button class="btn btn-quiet" type="button" data-theme-editor-back>
          ${icon('arrow-left', '返回智能体列表')}返回智能体列表
        </button>
        ${theme ? `
        <button class="tag ${theme.status === 0 ? 'tag-red' : 'tag-teal'} theme-status-toggle" type="button"
          id="themeStatusBadge" data-theme-status-toggle="${theme.id}"
          data-theme-status="${theme.status === 0 ? 0 : 1}"
          aria-pressed="${theme.status === 0 ? 'false' : 'true'}"
          title="${theme.status === 0 ? '点击启用该智能体' : '点击停用该智能体'}"
        >${theme.status === 0 ? '已停用' : '已启用'}</button>` : ''}
      </header>
      <div class="theme-editor-page-body">
      <form id="themeForm" class="theme-editor-form">
        <section class="theme-config-section">
          <header class="theme-config-section-head">
            <span class="theme-config-index">01</span>
            <div>
              <h3>基础信息</h3>
              <p>定义智能体在开始问数中展示的名称和说明；启用状态在页面右上角切换。</p>
            </div>
          </header>
          <div class="form-grid">
            <div class="form-field">
              <label for="themeName">主题名称</label>
              <input class="field" id="themeName" value="${escapeAttr(theme?.name ?? '')}" required />
            </div>
            <div class="form-field">
              <label for="themeDefaultChart">默认图表</label>
              <select class="select" id="themeDefaultChart">
                ${['auto', 'line', 'bar', 'pie', 'table'].map((chart) => `<option value="${chart}"${(theme?.defaultChart ?? 'auto') === chart ? ' selected' : ''}>${chart}</option>`).join('')}
              </select>
            </div>
            <div class="form-field span-2">
              <label for="themeDescription">主题说明</label>
              <input class="field" id="themeDescription" value="${escapeAttr(theme?.description ?? '')}" />
            </div>
          </div>
        </section>

        <section class="theme-config-section">
          <header class="theme-config-section-head">
            <span class="theme-config-index">02</span>
            <div>
              <h3>运行模型</h3>
              <p>从统一模型库选择当前智能体可用的多个模型，并指定默认运行模型。</p>
            </div>
          </header>
          <div class="form-grid">
            <div class="form-field">
              <label>可用模型</label>
              <div class="check-grid">
                ${models.map((model) => `
                  <label class="check-item">
                    <input type="checkbox" name="themeModel" value="${model.id}"${selectedModelIds.has(String(model.id)) ? ' checked' : ''} />
                    <span>
                      <strong>${escapeHtml(model.name)}</strong>
                      <small class="muted">${escapeHtml(model.provider)} · ${escapeHtml(model.modelName)}</small>
                    </span>
                  </label>
                `).join('') || '<div class="muted">暂无模型配置，请先在模型管理中新增模型。</div>'}
              </div>
            </div>
            <div class="form-field">
              <label for="themeDefaultModel">默认模型</label>
              <select class="select" id="themeDefaultModel">
                ${models.map((model) => `<option value="${model.id}"${Number(effectiveDefaultModelId) === Number(model.id) ? ' selected' : ''}>${escapeHtml(model.name)}</option>`).join('')}
              </select>
            </div>
          </div>
        </section>

        <section class="theme-config-section">
          <header class="theme-config-section-head">
            <span class="theme-config-index">03</span>
            <div>
              <h3>智能体提示词</h3>
              <p>声明业务词映射、口径规则、分析偏好和回答约束。</p>
            </div>
          </header>
          <div class="form-grid">
            <div class="form-field span-2">
              <label for="themePrompt">智能体独立提示词</label>
              <textarea class="textarea" id="themePrompt">${escapeHtml(theme?.systemPrompt ?? '')}</textarea>
              <small>业务词映射、枚举归并、同义词、默认口径和回答规则必须在本提示词中明确。平台不会在代码中内置测试问题或业务条件。</small>
            </div>
          </div>
        </section>

        <section class="theme-config-section">
          <header class="theme-config-section-head">
            <span class="theme-config-index">04</span>
            <div>
              <h3>数据范围</h3>
              <p>限定智能体可检索的指标语义数据集、业务数据库数据集和可用维度；点击数据集右侧「字段」可直接启用或禁用字段。</p>
            </div>
          </header>
          <div class="form-grid">
          <div class="form-field span-2">
              <label>业务数据库数据集</label>
              <div class="check-grid">
                ${state.businessDatasets.map((dataset) => {
                  const enabledFieldCount = dataset.enabledFieldCount ?? dataset.fieldCount;
                  return `
                  <div class="check-item check-item-action">
                    <label class="check-item-body">
                      <input type="checkbox" name="themeBusinessDataset" value="${dataset.id}"${selectedBusinessDatasetIds.has(String(dataset.id)) ? ' checked' : ''} />
                      <span>
                        <strong>${escapeHtml(dataset.name)}</strong>
                        <small class="muted"> ${escapeHtml(dataset.schemaName)}.${escapeHtml(dataset.primaryTable)} · 启用 <span data-theme-dataset-field-count="${dataset.id}">${enabledFieldCount}</span>/${dataset.fieldCount} 字段</small>
                      </span>
                    </label>
                    <button class="btn btn-quiet btn-small" type="button" data-theme-dataset-fields="${dataset.id}">字段</button>
                  </div>
                `;
                }).join('') || '<div class="muted">暂未接入业务数据库数据集</div>'}
              </div>
            </div>
            <div class="form-field span-2">
              <label for="themeDimensions">允许维度</label>
              <input class="field" id="themeDimensions" value="${escapeAttr((theme?.allowedDimensions ?? []).join(', '))}" placeholder="例如：date, region, channel" />
            </div>
          </div>
        </section>

        <section class="theme-config-section is-emphasis">
          <header class="theme-config-section-head">
            <span class="theme-config-index">05</span>
            <div class="theme-config-section-copy">
              <h3>业务枚举知识初始化</h3>
              <p>基于上方选中的数据范围，初始化业务类型、行业等枚举值，用于用户提问时的精确或近似值匹配。</p>
            </div>
            <button class="btn btn-quiet theme-config-section-action" id="refreshSemanticValuesBtn" type="button"
              ${theme ? '' : 'disabled'}>
              ${icon('refresh', '刷新字段值域')}刷新字段值域
            </button>
          </header>
          <div class="semantic-value-toggles">
            <label class="inline-check">
              <input type="checkbox" id="themeSemanticValuesEnabled"
                ${semanticValueConfig.enabled !== false ? 'checked' : ''} />
              <span>启用业务枚举知识初始化</span>
            </label>
            <label class="inline-check">
              <input type="checkbox" id="themeSemanticValuesAutoDiscover"
                ${semanticValueConfig.autoDiscover !== false ? 'checked' : ''} />
              <span>元数据缺失时允许从指标平台或业务数据集补齐</span>
            </label>
          </div>
          <p class="semantic-value-scope-hint">字段列表会跟随上方数据范围实时预览；初始化值域仍以保存后的主题配置为准。</p>
          <div class="check-grid semantic-value-field-list" id="themeSemanticValueFields">
            <div class="muted">${theme ? '正在读取字段…' : '选择数据范围后自动读取枚举字段。'}</div>
          </div>
        </section>

        <section class="theme-config-section">
          <header class="theme-config-section-head">
            <span class="theme-config-index">06</span>
            <div>
              <h3>指标与 Skills</h3>
              <p>控制智能体可访问的指标白名单，以及分析过程中可启用的能力。</p>
            </div>
          </header>
          <div class="form-grid">
            <div class="form-field span-2">
              <label>主题指标</label>
              <div class="check-grid">
                ${allIndicators.length === 0
                  ? `<div class="muted">${indicatorSource === 'UNAVAILABLE'
                    ? '未接入指标平台，且本地无指标快照，暂无可选指标；智能体仍可正常编辑和保存。'
                    : '暂无可选指标。'}</div>`
                  : allIndicators.map((indicator) => `
                  <label class="check-item">
                    <input type="checkbox" name="themeIndicator" value="${escapeAttr(indicator.id)}"${selectedIds.has(String(indicator.id)) ? ' checked' : ''} />
                    <span>${escapeHtml(indicator.name)}<small class="muted"> ${escapeHtml(indicator.typeName ?? '')}</small></span>
                  </label>
                `).join('')}
              </div>
            </div>
            <div class="form-field span-2">
              <label>智能体 Skills</label>
              <div class="check-grid">
                ${state.skills.map((skill) => `
                  <label class="check-item">
                    <input type="checkbox" name="themeSkill" value="${escapeAttr(skill.code)}"${selectedSkillCodes.has(skill.code) ? ' checked' : ''} />
                  <span>
                    <strong>${escapeHtml(skill.name)}</strong>
                    <small class="muted"> ${escapeHtml(skill.description)}</small>
                    ${skill.source === 'SKILL_MD'
                      ? `<small class="skill-source-badge">外部 SKILL.md · ${escapeHtml((skill.phaseTags ?? []).join(' / ') || 'PLAN')}</small>`
                      : ''}
                  </span>
                  </label>
                `).join('')}
              </div>
              <small>核心指标工具会自动启用；此处可选择趋势、拆解、周期对比、贡献分析和异常检测等能力。</small>
            </div>
          </div>
        </section>

        <section class="theme-config-section">
          <header class="theme-config-section-head">
            <span class="theme-config-index">07</span>
            <div>
              <h3>推荐问题</h3>
              <p>为首次进入该主题的用户提供可直接使用的问数示例。</p>
            </div>
          </header>
          <div class="form-grid">
            <div class="form-field span-2">
              <label for="themeExamples">推荐问题</label>
              <textarea class="textarea" id="themeExamples" placeholder="每行一个问题">${escapeHtml((theme?.examples ?? []).join('\n'))}</textarea>
            </div>
          </div>
        </section>
      </form>
      </div>
      <footer class="theme-editor-page-actions">
        <button class="btn" type="button" data-theme-editor-back>取消</button>
        <button class="btn btn-primary" type="button" id="saveThemeBtn">${icon('saved', '保存主题')}保存主题</button>
      </footer>
    </div>
  `;
  bindSectionTabs(root, navigate, {
    onActiveTab: (tabId) => {
      if (tabId === 'themes') {
        navigate('/themes');
      }
    },
  });
  const modal = root.querySelector('.theme-editor-page');
  modal.querySelectorAll('[data-theme-editor-back]').forEach((button) => (
    button.addEventListener('click', () => navigate('/themes'))
  ));
  modal.querySelector('#themeForm').addEventListener('submit', (event) => {
    event.preventDefault();
  });
  // 顶部状态开关是真实开关：点击即调用状态接口启用/停用，不影响表单里未保存的其它编辑。
  mountThemeStatusBadge(modal);
  const semanticValueFields = modal.querySelector('#themeSemanticValueFields');
  let semanticValueFieldsLoaded = false;
  const selectedSemanticSourceScope = () => {
    const indicatorIds = new Set(
      [...modal.querySelectorAll('[name="themeIndicator"]:checked')]
        .map((input) => String(input.value)),
    );
    const businessDatasetIds = new Set(
      [...modal.querySelectorAll('[name="themeBusinessDataset"]:checked')]
        .map((input) => String(input.value)),
    );
    if (theme?.primaryBusinessDatasetId) {
      businessDatasetIds.add(String(theme.primaryBusinessDatasetId));
    }
    return { indicatorIds, businessDatasetIds };
  };
  const isSemanticFieldInScope = (key) => {
    const [sourceType, sourceId, ...fieldParts] = String(key).split(':');
    if (!sourceType || !sourceId || fieldParts.join(':') === '') {
      return false;
    }
    const { indicatorIds, businessDatasetIds } = selectedSemanticSourceScope();
    if (sourceType.toUpperCase() === 'INDICATOR') {
      return indicatorIds.size === 0 || indicatorIds.has(sourceId);
    }
    if (sourceType.toUpperCase() === 'DATASET') {
      return businessDatasetIds.size === 0 || businessDatasetIds.has(sourceId);
    }
    return false;
  };
  const collectSemanticValueConfig = () => {
    const fields = semanticValueFieldsLoaded
      ? {}
      : Object.fromEntries(
        Object.entries(theme?.semanticValueConfig?.fields ?? {})
          .filter(([key]) => isSemanticFieldInScope(key)),
      );
    semanticValueFields.querySelectorAll('[data-semantic-fields]').forEach((input) => {
      let keys = [];
      try {
        keys = JSON.parse(input.dataset.semanticFields ?? '[]');
      } catch {
        keys = [];
      }
      keys.forEach((key) => {
        fields[key] = input.checked;
      });
    });
    return {
      enabled: modal.querySelector('#themeSemanticValuesEnabled').checked,
      autoDiscover: modal.querySelector('#themeSemanticValuesAutoDiscover').checked,
      fields: Object.fromEntries(
        Object.entries(fields).filter(([key]) => isSemanticFieldInScope(key)),
      ),
    };
  };
  const renderSemanticValueFields = (result, draftFields = {}) => {
    const fields = (result?.fields ?? []).map((field) => {
      const hasDraftValue = Object.prototype.hasOwnProperty.call(draftFields, field.key);
      return {
        ...field,
        configured: hasDraftValue || field.configured,
        enabled: hasDraftValue ? draftFields[field.key] !== false : field.enabled,
      };
    });
    semanticValueFieldsLoaded = true;
    if (fields.length === 0) {
      semanticValueFields.innerHTML = '<div class="muted">当前数据范围暂未发现可配置的业务枚举字段。</div>';
      return;
    }
    const groups = new Map();
    for (const field of fields) {
      const groupKey = String(field.displayName ?? field.fieldName ?? '')
        .trim()
        .toLowerCase();
      const group = groups.get(groupKey) ?? {
        groupKey,
        fields: [],
      };
      group.fields.push(field);
      groups.set(groupKey, group);
    }
    const groupedFields = [...groups.values()].map((group) => {
      const first = group.fields[0];
      const sourceNames = [...new Set(
        group.fields.map((field) => String(field.sourceName ?? '')).filter(Boolean),
      )];
      const fieldNames = [...new Set(
        group.fields.map((field) => field.fieldName).filter(Boolean),
      )];
      const sampleValues = [...new Set(
        group.fields.flatMap((field) => field.sampleValues ?? []),
      )].slice(0, 8);
      const sourceTypes = [...new Set(
        group.fields.map((field) => field.sourceType),
      )];
      return {
        ...first,
        keys: group.fields.map((field) => field.key),
        sourceNames,
        fieldNames,
        sourceLabel: sourceTypes
          .map((sourceType) => (sourceType === 'INDICATOR' ? '指标' : '数据集'))
          .join(' / '),
        enabledCount: group.fields.filter((field) => field.enabled).length,
        initializedCount: group.fields.filter((field) => field.initialized).length,
        valueCount: Math.max(...group.fields.map((field) => Number(field.valueCount) || 0)),
        sampleValues,
      };
    });
    semanticValueFields.innerHTML = groupedFields.map((field) => {
      const sourceSummary = field.sourceNames.length > 1
        ? `${field.sourceNames[0]} 等 ${field.sourceNames.length} 个来源`
        : field.sourceNames[0] ?? field.sourceName;
      const sourceStatus = field.keys.length > 1
        ? ` · ${field.enabledCount}/${field.keys.length} 已启用`
        : '';
      const fieldSummary = field.fieldNames.length > 1
        ? `${field.fieldNames[0]} 等 ${field.fieldNames.length} 个字段`
        : field.fieldNames[0] ?? field.fieldName;
      const status = field.initializedCount > 0
        ? `${field.valueCount} 个值${sourceStatus}`
        : `尚未初始化${sourceStatus}`;
      const sample = field.sampleValues.length
        ? ` · 示例：${field.sampleValues.join('、')}`
        : '';
      return `
        <label class="check-item semantic-value-field" title="${escapeAttr(`${field.displayName} · ${field.fieldNames.join('、')} · ${field.sourceNames.join('、')}${sample}`)}">
          <input type="checkbox"
            data-semantic-fields="${escapeAttr(JSON.stringify(field.keys))}"
            ${field.enabledCount > 0 ? 'checked' : ''} />
          <span>
            <strong>${escapeHtml(field.displayName)}</strong>
            <small class="muted">${escapeHtml(field.sourceLabel)} · ${escapeHtml(sourceSummary)} · ${escapeHtml(fieldSummary)} · ${escapeHtml(status)}</small>
          </span>
        </label>
      `;
    }).join('');
  };
  let semanticPreviewTimer = null;
  let semanticPreviewSequence = 0;
  const loadSemanticValuePreview = async () => {
    clearTimeout(semanticPreviewTimer);
    const sequence = ++semanticPreviewSequence;
    const semanticConfig = collectSemanticValueConfig();
    const { indicatorIds, businessDatasetIds } = selectedSemanticSourceScope();
    semanticValueFields.innerHTML = '<div class="muted">正在根据当前数据范围读取业务枚举字段…</div>';
    try {
      const result = await api('/api/semantic-values/preview', {
        method: 'POST',
        body: JSON.stringify({
          themeId: theme?.id ?? null,
          indicatorIds: [...indicatorIds],
          businessDatasetIds: [...businessDatasetIds],
          semanticValueConfig: semanticConfig,
          systemPrompt: modal.querySelector('#themePrompt').value.trim(),
        }),
      });
      if (sequence !== semanticPreviewSequence) {
        return;
      }
      renderSemanticValueFields(result, semanticConfig.fields);
    } catch (error) {
      if (sequence === semanticPreviewSequence) {
        semanticValueFields.innerHTML = `<div class="muted">字段读取失败：${escapeHtml(error.message)}</div>`;
      }
    }
  };
  const scheduleSemanticValuePreview = (delay = 220) => {
    clearTimeout(semanticPreviewTimer);
    semanticPreviewTimer = setTimeout(loadSemanticValuePreview, delay);
  };
  modal.querySelectorAll('[name="themeIndicator"], [name="themeBusinessDataset"]')
    .forEach((input) => input.addEventListener('change', () => scheduleSemanticValuePreview()));
  const refreshThemeDatasetFieldCount = async (datasetId) => {
    const node = modal.querySelector(`[data-theme-dataset-field-count="${datasetId}"]`);
    if (!node) {
      return;
    }
    try {
      const fields = await api(`/api/business-datasets/${datasetId}/fields`);
      node.textContent = String(fields.filter((field) => field.enabled !== false).length);
    } catch {
      // Keep the previous count; the field panel already surfaced the failure.
    }
  };
  modal.querySelectorAll('[data-theme-dataset-fields]').forEach((button) => {
    button.addEventListener('click', () => openDatasetFields(button.dataset.themeDatasetFields, {
      onChange: () => {
        refreshThemeDatasetFieldCount(button.dataset.themeDatasetFields);
        scheduleSemanticValuePreview();
      },
    }));
  });
  loadSemanticValuePreview();
  modal.querySelector('#refreshSemanticValuesBtn').addEventListener('click', async (event) => {
    if (!theme) {
      return;
    }
    setBusy(event.currentTarget, true, '刷新中');
    try {
      await api(`/api/themes/${theme.id}/semantic-values`, {
        method: 'PUT',
        body: JSON.stringify(collectSemanticValueConfig()),
      });
      const result = await api(`/api/themes/${theme.id}/semantic-values/refresh`, {
        method: 'POST',
      });
      renderSemanticValueFields(result, collectSemanticValueConfig().fields);
      toast(result.warnings?.length
        ? `字段值域已刷新，${result.warnings.length} 个来源需要关注`
        : '字段值域已刷新');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(event.currentTarget, false);
    }
  });
  modal.querySelector('#saveThemeBtn').addEventListener('click', async (event) => {
    const payload = {
      name: modal.querySelector('#themeName').value.trim(),
      description: modal.querySelector('#themeDescription').value.trim(),
      systemPrompt: modal.querySelector('#themePrompt').value.trim(),
      allowedDimensions: modal.querySelector('#themeDimensions').value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      indicatorIds: [...modal.querySelectorAll('[name="themeIndicator"]:checked')]
        .map((input) => input.value),
      businessDatasetIds: [...modal.querySelectorAll('[name="themeBusinessDataset"]:checked')]
        .map((input) => Number(input.value)),
      modelIds: [...modal.querySelectorAll('[name="themeModel"]:checked')]
        .map((input) => Number(input.value)),
      defaultModelId: Number(modal.querySelector('#themeDefaultModel').value),
      skillCodes: [...modal.querySelectorAll('[name="themeSkill"]:checked')]
        .map((input) => input.value),
      semanticValueConfig: collectSemanticValueConfig(),
      semanticPolicy: theme?.semanticPolicy ?? {},
      examples: modal.querySelector('#themeExamples').value
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean),
      llmConfig: theme?.llmConfig ?? {},
      defaultChart: modal.querySelector('#themeDefaultChart').value,
      // 启用状态由页面右上角开关即时保存；这里带上当前值，避免整体保存时被回退。
      status: Number(modal.querySelector('#themeStatusBadge')?.dataset.themeStatus ?? 1),
    };
    setBusy(event.currentTarget, true, '保存中');
    try {
      await api(theme ? `/api/themes/${theme.id}` : '/api/themes', {
        method: theme ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      toast('主题已保存');
      await loadBootstrap(state.currentUser.id);
      navigate('/themes');
    } catch (error) {
      toast(error.message, 'error');
      setBusy(event.currentTarget, false);
    }
  });
}



export {
  renderThemesPage,
  renderThemeTable,
  openThemeEditor,
  renderThemeEditorPage,
};
