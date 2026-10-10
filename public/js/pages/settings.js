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
            <p>启用在线指标集成时使用外部指标目录；停用时自动进入本地指标管理，可维护指标、口径、字段和主题挂载关系。</p>
          </div>
          <span class="tag ${supersonic.enabled ? 'tag-teal' : 'tag-blue'}">${supersonic.enabled ? '在线集成' : '本地指标'}</span>
        </div>

        <div class="form-grid settings-form">
          <div class="form-field span-2">
            <label class="inline-check settings-toggle">
              <input type="checkbox" id="supersonicEnabled"${supersonic.enabled ? ' checked' : ''} />
              <span>启用在线指标集成</span>
            </label>
            <small>停用后自动启用本地指标管理，指标列表、详情、新增、编辑和删除功能全部开放。</small>
          </div>
          <div class="form-field span-2">
            <div class="detail-list">
              <div class="detail-row"><span>当前模式</span><strong>${escapeHtml(supersonic.localIndicatorManagement ? `本地指标管理 · ${supersonic.localIndicatorCount ?? 0} 个指标` : supersonic.configured ? (supersonic.error ? '连接异常' : '在线集成') : '在线集成未配置')}</strong></div>
              <div class="detail-row"><span>服务地址</span><strong>${escapeHtml(supersonic.baseUrl || '未配置')}</strong></div>
              <div class="detail-row"><span>最近同步</span><strong>${supersonic.localIndicatorManagement ? '本地指标无需外部同步' : supersonic.lastSyncAt ? `${formatDate(supersonic.lastSyncAt)} · ${supersonic.lastSyncCount ?? 0} 个指标` : '尚无同步记录'}</strong></div>
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
        : enabled
          ? '在线指标集成已启用'
          : '本地指标管理已启用');
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
