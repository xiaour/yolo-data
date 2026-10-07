import * as core from '../core/runtime.js';

const {
  state,
  icon,
  api,
  toast,
  setBusy,
  loadBootstrap,
  renderPage,
  emptyState,
  escapeHtml,
  formatDate,
  navigate,
} = core;

async function renderSettingsPage(root) {
  if (state.currentUser?.role !== 'ADMIN') {
    root.innerHTML = `<div class="section-band">${emptyState('系统设置仅对平台管理员开放', 'settings')}</div>`;
    return;
  }
  root.innerHTML = '<div class="loading-state"><span class="spinner"></span>正在读取系统设置</div>';
  const settings = await api('/api/settings');
  const supersonic = settings.supersonic ?? {};
  root.innerHTML = `
    <div class="page-stack">
      <div class="section-head">
        <div>
          <h2>系统设置</h2>
          <p>调整平台级数据源和执行策略，保存后立即生效。</p>
        </div>
      </div>

      <section class="section-band">
        <div class="section-head compact">
          <div>
            <h3>指标平台模块</h3>
            <p>启用时先经过实时指标体系检索和口径匹配；停用时跳过指标库，由大模型结合业务数据集、主题提示词和语义包直接执行。</p>
          </div>
          <span class="tag ${supersonic.enabled ? 'tag-teal' : 'tag-red'}">${supersonic.enabled ? '已启用' : '已停用'}</span>
        </div>

        <div class="form-grid settings-form">
          <div class="form-field span-2">
            <label class="inline-check settings-toggle">
              <input type="checkbox" id="supersonicEnabled"${supersonic.enabled ? ' checked' : ''} />
              <span>启用指标平台匹配</span>
            </label>
            <small>停用后，开始问数不再暴露指标检索、指标详情和指标查询工具，转而使用“大模型直连模式”。</small>
          </div>
          <div class="form-field span-2">
            <div class="detail-list">
              <div class="detail-row"><span>连接状态</span><strong>${escapeHtml(supersonic.mode === 'direct-llm' ? '已停用（大模型直连）' : supersonic.configured ? (supersonic.error ? '连接异常' : '已连接') : '未配置')}</strong></div>
              <div class="detail-row"><span>服务地址</span><strong>${escapeHtml(supersonic.baseUrl || '未配置')}</strong></div>
              <div class="detail-row"><span>最近同步</span><strong>${supersonic.lastSyncAt ? `${formatDate(supersonic.lastSyncAt)} · ${supersonic.lastSyncCount ?? 0} 个指标` : '尚无同步记录'}</strong></div>
              <div class="detail-row"><span>错误信息</span><strong>${escapeHtml(supersonic.error || '无')}</strong></div>
            </div>
          </div>
        </div>

        <div class="page-toolbar">
          <button class="btn btn-primary" id="saveSupersonicSettingBtn" type="button">${icon('saved', '保存设置')}保存设置</button>
        </div>
      </section>

      <section class="section-band">
        <div class="section-head compact">
          <div>
            <h3>记忆管理</h3>
            <p>长期记忆按「用户 × 智能体」隔离沉淀，问数时注入上下文补全默认口径。管理员可在这里查看全部用户的记忆并清理无效条目。</p>
          </div>
          <button class="btn" id="openMemoryBtn" type="button">${icon('library', '查看全部用户记忆')}查看全部用户记忆</button>
        </div>
      </section>
    </div>
  `;

  document.getElementById('openMemoryBtn').addEventListener('click', () => {
    state.memoryUserId = null;
    navigate('/memory/all');
  });

  document.getElementById('saveSupersonicSettingBtn').addEventListener('click', async (event) => {
    const enabled = document.getElementById('supersonicEnabled').checked;
    setBusy(event.currentTarget, true, enabled ? '启用中' : '停用中');
    try {
      const result = await api('/api/settings/supersonic', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      toast(result.supersonic?.syncError
        ? `设置已保存，但指标平台同步失败：${result.supersonic.syncError}`
        : `指标平台模块已${enabled ? '启用' : '停用'}`);
      await loadBootstrap(state.currentUser.id);
      renderPage();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(event.currentTarget, false);
    }
  });
}

export {
  renderSettingsPage,
};
