// Standalone dataset-profiling console (the "智能识别" capability as an
// independent component).
//
// It intentionally does not touch src/agent.js or the contract compiler: it
// only reads suggestions from POST /api/business-datasets/:id/profile and
// writes the accepted subset back through PUT, which lands in the config
// surfaces the existing pipeline already reads (dataset_fields.role /
// dataset_fields.aggregator and business_datasets.config
// .autoLatestDateRange / .autoRangeDays).

import * as core from '../core/runtime.js';

const {
  api,
  toast,
  setBusy,
  openModal,
  closeModal,
  escapeHtml,
  escapeAttr,
  renderPage,
} = core;

const PROFILE_ROLE_OPTIONS = ['TIME', 'METRIC', 'DIMENSION', 'IDENTIFIER'];
const PROFILE_AGGREGATOR_OPTIONS = ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNT_DISTINCT', 'NONE'];

function profileRoleTagClass(role) {
  if (role === 'METRIC') {
    return 'tag-blue';
  }
  if (role === 'TIME') {
    return 'tag-amber';
  }
  if (role === 'IDENTIFIER') {
    return 'tag-red';
  }
  return 'tag-teal';
}

// Standalone "intelligent recognition" console: it reads suggestions from
// POST /profile, lets the admin accept or override them, then writes the
// accepted subset through PUT /profile. The main agent/contract flow is not
// touched - this only fills in the existing role/aggregator/autoRange config.
async function openDatasetProfiler(datasetId) {
  openModal({
    title: '智能识别数据集口径',
    editor: true,
    body: '<div class="loading-state"><span class="spinner"></span>正在抽样分析字段口径，请稍候</div>',
  });
  let profile;
  try {
    profile = await api(`/api/business-datasets/${datasetId}/profile`, {
      method: 'POST',
      body: JSON.stringify({ sampleSize: 50 }),
    });
  } catch (error) {
    closeModal();
    toast(error.message, 'error');
    return;
  }
  const summary = profile.summary ?? {};
  const timeCondition = profile.timeCondition;
  const autoRangeEnabled = profile.dataset?.config?.autoLatestDateRange === true;
  const fields = profile.fields ?? [];
  const modal = openModal({
    title: '智能识别数据集口径',
    editor: true,
    wide: true,
    body: `
      <div class="answer-meta">
        <span class="meta-pill">样本 ${profile.sampleSize ?? 0} 行</span>
        <span class="meta-pill">字段 ${summary.fieldCount ?? fields.length}</span>
        <span class="meta-pill">时间字段 ${summary.timeFieldCount ?? 0}</span>
        <span class="meta-pill">指标 ${summary.metricCount ?? 0}</span>
        <span class="meta-pill">待调整 ${summary.changedCount ?? 0}</span>
      </div>
      <p class="muted">识别结果仅为建议，默认勾选发生变化的字段，未勾选的字段保持原样。应用后写入数据集字段口径与默认时间条件，供智能体直接使用，无需接入指标平台。</p>
      ${profile.degraded ? `<p class="profile-degraded">${escapeHtml(profile.degradedReason ?? '未能读取样本数据，已按字段名与类型降级识别。')} 降级结果置信度较低，请逐项确认。</p>` : ''}
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr><th></th><th>字段</th><th>当前口径</th><th>建议口径（可调整）</th><th>依据</th></tr></thead>
          <tbody>
            ${fields.map((field) => {
              const reasons = [...(field.reasons ?? [])];
              if (field.aggregatorReason) {
                reasons.push(field.aggregatorReason);
              }
              return `
                <tr data-profile-row data-field-name="${escapeAttr(field.fieldName)}"${field.changed ? ' class="profile-changed"' : ''}>
                  <td><input type="checkbox"${field.changed ? ' checked' : ''} /></td>
                  <td class="mono">${escapeHtml(field.fieldName)}<div class="muted">${escapeHtml(field.displayName || '')}</div></td>
                  <td><span class="tag ${profileRoleTagClass(field.currentRole)}">${escapeHtml(field.currentRole)}</span><div class="muted mono">${escapeHtml(field.currentAggregator)}</div></td>
                  <td>
                    <select class="select" data-profile-role style="max-width:112px">
                      ${PROFILE_ROLE_OPTIONS.map((role) => `<option value="${role}"${role === field.suggestedRole ? ' selected' : ''}>${role}</option>`).join('')}
                    </select>
                    <select class="select" data-profile-aggregator style="max-width:132px"${field.suggestedRole === 'METRIC' ? '' : ' disabled'}>
                      ${PROFILE_AGGREGATOR_OPTIONS.map((item) => `<option value="${item}"${item === field.suggestedAggregator ? ' selected' : ''}>${item}</option>`).join('')}
                    </select>
                  </td>
                  <td class="profile-reason">
                    <div>置信度 ${Math.round((field.confidence ?? 0) * 100)}%</div>
                    <div class="muted">${escapeHtml(reasons.join('；') || '数据特征与当前口径一致')}</div>
                  </td>
                </tr>
              `;
            }).join('') || '<tr><td colspan="5">未识别到字段</td></tr>'}
          </tbody>
        </table>
      </div>
      ${timeCondition ? `
        <div class="form-field" style="margin-top:14px">
          <label><input type="checkbox" id="profileAutoRange" checked /> 默认时间条件：未指定时间范围时取最近
            <input class="field" id="profileAutoRangeDays" type="number" min="1" max="3650" value="${timeCondition.autoRangeDays}" style="display:inline-block;width:78px;margin:0 4px" /> 天</label>
          <small>识别时间字段 <span class="mono">${escapeHtml(timeCondition.field)}</span>：${escapeHtml(timeCondition.reason ?? '')}</small>
        </div>
      ` : '<p class="muted">未识别到可用的时间字段，本次不调整默认时间条件。</p>'}
    `,
    footer: `
      <button class="btn" type="button" data-close-modal>取消</button>
      <button class="btn btn-primary" type="button" id="applyDatasetProfileBtn">应用识别结果</button>
    `,
  });
  modal.querySelectorAll('tr[data-profile-row]').forEach((row) => {
    const roleSelect = row.querySelector('[data-profile-role]');
    const aggregatorSelect = row.querySelector('[data-profile-aggregator]');
    roleSelect.addEventListener('change', () => {
      const isMetric = roleSelect.value === 'METRIC';
      aggregatorSelect.disabled = !isMetric;
      if (!isMetric) {
        aggregatorSelect.value = 'NONE';
      } else if (aggregatorSelect.value === 'NONE') {
        aggregatorSelect.value = 'SUM';
      }
    });
  });
  modal.querySelector('#applyDatasetProfileBtn').addEventListener('click', async (event) => {
    const selectedFields = [...modal.querySelectorAll('tr[data-profile-row]')]
      .filter((row) => row.querySelector('input[type="checkbox"]')?.checked)
      .map((row) => {
        const role = row.querySelector('[data-profile-role]').value;
        const aggregator = role === 'METRIC'
          ? row.querySelector('[data-profile-aggregator]').value
          : 'NONE';
        return { fieldName: row.dataset.fieldName, role, aggregator };
      });
    const config = {};
    const autoRangeToggle = modal.querySelector('#profileAutoRange');
    if (autoRangeToggle) {
      if (autoRangeToggle.checked) {
        const days = Number(modal.querySelector('#profileAutoRangeDays').value);
        config.autoLatestDateRange = true;
        config.autoRangeDays = Number.isFinite(days) && days >= 1
          ? Math.round(days)
          : (timeCondition?.autoRangeDays ?? 30);
      } else if (autoRangeEnabled) {
        config.autoLatestDateRange = false;
      }
    }
    if (selectedFields.length === 0 && Object.keys(config).length === 0) {
      toast('请至少勾选一个字段或默认时间条件', 'error');
      return;
    }
    setBusy(event.currentTarget, true, '应用中');
    try {
      const result = await api(`/api/business-datasets/${datasetId}/profile`, {
        method: 'PUT',
        body: JSON.stringify({ fields: selectedFields, config }),
      });
      toast(`已应用 ${result.applied?.fieldCount ?? selectedFields.length} 个字段口径`);
      closeModal();
      renderPage();
    } catch (error) {
      toast(error.message, 'error');
      setBusy(event.currentTarget, false);
    }
  });
}

export { openDatasetProfiler };
