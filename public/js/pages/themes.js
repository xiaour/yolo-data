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

async function renderThemesPage(root) {
  if (state.currentUser.role !== 'ADMIN') {
    root.innerHTML = `<div class="section-band">${emptyState('主题配置仅对平台管理员开放', 'shield-check')}</div>`;
    return;
  }
  root.innerHTML = `
    <div class="page-stack">
      <div class="page-toolbar">
        <div class="section-head">
          <div><h2>主题智能体</h2><p>每个主题独立限定指标范围、分析维度和回答策略。</p></div>
          <button class="btn btn-primary" id="addThemeBtn" type="button">${icon('plus', '新建主题')}新建主题</button>
        </div>
      </div>
      <div>
        ${renderThemeTable()}
      </div>
    </div>
  `;
  document.getElementById('addThemeBtn').addEventListener('click', () => openThemeEditor(null));
  root.querySelectorAll('[data-theme-edit]').forEach((button) => {
    button.addEventListener('click', () => openThemeEditor(
      state.themes.find((theme) => Number(theme.id) === Number(button.dataset.themeEdit)),
    ));
  });
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

function renderThemeTable() {
  if (!state.themes.length) {
    return emptyState('尚未配置主题智能体', 'bot');
  }
  return `
    <div class="theme-cards">
      ${state.themes.map((theme) => `
        <article class="theme-card">
          <div class="theme-card-head">
            <div>
              <strong>${escapeHtml(theme.name)}</strong>
              <small>${escapeHtml(theme.description || '无主题说明')}</small>
            </div>
            <span class="tag ${theme.status ? 'tag-teal' : 'tag-red'}">${theme.status ? '启用' : '停用'}</span>
          </div>
          <div class="theme-card-meta">
            <span><small>数据范围</small><strong>${theme.indicatorIds?.length ?? 0} 指标 / ${theme.businessDatasetIds?.length ?? 0} 数据集</strong></span>
            <span><small>业务规则</small><strong>${semanticPolicyRuleCount(theme.semanticPolicy)} 条</strong></span>
            <span><small>模型</small><strong>${escapeHtml(theme.llmConfig?.model || '平台默认')}</strong></span>
          </div>
          <div class="theme-card-foot">
            <span class="muted">${escapeHtml(formatDate(theme.updatedAt))}</span>
            <span class="theme-card-actions">
              <button class="btn btn-quiet btn-small" data-theme-edit="${theme.id}" type="button">编辑</button>
              <button class="btn btn-quiet btn-small" data-theme-delete="${theme.id}" type="button">删除</button>
            </span>
          </div>
        </article>
      `).join('')}
    </div>
  `;
}

function semanticPolicyRuleCount(policy) {
  if (!policy || typeof policy !== 'object') {
    return 0;
  }
  return ['metrics', 'dimensions', 'filters', 'enumGroups', 'plugins']
    .reduce((sum, key) => sum + (Array.isArray(policy[key]) ? policy[key].length : 0), 0);
}

function openThemeEditor(theme) {
  navigate(theme ? `/themes/${theme.id}` : '/themes/new');
}

function cloneSemanticPolicy(policy = {}) {
  const source = policy && typeof policy === 'object' ? policy : {};
  const copy = (values) => (Array.isArray(values) ? values : []).map((item) => (
    item && typeof item === 'object' ? JSON.parse(JSON.stringify(item)) : item
  ));
  return {
    version: Number(source.version) || 1,
    metrics: copy(source.metrics),
    dimensions: copy(source.dimensions),
    filters: copy(source.filters),
    enumGroups: copy(source.enumGroups ?? source.enums),
    policies: {
      ambiguity: String(source.policies?.ambiguity ?? 'CLARIFY').toUpperCase(),
      allowFuzzyMapping: source.policies?.allowFuzzyMapping === true,
    },
    plugins: copy(source.plugins),
  };
}

function splitPolicyText(value) {
  return [...new Set(String(value ?? '')
    .split(/[,，\n]+/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function policyValueFromText(value) {
  const values = splitPolicyText(value);
  return values.length > 1 ? values : (values[0] ?? '');
}

function policyValueToText(value) {
  return Array.isArray(value) ? value.join(', ') : String(value ?? '');
}

function expressionToText(expression) {
  if (!expression || typeof expression !== 'object') {
    return '';
  }
  const op = String(expression.op ?? expression.operator ?? expression.type ?? '').toUpperCase();
  if (!op || op === 'FIELD' || expression.field) {
    const aggregator = String(expression.aggregator ?? 'SUM').toUpperCase();
    return aggregator === 'SUM'
      ? String(expression.field ?? '')
      : `FIELD:${aggregator}:${expression.field ?? ''}`;
  }
  if (['ABS', 'NEGATE'].includes(op)) {
    return `${op}(${expressionToText(expression.value ?? expression.operand)})`;
  }
  return `${op}(${expressionToText(expression.left)},${expressionToText(expression.right)})`;
}

function expressionFromText(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  const tokens = [];
  for (const match of text.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)(?::([A-Z_]+))?|([(),])/g)) {
    if (match[1] !== undefined) {
      tokens.push({ type: 'name', value: match[1], aggregator: match[2] ?? null });
    } else {
      tokens.push({ type: match[3] });
    }
  }
  let cursor = 0;
  const parse = () => {
    const token = tokens[cursor++];
    if (!token) {
      throw new Error('表达式不完整');
    }
    if (token.type !== 'name') {
      throw new Error(`意外的表达式符号: ${token.type}`);
    }
    const next = tokens[cursor];
    if (next?.type !== '(') {
      if (token.aggregator && !['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNT_DISTINCT'].includes(token.aggregator)) {
        throw new Error(`不支持的聚合方式: ${token.aggregator}`);
      }
      return {
        op: 'FIELD',
        field: token.value,
        aggregator: token.aggregator ?? 'SUM',
      };
    }
    cursor += 1;
    const operator = token.value.toUpperCase();
    if (!['FIELD', 'ADD', 'SUM', 'SUBTRACT', 'DIFFERENCE', 'MULTIPLY', 'DIVIDE', 'RATIO', 'ABS', 'NEGATE'].includes(operator)) {
      throw new Error(`不支持的表达式算子: ${operator}`);
    }
    const args = [];
    while (tokens[cursor]?.type !== ')') {
      if (!tokens[cursor]) {
        throw new Error(`表达式 ${operator} 缺少右括号`);
      }
      if (tokens[cursor].type === ',') {
        cursor += 1;
        continue;
      }
      args.push(parse());
    }
    cursor += 1;
    if (operator === 'ABS' || operator === 'NEGATE') {
      if (args.length !== 1) {
        throw new Error(`${operator} 必须只有一个参数`);
      }
      return { op: operator, value: args[0] };
    }
    if (operator === 'FIELD') {
      throw new Error('FIELD 表达式应直接写字段名');
    }
    if (args.length !== 2) {
      throw new Error(`${operator} 必须有两个参数`);
    }
    return { op: operator, left: args[0], right: args[1] };
  };
  const expression = parse();
  if (cursor !== tokens.length) {
    throw new Error('表达式末尾存在多余内容');
  }
  return expression;
}

function metricRuleMarkup(rule = {}, index) {
  const target = rule.target ?? {};
  const formula = String(target.type ?? 'FORMULA').toUpperCase() === 'FORMULA';
  return `
    <div class="semantic-policy-rule" data-kind="metric">
      <div class="form-grid">
        <div class="form-field"><label>规则标识</label><input class="field" data-policy-id value="${escapeAttr(rule.id ?? '')}" placeholder="metric-1" /></div>
        <div class="form-field"><label>业务概念</label><input class="field" data-metric-concept value="${escapeAttr(rule.concept ?? '')}" placeholder="gross_margin" /></div>
        <div class="form-field span-2"><label>别名</label><input class="field" data-metric-aliases value="${escapeAttr((rule.aliases ?? []).join(', '))}" placeholder="gross_margin, margin_rate" /></div>
        <div class="form-field"><label>排除词</label><input class="field" data-metric-exclude value="${escapeAttr((rule.excludeWhen ?? []).join(', '))}" /></div>
        <div class="form-field"><label>优先级</label><input class="field" type="number" data-metric-priority value="${escapeAttr(rule.priority ?? 0)}" /></div>
        <div class="form-field"><label>描述</label><input class="field" data-metric-description value="${escapeAttr(rule.description ?? '')}" /></div>
        <div class="form-field"><label>目标类型</label>
          <select class="select" data-metric-target>
            <option value="FORMULA"${formula ? ' selected' : ''}>公式指标</option>
            <option value="FIELD"${formula ? '' : ' selected'}>直接字段</option>
          </select>
        </div>
        <div class="form-field"><label class="inline-check"><input type="checkbox" data-metric-exclusive${rule.exclusive !== false ? ' checked' : ''} /><span>唯一口径</span></label></div>
      </div>
      <div class="form-grid metric-target-fields${formula ? ' hidden' : ''}">
        <div class="form-field"><label>基础字段</label><input class="field" data-metric-field value="${escapeAttr(target.field ?? '')}" /></div>
        <div class="form-field"><label>聚合方式</label><input class="field" data-metric-aggregator value="${escapeAttr(target.aggregator ?? 'SUM')}" /></div>
      </div>
      <div class="form-grid metric-formula-fields${formula ? '' : ' hidden'}">
        <div class="form-field"><label>输出字段</label><input class="field" data-metric-output value="${escapeAttr(target.outputField ?? '')}" /></div>
        <div class="form-field"><label>输出格式</label>
          <select class="select" data-metric-format>
            ${['NUMBER', 'PERCENT', 'CURRENCY', 'QUANTITY'].map((item) => (
              `<option value="${item}"${String(target.outputFormat ?? 'NUMBER').toUpperCase() === item ? ' selected' : ''}>${item}</option>`
            )).join('')}
          </select>
        </div>
        <div class="form-field"><label>小数位</label><input class="field" type="number" min="0" max="12" data-metric-precision value="${escapeAttr(target.precision ?? '')}" /></div>
        <div class="form-field span-2"><label>公式表达式</label><input class="field mono" data-metric-expression value="${escapeAttr(expressionToText(target.expression))}" placeholder="DIVIDE(SUBTRACT(revenue,cost),ABS(revenue))" /><small>支持 FIELD、ADD、SUBTRACT、MULTIPLY、DIVIDE、ABS、NEGATE。</small></div>
      </div>
      <button class="btn btn-quiet btn-icon semantic-policy-remove" type="button" title="删除规则">${icon('trash')}</button>
    </div>
  `;
}

function fieldRuleMarkup(rule = {}, kind = 'dimension') {
  return `
    <div class="semantic-policy-rule" data-kind="${kind}">
      <div class="form-grid">
        <div class="form-field"><label>规则标识</label><input class="field" data-policy-id value="${escapeAttr(rule.id ?? '')}" /></div>
        <div class="form-field"><label>业务概念</label><input class="field" data-field-concept value="${escapeAttr(rule.concept ?? '')}" /></div>
        <div class="form-field span-2"><label>别名</label><input class="field" data-field-aliases value="${escapeAttr((rule.aliases ?? []).join(', '))}" /></div>
        <div class="form-field"><label>排除词</label><input class="field" data-field-exclude value="${escapeAttr((rule.excludeWhen ?? []).join(', '))}" /></div>
        <div class="form-field"><label>字段</label><input class="field" data-field-field value="${escapeAttr(rule.field ?? '')}" /></div>
        <div class="form-field"><label>操作符</label>
          <select class="select" data-field-operator>
            ${['IN', 'NOT_IN', '=', '!=', '>', '>=', '<', '<=', 'LIKE', 'BETWEEN'].map((item) => (
              `<option value="${item}"${String(rule.operator ?? 'IN').toUpperCase() === item ? ' selected' : ''}>${item}</option>`
            )).join('')}
          </select>
        </div>
        <div class="form-field span-2"><label>${kind === 'filter' ? '过滤值' : '规则值'}</label><input class="field" data-field-value value="${escapeAttr(policyValueToText(rule.value))}" /></div>
        <div class="form-field span-2"><label>规则来源</label><input class="field" data-field-rule-source value="${escapeAttr(rule.ruleSource ?? '')}" /></div>
      </div>
      <button class="btn btn-quiet btn-icon semantic-policy-remove" type="button" title="删除规则">${icon('trash')}</button>
    </div>
  `;
}

function enumGroupMarkup(group = {}) {
  return `
    <div class="semantic-policy-rule" data-kind="enum">
      <div class="form-grid">
        <div class="form-field"><label>规则标识</label><input class="field" data-policy-id value="${escapeAttr(group.id ?? '')}" /></div>
        <div class="form-field"><label>字段</label><input class="field" data-enum-field value="${escapeAttr(group.field ?? '')}" /></div>
        <div class="form-field"><label>分组名称</label><input class="field" data-enum-name value="${escapeAttr(group.name ?? '')}" /></div>
        <div class="form-field"><label>别名</label><input class="field" data-enum-aliases value="${escapeAttr((group.aliases ?? []).join(', '))}" /></div>
        <div class="form-field span-2"><label>枚举值</label><input class="field" data-enum-values value="${escapeAttr((group.values ?? []).join(', '))}" /></div>
        <div class="form-field"><label class="inline-check"><input type="checkbox" data-enum-exclusive${group.exclusive !== false ? ' checked' : ''} /><span>唯一分组</span></label></div>
      </div>
      <button class="btn btn-quiet btn-icon semantic-policy-remove" type="button" title="删除规则">${icon('trash')}</button>
    </div>
  `;
}

function pluginMarkup(plugin = {}) {
  const config = plugin.config ?? {};
  return `
    <div class="semantic-policy-rule" data-kind="plugin">
      <div class="form-grid">
        <div class="form-field"><label>插件标识</label><input class="field" data-plugin-id value="${escapeAttr(plugin.id ?? '')}" /></div>
        <div class="form-field"><label>相似度阈值</label><input class="field" type="number" min="0" max="1" step="0.01" data-plugin-threshold value="${escapeAttr(config.threshold ?? '')}" /></div>
        <div class="form-field"><label>候选数量</label><input class="field" type="number" min="1" max="50" data-plugin-topn value="${escapeAttr(config.topN ?? '')}" /></div>
        <div class="form-field"><label class="inline-check"><input type="checkbox" data-plugin-enabled${plugin.enabled !== false ? ' checked' : ''} /><span>启用</span></label></div>
      </div>
      <button class="btn btn-quiet btn-icon semantic-policy-remove" type="button" title="删除规则">${icon('trash')}</button>
    </div>
  `;
}

function openSemanticPolicyModal(policy, onSave) {
  const draft = cloneSemanticPolicy(policy);
  const policySection = (title, description, kind, markup, emptyMessage) => `
    <section class="theme-config-section">
      <header class="theme-config-section-head">
        <div><h3>${title}</h3><p>${description}</p></div>
        <button class="btn btn-quiet btn-small" type="button" data-add-policy="${kind}">${icon('plus', '新增规则')}新增</button>
      </header>
      <div class="semantic-policy-list" data-policy-list="${kind}">
        ${markup || `<div class="muted">${emptyMessage}</div>`}
      </div>
    </section>
  `;
  const modal = openModal({
    title: '配置业务语义包',
    wide: true,
    editor: true,
    body: `
      <div class="semantic-policy-form">
        <section class="theme-config-section">
          <header class="theme-config-section-head">
            <div><h3>全局策略</h3><p>控制歧义处理和字段模糊匹配。</p></div>
          </header>
          <div class="form-grid">
            <div class="form-field"><label for="spAmbiguity">歧义策略</label>
              <select class="select" id="spAmbiguity">
                ${['CLARIFY', 'RECOMMEND', 'FAIL'].map((item) => (
                  `<option value="${item}"${draft.policies.ambiguity === item ? ' selected' : ''}>${item}</option>`
                )).join('')}
              </select>
            </div>
            <div class="form-field"><label class="inline-check"><input type="checkbox" id="spAllowFuzzy"${draft.policies.allowFuzzyMapping ? ' checked' : ''} /><span>允许字段模糊匹配</span></label></div>
          </div>
        </section>
        ${policySection('指标规则', '配置指标别名、公式和直接字段映射。', 'metric', draft.metrics.map(metricRuleMarkup).join(''), '暂无指标规则')}
        ${policySection('维度规则', '配置业务维度的别名和字段映射。', 'dimension', draft.dimensions.map((item) => fieldRuleMarkup(item, 'dimension')).join(''), '暂无维度规则')}
        ${policySection('过滤规则', '配置业务术语到过滤字段和枚举值。', 'filter', draft.filters.map((item) => fieldRuleMarkup(item, 'filter')).join(''), '暂无过滤规则')}
        ${policySection('枚举分组', '把多个枚举值归并为一个业务分组。', 'enum', draft.enumGroups.map(enumGroupMarkup).join(''), '暂无枚举分组')}
        ${policySection('分析插件', '配置语义解析、结果分析等插件的参数。', 'plugin', draft.plugins.map(pluginMarkup).join(''), '暂无插件规则')}
      </div>
    `,
    footer: `
      <button class="btn" type="button" data-policy-cancel>取消</button>
      <button class="btn btn-primary" type="button" data-policy-save>${icon('saved', '保存语义包')}保存语义包</button>
    `,
  });

  const body = modal.querySelector('.modal-body');
  const renderList = (kind) => {
    const container = body.querySelector(`[data-policy-list="${kind}"]`);
    const source = draft[kind === 'enum' ? 'enumGroups' : kind === 'metric'
      ? 'metrics'
      : kind === 'plugin'
        ? 'plugins'
        : `${kind}s`];
    const markup = kind === 'metric'
      ? source.map(metricRuleMarkup).join('')
      : kind === 'enum'
        ? source.map(enumGroupMarkup).join('')
        : kind === 'plugin'
          ? source.map(pluginMarkup).join('')
          : source.map((item) => fieldRuleMarkup(item, kind)).join('');
    container.innerHTML = markup || '<div class="muted">暂无规则</div>';
    container.querySelectorAll('.semantic-policy-remove').forEach((button) => {
      button.addEventListener('click', () => {
        const row = button.closest('.semantic-policy-rule');
        const index = [...container.querySelectorAll('.semantic-policy-rule')].indexOf(row);
        source.splice(index, 1);
        renderList(kind);
      });
    });
    container.querySelectorAll('[data-metric-target]').forEach((select) => {
      select.addEventListener('change', () => {
        const row = select.closest('.semantic-policy-rule');
        const formula = select.value === 'FORMULA';
        row.querySelector('.metric-target-fields').classList.toggle('hidden', formula);
        row.querySelector('.metric-formula-fields').classList.toggle('hidden', !formula);
      });
    });
  };
  const arrayFor = (kind) => {
    if (kind === 'metric') {
      return draft.metrics;
    }
    if (kind === 'enum') {
      return draft.enumGroups;
    }
    if (kind === 'plugin') {
      return draft.plugins;
    }
    return draft[kind === 'dimension' ? 'dimensions' : 'filters'];
  };
  body.querySelectorAll('[data-add-policy]').forEach((button) => {
    button.addEventListener('click', () => {
      const kind = button.dataset.addPolicy;
      const id = `${kind}-${Date.now()}`;
      if (kind === 'metric') {
        arrayFor(kind).push({
          id,
          concept: '',
          aliases: [],
          excludeWhen: [],
          priority: 0,
          exclusive: false,
          description: '',
          target: { type: 'FORMULA', outputField: '', outputFormat: 'NUMBER', expression: null },
        });
      } else if (kind === 'enum') {
        arrayFor(kind).push({ id, field: '', name: '', aliases: [], values: [], exclusive: true });
      } else if (kind === 'plugin') {
        arrayFor(kind).push({ id, enabled: true, config: {} });
      } else {
        arrayFor(kind).push({
          id,
          concept: '',
          aliases: [],
          excludeWhen: [],
          priority: 0,
          field: '',
          operator: 'IN',
          value: '',
          ruleSource: '',
        });
      }
      renderList(kind);
    });
  });
  ['metric', 'dimension', 'filter', 'enum', 'plugin'].forEach(renderList);

  modal.querySelector('[data-policy-cancel]').addEventListener('click', closeModal);
  modal.querySelector('[data-policy-save]').addEventListener('click', () => {
    try {
      const collectMetrics = () => [...body.querySelectorAll('[data-policy-list="metric"] .semantic-policy-rule')].map((row) => {
        const formula = row.querySelector('[data-metric-target]').value === 'FORMULA';
        return {
          id: row.querySelector('[data-policy-id]').value.trim(),
          concept: row.querySelector('[data-metric-concept]').value.trim(),
          aliases: splitPolicyText(row.querySelector('[data-metric-aliases]').value),
          excludeWhen: splitPolicyText(row.querySelector('[data-metric-exclude]').value),
          priority: Number(row.querySelector('[data-metric-priority]').value) || 0,
          exclusive: row.querySelector('[data-metric-exclusive]').checked,
          description: row.querySelector('[data-metric-description]').value.trim(),
          target: formula
            ? {
              type: 'FORMULA',
              outputField: row.querySelector('[data-metric-output]').value.trim(),
              outputFormat: row.querySelector('[data-metric-format]').value,
              precision: row.querySelector('[data-metric-precision]').value === ''
                ? null
                : Number(row.querySelector('[data-metric-precision]').value),
              expression: expressionFromText(row.querySelector('[data-metric-expression]').value),
            }
            : {
              type: 'FIELD',
              field: row.querySelector('[data-metric-field]').value.trim(),
              aggregator: row.querySelector('[data-metric-aggregator]').value.trim().toUpperCase(),
            },
        };
      });
      const collectFields = (kind) => [...body.querySelectorAll(`[data-policy-list="${kind}"] .semantic-policy-rule`)].map((row) => ({
        id: row.querySelector('[data-policy-id]').value.trim(),
        concept: row.querySelector('[data-field-concept]').value.trim(),
        aliases: splitPolicyText(row.querySelector('[data-field-aliases]').value),
        excludeWhen: splitPolicyText(row.querySelector('[data-field-exclude]').value),
        priority: 0,
        field: row.querySelector('[data-field-field]').value.trim(),
        operator: row.querySelector('[data-field-operator]').value,
        value: policyValueFromText(row.querySelector('[data-field-value]').value),
        ruleSource: row.querySelector('[data-field-rule-source]').value.trim(),
      }));
      const collectEnums = () => [...body.querySelectorAll('[data-policy-list="enum"] .semantic-policy-rule')].map((row) => ({
        id: row.querySelector('[data-policy-id]').value.trim(),
        field: row.querySelector('[data-enum-field]').value.trim(),
        name: row.querySelector('[data-enum-name]').value.trim(),
        aliases: splitPolicyText(row.querySelector('[data-enum-aliases]').value),
        values: splitPolicyText(row.querySelector('[data-enum-values]').value),
        exclusive: row.querySelector('[data-enum-exclusive]').checked,
      }));
      const collectPlugins = () => [...body.querySelectorAll('[data-policy-list="plugin"] .semantic-policy-rule')].map((row) => ({
        id: row.querySelector('[data-plugin-id]').value.trim(),
        enabled: row.querySelector('[data-plugin-enabled]').checked,
        config: {
          threshold: row.querySelector('[data-plugin-threshold]').value === ''
            ? undefined
            : Number(row.querySelector('[data-plugin-threshold]').value),
          topN: row.querySelector('[data-plugin-topn]').value === ''
            ? undefined
            : Number(row.querySelector('[data-plugin-topn]').value),
        },
      }));
      const nextPolicy = {
        version: draft.version,
        metrics: collectMetrics(),
        dimensions: collectFields('dimension'),
        filters: collectFields('filter'),
        enumGroups: collectEnums(),
        policies: {
          ambiguity: body.querySelector('#spAmbiguity').value,
          allowFuzzyMapping: body.querySelector('#spAllowFuzzy').checked,
        },
        plugins: collectPlugins(),
      };
      onSave?.(nextPolicy);
      closeModal();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
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
  const semanticPolicy = theme?.semanticPolicy ?? {};
  document.getElementById('pageTitle').textContent = theme
    ? `编辑「${theme.name}」`
    : '新建主题智能体';
  document.getElementById('pageSubtitle').textContent = theme
    ? '调整数据范围、运行模型、Skills 和独立提示词'
    : '创建绑定指标、数据集和运行策略的业务智能体';
  root.innerHTML = `
    <div class="theme-editor-page">
      <header class="theme-editor-page-head">
        <button class="btn btn-quiet" type="button" data-theme-editor-back>
          ${icon('arrow-left', '返回主题列表')}返回主题列表
        </button>
        <div class="theme-editor-page-copy">
          <h2>${theme ? `编辑「${escapeHtml(theme.name)}」` : '新建主题智能体'}</h2>
          <p>${theme ? '调整数据范围、模型、Skills 和专属提示词。' : '创建一个绑定指标、数据集和运行策略的业务智能体。'}</p>
        </div>
        <span class="tag ${theme?.status === 0 ? 'tag-red' : 'tag-teal'}">${theme?.status === 0 ? '停用' : '启用'}</span>
      </header>
      <div class="theme-editor-page-body">
      <form id="themeForm" class="theme-editor-form">
        <section class="theme-config-section">
          <header class="theme-config-section-head">
            <span class="theme-config-index">01</span>
            <div>
              <h3>基础信息</h3>
              <p>定义智能体在开始问数中展示的名称、说明和默认状态。</p>
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
            <div class="form-field">
              <label for="themeStatus">状态</label>
              <select class="select" id="themeStatus">
                <option value="1"${theme?.status !== 0 ? ' selected' : ''}>启用</option>
                <option value="0"${theme?.status === 0 ? ' selected' : ''}>停用</option>
              </select>
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
              <h3>业务语义包</h3>
              <p>按主题维护业务术语、别名、计算公式、维度、过滤、枚举组和分析插件；平台核心不包含任何业务词。</p>
            </div>
            <button class="btn btn-quiet theme-config-section-action" id="openSemanticPolicyBtn" type="button">
              ${icon('settings', '配置业务语义包')}配置业务语义包
            </button>
          </header>
          <div class="form-grid">
            <div class="form-field span-2">
              <label>业务语义包</label>
              <div class="detail-list semantic-policy-summary">
                <div class="detail-row">
                  <span>规则数量</span>
                  <strong id="semanticPolicyStatus">${semanticPolicyRuleCount(semanticPolicy)} 条</strong>
                </div>
                <div class="detail-row">
                  <span>规则构成</span>
                  <strong id="semanticPolicySummary">${[
                    `指标 ${semanticPolicy?.metrics?.length ?? 0}`,
                    `维度 ${semanticPolicy?.dimensions?.length ?? 0}`,
                    `过滤 ${semanticPolicy?.filters?.length ?? 0}`,
                    `枚举组 ${semanticPolicy?.enumGroups?.length ?? 0}`,
                    `插件 ${semanticPolicy?.plugins?.length ?? 0}`,
                  ].join(' · ')}</strong>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="theme-config-section">
          <header class="theme-config-section-head">
            <span class="theme-config-index">05</span>
            <div>
              <h3>数据范围</h3>
              <p>限定智能体可检索的指标语义数据集、业务数据库数据集和可用维度。</p>
            </div>
          </header>
          <div class="form-grid">
          <div class="form-field span-2">
              <label>业务数据库数据集</label>
              <div class="check-grid">
                ${state.businessDatasets.map((dataset) => `
                  <label class="check-item">
                    <input type="checkbox" name="themeBusinessDataset" value="${dataset.id}"${selectedBusinessDatasetIds.has(String(dataset.id)) ? ' checked' : ''} />
                    <span>
                      <strong>${escapeHtml(dataset.name)}</strong>
                      <small class="muted"> ${escapeHtml(dataset.schemaName)}.${escapeHtml(dataset.primaryTable)} · ${dataset.fieldCount} 字段</small>
                    </span>
                  </label>
                `).join('') || '<div class="muted">暂未接入业务数据库数据集</div>'}
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
            <span class="theme-config-index">06</span>
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
              <span>元数据缺失时允许从 Supersonic 或业务数据集补齐</span>
            </label>
          </div>
          <p class="semantic-value-scope-hint">字段列表会跟随上方数据范围实时预览；初始化值域仍以保存后的主题配置为准。</p>
          <div class="check-grid semantic-value-field-list" id="themeSemanticValueFields">
            <div class="muted">${theme ? '正在读取字段…' : '选择数据范围后自动读取枚举字段。'}</div>
          </div>
        </section>

        <section class="theme-config-section">
          <header class="theme-config-section-head">
            <span class="theme-config-index">07</span>
            <div>
              <h3>指标与 Skills</h3>
              <p>控制智能体可访问的指标白名单，以及分析过程中可启用的能力。</p>
            </div>
          </header>
          <div class="form-grid">
            <div class="form-field span-2">
              <label>主题指标</label>
              <div class="check-grid">
                ${allIndicators.map((indicator) => `
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
            <span class="theme-config-index">08</span>
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
  const modal = root.querySelector('.theme-editor-page');
  modal.querySelectorAll('[data-theme-editor-back]').forEach((button) => (
    button.addEventListener('click', () => navigate('/themes'))
  ));
  modal.querySelector('#themeForm').addEventListener('submit', (event) => {
    event.preventDefault();
  });
  const semanticPolicyStatus = modal.querySelector('#semanticPolicyStatus');
  let semanticPolicyDraft = cloneSemanticPolicy(semanticPolicy);
  const updateSemanticPolicySummary = () => {
    semanticPolicyStatus.textContent = `${semanticPolicyRuleCount(semanticPolicyDraft)} 条`;
    semanticPolicySummary.textContent = [
      `指标 ${semanticPolicyDraft.metrics.length}`,
      `维度 ${semanticPolicyDraft.dimensions.length}`,
      `过滤 ${semanticPolicyDraft.filters.length}`,
      `枚举组 ${semanticPolicyDraft.enumGroups.length}`,
      `插件 ${semanticPolicyDraft.plugins.length}`,
    ].join(' · ');
  };
  const semanticPolicySummary = modal.querySelector('#semanticPolicySummary');
  modal.querySelector('#openSemanticPolicyBtn').addEventListener('click', () => {
    openSemanticPolicyModal(semanticPolicyDraft, (nextPolicy) => {
      semanticPolicyDraft = cloneSemanticPolicy(nextPolicy);
      updateSemanticPolicySummary();
      toast('业务语义包已更新');
    });
  });
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
      semanticPolicy: semanticPolicyDraft,
      examples: modal.querySelector('#themeExamples').value
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean),
      llmConfig: theme?.llmConfig ?? {},
      defaultChart: modal.querySelector('#themeDefaultChart').value,
      status: Number(modal.querySelector('#themeStatus').value),
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
  semanticPolicyRuleCount,
  openThemeEditor,
  renderThemeEditorPage,
};
