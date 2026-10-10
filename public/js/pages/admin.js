import * as core from '../core/runtime.js';
import { renderDataTable } from '../components/table.js';
import { openDatasetProfiler } from '../components/datasetProfiler.js';
import { openDatasetFields } from '../components/datasetFields.js';
import { openUserEditor } from '../components/userEditor.js';
import { openDatasourceEditor } from '../components/datasourceEditor.js';

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

async function renderPermissionsPage(root) {
  if (state.currentUser.role !== 'ADMIN') {
    root.innerHTML = `<div class="section-band">${emptyState('数据权限配置仅对平台管理员开放', 'shield-check')}</div>`;
    return;
  }
  const users = state.allUsers.length > 0 ? state.allUsers : await api('/api/users');
  state.allUsers = users;
  if (!state.permissionUserId || !users.some((user) => Number(user.id) === Number(state.permissionUserId))) {
    state.permissionUserId = users[0]?.id ?? null;
  }
  root.innerHTML = `
    <div class="editor-page-shell">
      <div class="two-column">
        <aside class="list-pane">
          <div class="list-pane-head">
            <strong>平台用户</strong>
            <span class="list-pane-head-actions">
              <span class="tag">${users.length}</span>
              <button class="btn btn-quiet btn-small" id="addUserBtn" type="button">新增用户</button>
            </span>
          </div>
          <div class="user-list">
            ${users.map((user) => `
              <button class="user-item${Number(user.id) === Number(state.permissionUserId) ? ' is-active' : ''}" data-permission-user="${user.id}" type="button">
                <span class="user-avatar">${escapeHtml(initials(user.displayName))}</span>
                <span class="user-copy"><strong>${escapeHtml(user.displayName)}</strong><small>${escapeHtml(user.username)} · ${escapeHtml(user.role)}${Number(user.status) === 0 ? ' · 已停用' : ''}</small></span>
              </button>
            `).join('')}
          </div>
        </aside>
        <section class="section-band" id="permissionEditor">
          <div class="loading-state"><span class="spinner"></span>正在读取用户权限</div>
        </section>
      </div>
    </div>
  `;
  root.querySelectorAll('[data-permission-user]').forEach((button) => {
    button.addEventListener('click', () => {
      state.permissionUserId = Number(button.dataset.permissionUser);
      renderPermissionsPage(root);
    });
  });
  document.getElementById('addUserBtn').addEventListener('click', () => openUserEditor(null, {
    onSaved: async () => {
      await loadBootstrap(state.currentUser.id);
      renderPage();
    },
  }));
  await loadPermissionEditor();
}

async function renderDatasetsPage(root) {
  if (state.currentUser.role !== 'ADMIN') {
    root.innerHTML = `<div class="section-band">${emptyState('数据集管理仅对平台管理员开放', 'database')}</div>`;
    return;
  }
  root.innerHTML = `<div class="loading-state"><span class="spinner"></span>正在读取数据源和数据集</div>`;
  const [sources, datasets] = await Promise.all([
    api('/api/data-sources'),
    api('/api/business-datasets'),
  ]);
  state.dataSources = sources;
  state.businessDatasets = datasets;
  if (!['datasets', 'sources'].includes(state.datasetTab)) {
    state.datasetTab = 'datasets';
  }
  const tabContent = state.datasetTab === 'datasets'
    ? `
      <div class="dataset-tab-head">
        <div><h2>业务数据集</h2><p>字段语义自动识别，数据集查询只允许 SELECT。</p></div>
        <button class="btn btn-primary" id="addDatasetBtn" type="button">新增数据集</button>
      </div>
      ${renderBusinessDatasetsTable(datasets)}
    `
    : `
      <div class="dataset-tab-head">
        <div><h2>数据源</h2><p>密码使用 AES-GCM 加密保存，连接默认只读。</p></div>
        <button class="btn btn-primary" id="addDatasourceBtn" type="button">新增数据源</button>
      </div>
      ${renderDatasetSourcesTable(sources)}
    `;
  root.innerHTML = `
    <div class="page-stack">
      <section class="section-band">
        <div class="tabs" role="tablist" aria-label="数据集管理分区">
          <button class="tab${state.datasetTab === 'datasets' ? ' is-active' : ''}" data-dataset-tab="datasets" type="button">业务数据集<small>${datasets.length}</small></button>
          <button class="tab${state.datasetTab === 'sources' ? ' is-active' : ''}" data-dataset-tab="sources" type="button">数据源<small>${sources.length}</small></button>
        </div>
        <div class="dataset-tab-body">${tabContent}</div>
      </section>
    </div>
  `;
  root.querySelectorAll('[data-dataset-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.datasetTab = button.dataset.datasetTab;
      renderPage();
    });
  });
  document.getElementById('addDatasourceBtn')?.addEventListener('click', () => {
    openDatasourceEditor({
      api,
      toast,
      openModal,
      closeModal,
      setBusy,
      hydrateIcons,
      loadBootstrap,
      renderPage,
      state,
    });
  });
  document.getElementById('addDatasetBtn')?.addEventListener('click', openDatasetCreator);
  root.querySelectorAll('[data-test-source]').forEach((button) => {
    button.addEventListener('click', async () => {
      setBusy(button, true, '测试中');
      try {
        const result = await api(`/api/data-sources/${button.dataset.testSource}/test`, {
          method: 'POST',
        });
        toast(result.lastTestOk ? '连接成功' : result.lastTestMessage);
        renderPage();
      } catch (error) {
        toast(error.message, 'error');
        setBusy(button, false);
      }
    });
  });
  root.querySelectorAll('[data-sync-dataset]').forEach((button) => {
    button.addEventListener('click', async () => {
      setBusy(button, true, '同步中');
      try {
        const result = await api(`/api/business-datasets/${button.dataset.syncDataset}/sync`, {
          method: 'POST',
        });
        toast(`字段同步完成，共 ${result.fields.length} 个字段`);
        renderPage();
      } catch (error) {
        toast(error.message, 'error');
        setBusy(button, false);
      }
    });
  });
  root.querySelectorAll('[data-dataset-fields]').forEach((button) => {
    button.addEventListener('click', () => openDatasetFields(button.dataset.datasetFields, {
      onChange: () => renderPage(),
    }));
  });
  root.querySelectorAll('[data-sample-dataset]').forEach((button) => {
    button.addEventListener('click', () => sampleDataset(button.dataset.sampleDataset));
  });
  root.querySelectorAll('[data-profile-dataset]').forEach((button) => {
    button.addEventListener('click', () => openDatasetProfiler(button.dataset.profileDataset));
  });
}

function renderBusinessDatasetsTable(datasets) {
  return `
    <div class="data-table-wrap">
      <table class="data-table">
        <thead><tr><th>数据集</th><th>物理表</th><th>字段数</th><th>授权</th><th>最近同步</th><th></th></tr></thead>
        <tbody>
          ${datasets.map((dataset) => `
            <tr>
              <td><strong>${escapeHtml(dataset.name)}</strong><div class="muted mono">${escapeHtml(dataset.code)}</div></td>
              <td class="mono">${escapeHtml(dataset.schemaName)}.${escapeHtml(dataset.primaryTable)}</td>
              <td>${dataset.fieldCount}<div class="muted">启用 ${dataset.enabledFieldCount ?? dataset.fieldCount}</div></td>
              <td><span class="tag ${dataset.canQuery ? 'tag-teal' : 'tag-amber'}">${dataset.canQuery ? '可查询' : '未授权'}</span></td>
              <td>${escapeHtml(formatDate(dataset.lastSyncedAt))}</td>
              <td>
                <button class="btn btn-quiet btn-small" data-sync-dataset="${dataset.id}" type="button">同步结构</button>
                <button class="btn btn-quiet btn-small" data-profile-dataset="${dataset.id}" type="button">智能识别</button>
                <button class="btn btn-quiet btn-small" data-dataset-fields="${dataset.id}" type="button">字段</button>
                <button class="btn btn-quiet btn-small" data-sample-dataset="${dataset.id}" type="button">抽样</button>
              </td>
            </tr>
          `).join('') || '<tr><td colspan="6">暂无业务数据集</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

function renderDatasetSourcesTable(sources) {
  return `
    <div class="data-table-wrap">
      <table class="data-table">
        <thead><tr><th>名称</th><th>类型</th><th>连接</th><th>数据库</th><th>连接测试</th><th></th></tr></thead>
        <tbody>
          ${sources.map((source) => `
            <tr>
              <td><strong>${escapeHtml(source.name)}</strong><div class="muted mono">${escapeHtml(source.code)}</div></td>
              <td><span class="tag tag-blue">${escapeHtml(source.dbType)}</span></td>
              <td class="mono">${escapeHtml(source.host)}:${source.port}</td>
              <td>${escapeHtml(source.databaseName)}</td>
              <td><span class="tag ${source.lastTestOk === true ? 'tag-teal' : source.lastTestOk === false ? 'tag-red' : ''}">${source.lastTestOk === true ? '成功' : source.lastTestOk === false ? '失败' : '未测试'}</span></td>
              <td><button class="btn btn-small" data-test-source="${source.id}" type="button">测试连接</button></td>
            </tr>
          `).join('') || '<tr><td colspan="6">暂无数据源</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
}

function openDatasetCreator() {
  if (state.dataSources.length === 0) {
    toast('请先新增数据源', 'error');
    return;
  }
  const modal = openModal({
    title: '新增业务数据集',
    editor: true,
    body: `
      <div class="form-grid">
        <div class="form-field"><label for="datasetCode">数据集编码</label><input class="field" id="datasetCode" placeholder="sales_performance" /></div>
        <div class="form-field"><label for="datasetName">数据集名称</label><input class="field" id="datasetName" placeholder="销售经营分析" /></div>
        <div class="form-field">
          <label for="datasetSource">数据源</label>
          <select class="select" id="datasetSource">${state.dataSources.map((source) => `<option value="${source.id}">${escapeHtml(source.name)}</option>`).join('')}</select>
        </div>
        <div class="form-field"><label for="datasetSchema">数据库</label><input class="field" id="datasetSchema" value="${escapeAttr(state.dataSources[0].databaseName)}" /></div>
        <div class="form-field span-2"><label for="datasetTable">物理表</label><input class="field mono" id="datasetTable" placeholder="ads_bi_sale_detail_wide_df" /></div>
        <div class="form-field span-2"><label for="datasetDescription">说明</label><textarea class="textarea" id="datasetDescription"></textarea></div>
      </div>
    `,
    footer: `
      <button class="btn" type="button" data-close-modal>取消</button>
      <button class="btn btn-primary" type="button" id="saveDatasetBtn">扫描字段并保存</button>
    `,
  });
  modal.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', closeModal);
  });
  modal.querySelector('#saveDatasetBtn').addEventListener('click', async (event) => {
    setBusy(event.currentTarget, true, '扫描中');
    try {
      await api('/api/business-datasets', {
        method: 'POST',
        body: JSON.stringify({
          code: modal.querySelector('#datasetCode').value.trim(),
          name: modal.querySelector('#datasetName').value.trim(),
          description: modal.querySelector('#datasetDescription').value.trim(),
          datasourceId: Number(modal.querySelector('#datasetSource').value),
          schemaName: modal.querySelector('#datasetSchema').value.trim(),
          primaryTable: modal.querySelector('#datasetTable').value.trim(),
          config: { readonly: true, maxRows: 1000, queryTimeoutMs: 20000 },
        }),
      });
      toast('数据集已创建，字段语义已自动识别');
      closeModal();
      await loadBootstrap(state.currentUser.id);
      renderPage();
    } catch (error) {
      toast(error.message, 'error');
      setBusy(event.currentTarget, false);
    }
  });
}

async function sampleDataset(datasetId) {
  const result = await api(`/api/business-datasets/${datasetId}/sample?limit=20`);
  const columns = result.columns ?? [];
  openModal({
    title: '数据集抽样',
    editor: true,
    body: renderDataTable(
      columns.map((column) => ({
        name: column,
        bizName: column,
        type: 'STRING',
        showType: 'CATEGORY',
      })),
      result.rows ?? [],
    ),
  });
}

async function loadPermissionEditor() {
  const editor = document.getElementById('permissionEditor');
  if (!editor || !state.permissionUserId) {
    return;
  }
  const profile = await api(`/api/users/${state.permissionUserId}/permissions`);
  const indicators = (await api('/api/indicators?limit=2000')).items ?? [];
  state.permissionProfile = profile;
  const user = getUserDisplay(state.permissionUserId);
  const themeGrantMap = new Map(profile.themeGrants.map((grant) => [Number(grant.themeId), grant]));
  const indicatorGrantMap = new Map(profile.indicatorGrants.map((grant) => [String(grant.indicatorId), grant]));
  const datasetGrantMap = new Map(
    (profile.datasetGrants ?? []).map((grant) => [String(grant.datasetId), grant]),
  );

  editor.innerHTML = `
    <div class="section-head">
      <div><h2>${escapeHtml(user?.displayName ?? '用户权限')}</h2><p>${escapeHtml(user?.username ?? '')} · ${escapeHtml(user?.role ?? '')}</p></div>
      <span class="list-pane-head-actions">
        ${user ? `<button class="btn btn-quiet" id="editUserBtn" type="button">${icon('edit', '编辑用户')}编辑用户</button>` : ''}
        <button class="btn btn-primary" id="savePermissionsBtn" type="button">${icon('saved', '保存权限')}保存权限</button>
      </span>
    </div>

    <div class="form-field">
      <label>可访问主题</label>
      <div class="check-grid">
        ${state.themes.map((theme) => {
          const grant = themeGrantMap.get(Number(theme.id));
          return `
            <label class="check-item">
              <input type="checkbox" name="themeGrant" value="${theme.id}" data-manage="${grant?.canManage ? '1' : '0'}"${grant?.canQuery ? ' checked' : ''} />
              <span><strong>${escapeHtml(theme.name)}</strong><small class="muted"> ${escapeHtml(theme.description || '')}</small></span>
            </label>
          `;
        }).join('')}
      </div>
    </div>

    <div class="section-head" style="margin-top:22px">
      <div><h3>指标白名单</h3><p>勾选后只允许访问显式授权指标；全部不勾选时继承主题指标范围。</p></div>
    </div>
    <input class="field permission-search" id="permissionIndicatorSearch" placeholder="搜索指标白名单" />
    <div class="check-grid" id="permissionIndicatorGrid">
      ${indicators.map((indicator) => `
        <label class="check-item" data-permission-search="${escapeAttr(`${indicator.name} ${indicator.bizName} ${indicator.typeName ?? ''}`).toLowerCase()}">
          <input type="checkbox" name="indicatorGrant" value="${escapeAttr(indicator.id)}"${indicatorGrantMap.has(String(indicator.id)) ? ' checked' : ''} />
          <span>${escapeHtml(indicator.name)}<small class="muted"> ${escapeHtml(indicator.typeName ?? '')}</small></span>
        </label>
      `).join('') || '<div class="muted">指标平台暂无可用指标</div>'}
    </div>

    <div class="section-head" style="margin-top:22px">
      <div><h3>业务数据集权限</h3><p>控制用户可以查询哪些 Doris 业务数据集。</p></div>
    </div>
    <div class="check-grid">
      ${state.businessDatasets.map((dataset) => `
        <label class="check-item">
          <input type="checkbox" name="datasetGrant" value="${dataset.id}"${datasetGrantMap.has(String(dataset.id)) ? ' checked' : ''} />
          <span>
            <strong>${escapeHtml(dataset.name)}</strong>
            <small class="muted"> ${escapeHtml(dataset.schemaName)}.${escapeHtml(dataset.primaryTable)}</small>
          </span>
        </label>
      `).join('') || '<div class="muted">尚未接入业务数据集</div>'}
    </div>

    <div class="section-head" style="margin-top:24px">
      <div><h3>行级数据权限</h3><p>规则会覆盖智能体请求中的同字段过滤条件。</p></div>
      <button class="btn" id="addRowPolicyBtn" type="button">${icon('plus', '新增规则')}新增规则</button>
    </div>
    <div class="data-table-wrap">
      <table class="sub-table" id="rowPolicyTable">
        <thead><tr><th>作用主题</th><th>维度业务名</th><th>操作符</th><th>允许值（逗号分隔）</th><th></th></tr></thead>
        <tbody>
          ${(profile.rowPolicies ?? []).map((policy) => renderRowPolicyRow(policy)).join('')}
        </tbody>
      </table>
    </div>

    <div class="section-head" style="margin-top:24px">
      <div><h3>列级数据权限</h3><p>控制查询结果中的字段脱敏或隐藏。</p></div>
      <button class="btn" id="addColumnPolicyBtn" type="button">${icon('plus', '新增规则')}新增规则</button>
    </div>
    <div class="data-table-wrap">
      <table class="sub-table" id="columnPolicyTable">
        <thead><tr><th>作用主题</th><th>字段业务名</th><th>动作</th><th>脱敏值</th><th></th></tr></thead>
        <tbody>
          ${(profile.columnPolicies ?? []).map((policy) => renderColumnPolicyRow(policy)).join('')}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('addRowPolicyBtn').addEventListener('click', () => {
    document.querySelector('#rowPolicyTable tbody').insertAdjacentHTML(
      'beforeend',
      renderRowPolicyRow({}),
    );
    bindPolicyRemoveButtons();
  });
  document.getElementById('addColumnPolicyBtn').addEventListener('click', () => {
    document.querySelector('#columnPolicyTable tbody').insertAdjacentHTML(
      'beforeend',
      renderColumnPolicyRow({}),
    );
    bindPolicyRemoveButtons();
  });
  document.getElementById('savePermissionsBtn').addEventListener('click', savePermissions);
  document.getElementById('editUserBtn')?.addEventListener('click', () => openUserEditor(user, {
    onSaved: async () => {
      await loadBootstrap(state.currentUser.id);
      renderPage();
    },
  }));
  document.getElementById('permissionIndicatorSearch').addEventListener('input', (event) => {
    const keyword = event.target.value.trim().toLowerCase();
    document.querySelectorAll('#permissionIndicatorGrid [data-permission-search]').forEach((item) => {
      item.hidden = Boolean(keyword) && !item.dataset.permissionSearch.includes(keyword);
    });
  });
  bindPolicyRemoveButtons();
}

function renderThemeScopeSelect(selected) {
  return `
    <select class="select" data-policy-theme>
      <option value="">全部主题</option>
      ${state.themes.map((theme) => `<option value="${theme.id}"${Number(theme.id) === Number(selected) ? ' selected' : ''}>${escapeHtml(theme.name)}</option>`).join('')}
    </select>
  `;
}

function renderRowPolicyRow(policy) {
  const operators = ['IN', 'NOT_IN', '=', '!=', '>', '>=', '<', '<=', 'LIKE'];
  return `
    <tr>
      <td>${renderThemeScopeSelect(policy.themeId)}</td>
      <td><input class="field mono" data-policy-dimension value="${escapeAttr(policy.dimension ?? '')}" placeholder="region" /></td>
      <td><select class="select" data-policy-operator>${operators.map((operator) => `<option value="${operator}"${(policy.operator ?? 'IN') === operator ? ' selected' : ''}>${operator}</option>`).join('')}</select></td>
      <td><input class="field" data-policy-values value="${escapeAttr((policy.values ?? []).join(', '))}" placeholder="华东, 华南" /></td>
      <td><button class="btn btn-quiet btn-icon" type="button" data-remove-policy aria-label="删除">${icon('trash', '删除')}</button></td>
    </tr>
  `;
}

function renderColumnPolicyRow(policy) {
  return `
    <tr>
      <td>${renderThemeScopeSelect(policy.themeId)}</td>
      <td><input class="field mono" data-policy-column value="${escapeAttr(policy.columnName ?? '')}" placeholder="customer_phone" /></td>
      <td>
        <select class="select" data-policy-action>
          <option value="MASK"${(policy.action ?? 'MASK') === 'MASK' ? ' selected' : ''}>脱敏</option>
          <option value="HIDE"${policy.action === 'HIDE' ? ' selected' : ''}>隐藏</option>
        </select>
      </td>
      <td><input class="field" data-policy-mask-value value="${escapeAttr(policy.maskValue ?? '***')}" /></td>
      <td><button class="btn btn-quiet btn-icon" type="button" data-remove-policy aria-label="删除">${icon('trash', '删除')}</button></td>
    </tr>
  `;
}

function bindPolicyRemoveButtons() {
  document.querySelectorAll('[data-remove-policy]').forEach((button) => {
    button.onclick = () => button.closest('tr').remove();
  });
}

async function savePermissions(event) {
  const originalThemeGrants = new Map(
    (state.permissionProfile?.themeGrants ?? []).map((grant) => [
      Number(grant.themeId),
      grant,
    ]),
  );
  const themeGrants = [...document.querySelectorAll('[name="themeGrant"]:checked')].map((input) => ({
    themeId: Number(input.value),
    canQuery: true,
    canManage: Boolean(originalThemeGrants.get(Number(input.value))?.canManage),
  }));
  const indicatorGrants = [...document.querySelectorAll('[name="indicatorGrant"]:checked')].map((input) => ({
    indicatorId: input.value,
    canQuery: true,
  }));
  const datasetGrants = [...document.querySelectorAll('[name="datasetGrant"]:checked')].map((input) => ({
    datasetId: Number(input.value),
    canQuery: true,
  }));
  const rowPolicies = [...document.querySelectorAll('#rowPolicyTable tbody tr')].map((row) => ({
    themeId: row.querySelector('[data-policy-theme]').value || null,
    dimension: row.querySelector('[data-policy-dimension]').value.trim(),
    operator: row.querySelector('[data-policy-operator]').value,
    values: row.querySelector('[data-policy-values]').value
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    valueSource: 'FIXED',
    enabled: true,
  })).filter((policy) => policy.dimension);
  const columnPolicies = [...document.querySelectorAll('#columnPolicyTable tbody tr')].map((row) => ({
    themeId: row.querySelector('[data-policy-theme]').value || null,
    columnName: row.querySelector('[data-policy-column]').value.trim(),
    action: row.querySelector('[data-policy-action]').value,
    maskValue: row.querySelector('[data-policy-mask-value]').value,
    enabled: true,
  })).filter((policy) => policy.columnName);

  setBusy(event.currentTarget, true, '保存中');
  try {
    await api(`/api/users/${state.permissionUserId}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({
        themeGrants,
        indicatorGrants,
        datasetGrants,
        rowPolicies,
        columnPolicies,
      }),
    });
    toast('用户数据权限已保存');
    await loadPermissionEditor();
  } catch (error) {
    toast(error.message, 'error');
    setBusy(event.currentTarget, false);
  }
}



export {
  renderPermissionsPage,
  renderDatasetsPage,
  renderBusinessDatasetsTable,
  renderDatasetSourcesTable,
  openDatasourceEditor,
  openDatasetCreator,
  sampleDataset,
  loadPermissionEditor,
  renderThemeScopeSelect,
  renderRowPolicyRow,
  renderColumnPolicyRow,
  bindPolicyRemoveButtons,
  savePermissions,
};
