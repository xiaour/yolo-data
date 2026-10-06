// 智能体卡片：管理员看到启用开关与编辑入口，分析员看到只读列表和「开始问数」。

import * as core from '../core/runtime.js';

const {
  state,
  icon,
  escapeHtml,
  formatDate,
  emptyState,
} = core;

function isAdminUser() {
  return String(state.currentUser?.role ?? '').toUpperCase() === 'ADMIN';
}

function managedThemes() {
  return state.managedThemes?.length ? state.managedThemes : state.themes;
}

function semanticPolicyRuleCount(policy) {
  if (!policy || typeof policy !== 'object') {
    return 0;
  }
  return ['metrics', 'dimensions', 'filters', 'enumGroups', 'plugins']
    .reduce((sum, key) => sum + (Array.isArray(policy[key]) ? policy[key].length : 0), 0);
}

function renderThemeTable() {
  const canManage = isAdminUser();
  const themes = managedThemes();
  if (!themes.length) {
    return emptyState(
      canManage ? '尚未配置智能体' : '暂无已授权的智能体，请联系管理员开通',
      'bot',
    );
  }
  return `
    <div class="theme-cards">
      ${themes.map((theme) => {
        const enabled = theme.status !== 0;
        return `
        <article class="theme-card${canManage && !enabled ? ' is-disabled' : ''}">
          <div class="theme-card-head">
            <div>
              <strong>${escapeHtml(theme.name)}</strong>
              <small>${escapeHtml(theme.description || '无主题说明')}</small>
            </div>
            ${canManage ? `
            <button class="tag ${enabled ? 'tag-teal' : 'tag-red'} theme-status-toggle" type="button"
              data-theme-status-toggle="${theme.id}" data-theme-status="${enabled ? 1 : 0}"
              aria-pressed="${enabled ? 'true' : 'false'}"
              title="${enabled ? '点击停用该主题' : '点击启用该主题'}">${enabled ? '已启用' : '已停用'}</button>` : ''}
          </div>
          <div class="theme-card-meta">
            <span><small>数据范围</small><strong>${theme.indicatorIds?.length ?? 0} 指标 / ${theme.businessDatasetIds?.length ?? 0} 数据集</strong></span>
            <span><small>业务规则</small><strong>${semanticPolicyRuleCount(theme.semanticPolicy)} 条</strong></span>
            <span><small>模型</small><strong>${escapeHtml(theme.llmConfig?.model || '平台默认')}</strong></span>
          </div>
          <div class="theme-card-foot">
            <span class="muted">${escapeHtml(formatDate(theme.updatedAt))}</span>
            <span class="theme-card-actions">
              ${canManage ? `
              <button class="btn btn-quiet btn-small" data-theme-edit="${theme.id}" type="button">编辑</button>
              <button class="btn btn-quiet btn-small" data-theme-delete="${theme.id}" type="button">删除</button>` : `
              <button class="btn btn-primary btn-small" data-theme-query="${theme.id}" type="button">${icon('sparkles', '开始问数')}开始问数</button>`}
            </span>
          </div>
        </article>
      `;
      }).join('')}
    </div>
  `;
}

export { isAdminUser, managedThemes, renderThemeTable, semanticPolicyRuleCount };
