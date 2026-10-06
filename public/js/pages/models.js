import * as core from '../core/runtime.js';
import { ASSET_TABS, bindSectionTabs, sectionTabsMarkup } from '../components/sectionTabs.js';

const {
  state,
  icon,
  api,
  navigate,
  toast,
  openModal,
  closeModal,
  setBusy,
  renderPage,
  emptyState,
  escapeHtml,
  escapeAttr,
  formatDate,
} = core;

function modelEditorMarkup(model = {}) {
  return `
    <div class="form-grid">
      <div class="form-field">
        <label for="modelName">配置名称</label>
        <input class="field" id="modelName" value="${escapeAttr(model.name ?? '')}" placeholder="DeepSeek Flash" required />
      </div>
      <div class="form-field">
        <label for="modelProvider">服务类型</label>
        <select class="select" id="modelProvider">
          ${[
            ['deepseek', 'DeepSeek'],
            ['openai-compatible', 'OpenAI Compatible'],
          ].map(([value, label]) => (
            `<option value="${value}"${String(model.provider ?? 'deepseek') === value ? ' selected' : ''}>${label}</option>`
          )).join('')}
        </select>
      </div>
      <div class="form-field">
        <label for="modelIdentifier">模型标识</label>
        <input class="field mono" id="modelIdentifier" value="${escapeAttr(model.modelName ?? '')}" placeholder="deepseek-chat" required />
      </div>
      <div class="form-field">
        <label for="modelBaseUrl">Base URL</label>
        <input class="field mono" id="modelBaseUrl" value="${escapeAttr(model.baseUrl ?? '')}" placeholder="https://api.deepseek.com/v1" />
      </div>
      <div class="form-field span-2">
        <label for="modelApiKey">API Key</label>
        <input class="field mono" id="modelApiKey" type="password" autocomplete="new-password"
          placeholder="${model.hasApiKey ? '已配置，留空保持不变' : '输入模型 API Key'}" />
        <div class="field-hint-row">
          <small>${model.hasApiKey ? '当前模型已保存密钥，页面不会回显明文。' : '可留空，使用平台环境变量密钥。'}</small>
          ${model.hasApiKey ? `
            <label class="inline-check">
              <input type="checkbox" id="modelClearApiKey" />
              <span>清除已保存密钥</span>
            </label>
          ` : ''}
        </div>
      </div>
      <div class="form-field span-2">
        <label for="modelApiKeyEnv">API Key 环境变量</label>
        <input class="field mono" id="modelApiKeyEnv" value="${escapeAttr(model.apiKeyEnv ?? '')}" placeholder="DEEPSEEK_API_KEY" />
      </div>
      <div class="form-field">
        <label for="modelTemperature">温度</label>
        <input class="field" id="modelTemperature" type="number" min="0" max="2" step="0.1" value="${escapeAttr(model.temperature ?? 0)}" />
      </div>
      <div class="form-field">
        <label for="modelMaxToolRounds">最大工具轮次</label>
        <input class="field" id="modelMaxToolRounds" type="number" min="1" max="50" step="1" value="${escapeAttr(model.maxToolRounds ?? 12)}" />
      </div>
      <div class="form-field">
        <label for="modelTimeoutMs">超时时间（毫秒）</label>
        <input class="field" id="modelTimeoutMs" type="number" min="1000" step="1000" value="${escapeAttr(model.timeoutMs ?? 60000)}" />
      </div>
      <div class="form-field">
        <label class="inline-check"><input type="checkbox" id="modelIsDefault"${model.isDefault ? ' checked' : ''} /><span>设为平台默认模型</span></label>
      </div>
      <div class="form-field">
        <label class="inline-check"><input type="checkbox" id="modelStatus"${model.status !== 0 ? ' checked' : ''} /><span>启用</span></label>
      </div>
    </div>
  `;
}

function openModelEditor(model = null) {
  const currentModel = model ?? {};
  const modal = openModal({
    title: model ? '编辑模型' : '新增模型',
    wide: true,
    editor: true,
    body: modelEditorMarkup(currentModel),
    footer: `
      <button class="btn" type="button" data-model-cancel>取消</button>
      <button class="btn btn-primary" type="button" data-model-save>${icon('saved', '保存模型')}保存模型</button>
    `,
  });
  const value = (selector) => modal.querySelector(selector).value;
  modal.querySelector('[data-model-cancel]').addEventListener('click', closeModal);
  modal.querySelector('[data-model-save]').addEventListener('click', async (event) => {
    const payload = {
      name: value('#modelName').trim(),
      provider: value('#modelProvider'),
      modelName: value('#modelIdentifier').trim(),
      baseUrl: value('#modelBaseUrl').trim(),
      apiKey: value('#modelApiKey').trim(),
      apiKeyEnv: value('#modelApiKeyEnv').trim(),
      temperature: Number(value('#modelTemperature')),
      maxToolRounds: Number(value('#modelMaxToolRounds')),
      timeoutMs: Number(value('#modelTimeoutMs')),
      isDefault: modal.querySelector('#modelIsDefault').checked,
      status: modal.querySelector('#modelStatus').checked ? 1 : 0,
      ...(modal.querySelector('#modelClearApiKey')?.checked ? { clearApiKey: true } : {}),
    };
    setBusy(event.currentTarget, true, '保存中');
    try {
      await api(model ? `/api/models/${model.id}` : '/api/models', {
        method: model ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      toast('模型配置已保存');
      closeModal();
      renderPage();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(event.currentTarget, false);
    }
  });
}

async function renderModelsPage(root) {
  if (state.currentUser?.role !== 'ADMIN') {
    root.innerHTML = `
      <div class="page-stack">
        ${sectionTabsMarkup(ASSET_TABS, 'models', '智能体与模型管理')}
        <div class="section-band">${emptyState('模型管理仅对平台管理员开放', 'brain-circuit')}</div>
      </div>
    `;
    bindSectionTabs(root, navigate);
    return;
  }
  root.innerHTML = '<div class="loading-state"><span class="spinner"></span>正在读取模型配置</div>';
  const models = await api('/api/models');
  state.models = models;
  root.innerHTML = `
    <div class="page-stack">
      ${sectionTabsMarkup(ASSET_TABS, 'models', '智能体与模型管理')}
      <div class="page-toolbar">
        <div class="section-head">
          <div>
            <h2>模型管理</h2>
            <p>统一维护模型服务、密钥来源、运行参数和默认模型；智能体从模型库中选择可用模型。</p>
          </div>
          <button class="btn btn-primary" id="addModelBtn" type="button">${icon('plus', '新增模型')}新增模型</button>
        </div>
      </div>
      <section class="section-band">
        <div class="data-table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>配置名称</th>
                <th>服务</th>
                <th>模型标识</th>
                <th>密钥来源</th>
                <th>运行参数</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${models.map((model) => `
                <tr>
                  <td>
                    <strong>${escapeHtml(model.name)}</strong>
                    ${model.isDefault ? '<span class="tag tag-teal">默认</span>' : ''}
                    ${model.status === 0 ? '<span class="tag tag-red">停用</span>' : ''}
                  </td>
                  <td>${escapeHtml(model.provider || '-')}</td>
                  <td class="mono">${escapeHtml(model.modelName)}</td>
                  <td>${escapeHtml(model.apiKeySource ?? 'NONE')}</td>
                  <td><span class="muted">温度 ${model.temperature ?? 0} · ${model.maxToolRounds ?? 12} 轮</span></td>
                  <td>${escapeHtml(formatDate(model.updatedAt))}</td>
                  <td>
                    <button class="btn btn-quiet btn-small" data-edit-model="${model.id}" type="button">${icon('edit', '编辑')}编辑</button>
                    ${!model.isDefault ? `<button class="btn btn-quiet btn-small" data-default-model="${model.id}" type="button">${icon('saved', '设为默认')}设为默认</button>` : ''}
                    <button class="btn btn-quiet btn-small" data-delete-model="${model.id}" type="button">${icon('trash', '删除')}删除</button>
                  </td>
                </tr>
              `).join('') || '<tr><td colspan="7">暂无模型配置</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `;

  bindSectionTabs(root, navigate);
  document.getElementById('addModelBtn').addEventListener('click', () => openModelEditor());
  root.querySelectorAll('[data-edit-model]').forEach((button) => {
    button.addEventListener('click', () => {
      const model = models.find((item) => Number(item.id) === Number(button.dataset.editModel));
      openModelEditor(model);
    });
  });
  root.querySelectorAll('[data-default-model]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api(`/api/models/${button.dataset.defaultModel}/default`, { method: 'PUT' });
        toast('已设为平台默认模型');
        renderPage();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
  root.querySelectorAll('[data-delete-model]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm('确认删除该模型？已绑定此模型的主题会回退到旧配置。')) {
        return;
      }
      try {
        await api(`/api/models/${button.dataset.deleteModel}`, { method: 'DELETE' });
        toast('模型已删除');
        renderPage();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
}

export {
  renderModelsPage,
};
