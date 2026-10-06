// 记忆管理：会话记忆的查看与清理。
// 普通用户看到自己的全部会话记忆；管理员默认看到所有用户，可按用户筛选。
import * as core from '../core/runtime.js';

const {
  state, icon, escapeHtml, formatDate, formatSessionTime,
  api, toast, emptyState, renderPage, setBusy, openModal,
} = core;

let memoryItems = [];
let memoryUsers = [];

async function renderMemoryPage(root) {
  root.innerHTML = `<div class="loading-state"><span class="spinner"></span>正在读取记忆记录</div>`;
  const isAdmin = state.currentUser?.role === 'ADMIN';
  const filter = state.memoryUserId ? `?userId=${state.memoryUserId}` : '';
  const data = await api(`/api/memories${filter}`);
  memoryItems = data.items ?? [];
  memoryUsers = data.users ?? [];
  const totalMessages = memoryItems.reduce((sum, item) => sum + Number(item.messageCount ?? 0), 0);
  const currentUser = memoryUsers.find((item) => Number(item.id) === Number(state.memoryUserId));
  root.innerHTML = `
    <div class="page-stack">
      <section class="section-band">
        <div class="section-head">
          <div>
            <h2>记忆管理</h2>
            <p>${isAdmin
              ? '会话记忆按「用户 × 智能体」隔离，这里是全部用户的沉淀记录，可查看或清理。'
              : '这里是你在各个智能体下沉淀的会话记忆，可随时查看或清理。'}</p>
          </div>
          <button class="btn" id="refreshMemoryBtn" type="button">${icon('refresh', '刷新')}刷新</button>
        </div>
        ${isAdmin ? `
          <div class="page-toolbar">
            <label class="inline-select">
              <span>用户</span>
              <select class="field" id="memoryUserFilter">
                <option value="">全部用户（${memoryUsers.length}）</option>
                ${memoryUsers.map((item) => `
                  <option value="${escapeHtml(String(item.id))}"${Number(item.id) === Number(state.memoryUserId) ? ' selected' : ''}>
                    ${escapeHtml(item.name)}（${escapeHtml(item.username ?? '')}）
                  </option>
                `).join('')}
              </select>
            </label>
          </div>
        ` : ''}
        <div class="detail-list memory-summary">
          <div class="detail-row"><span>记忆条数</span><strong>${memoryItems.length}</strong></div>
          <div class="detail-row"><span>消息总数</span><strong>${totalMessages}</strong></div>
          <div class="detail-row"><span>范围</span><strong>${escapeHtml(isAdmin ? (currentUser ? currentUser.name : '全部用户') : (state.currentUser?.displayName ?? '本人'))}</strong></div>
        </div>
      </section>
      <section class="section-band">
        ${memoryItems.length === 0
          ? emptyState('暂无会话记忆，去「开始问数」和智能体聊几句就会沉淀在这里', 'scroll-text')
          : renderMemoryTable(memoryItems, isAdmin)}
      </section>
    </div>
  `;
  document.getElementById('refreshMemoryBtn').addEventListener('click', renderPage);
  const userFilter = document.getElementById('memoryUserFilter');
  if (userFilter) {
    userFilter.addEventListener('change', () => {
      state.memoryUserId = userFilter.value ? Number(userFilter.value) : null;
      renderPage();
    });
  }
  root.querySelectorAll('[data-memory-view]').forEach((button) => {
    button.addEventListener('click', () => openMemoryDetail(button.dataset.memoryView));
  });
  root.querySelectorAll('[data-memory-delete]').forEach((button) => {
    button.addEventListener('click', () => deleteMemory(button.dataset.memoryDelete, button));
  });
}

function renderMemoryTable(items, isAdmin) {
  return `
    <div class="data-table-wrap">
      <table class="data-table">
        <thead><tr>
          ${isAdmin ? '<th>用户</th>' : ''}
          <th>智能体</th><th>会话标题</th><th>消息数</th><th>最近更新</th><th>操作</th>
        </tr></thead>
        <tbody>
          ${items.map((item) => `
            <tr>
              ${isAdmin ? `<td>${escapeHtml(item.userName || '-')}</td>` : ''}
              <td>${escapeHtml(item.themeName || '-')}</td>
              <td>${escapeHtml(item.title || '未命名会话')}</td>
              <td>${item.messageCount ?? 0}</td>
              <td>${escapeHtml(formatSessionTime(item.updatedAt) || '-')}</td>
              <td class="memory-actions">
                <button class="btn btn-quiet btn-small" type="button" data-memory-view="${escapeHtml(String(item.id))}">查看</button>
                <button class="btn btn-small btn-danger" type="button" data-memory-delete="${escapeHtml(String(item.id))}">删除</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function openMemoryDetail(sessionId) {
  try {
    const data = await api(`/api/memories/${encodeURIComponent(sessionId)}/messages`);
    const session = data.session ?? {};
    const messages = data.messages ?? [];
    openModal({
      title: `${session.title || '未命名会话'} · ${session.themeName || ''}`,
      wide: true,
      body: `
        <div class="answer-meta">
          <span class="meta-pill">${escapeHtml(session.userName ?? state.currentUser?.displayName ?? '')}</span>
          <span class="meta-pill">${escapeHtml(session.themeName || '-')}</span>
          <span class="meta-pill">${messages.length} 条消息</span>
          <span class="meta-pill">${escapeHtml(formatDate(session.updatedAt) || '')}</span>
        </div>
        <div class="memory-thread">
          ${messages.map((message) => `
            <div class="memory-turn is-${message.role === 'user' ? 'user' : 'assistant'}">
              <div class="memory-turn-head">
                <strong>${message.role === 'user' ? '用户' : '智能体'}</strong>
                <span>${escapeHtml(formatDate(message.createdAt) || '')}</span>
              </div>
              <div class="memory-turn-body">${escapeHtml(message.content || '')}</div>
            </div>
          `).join('') || '<p class="memory-empty">该会话暂无消息</p>'}
        </div>
      `,
    });
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function deleteMemory(sessionId, button) {
  const item = memoryItems.find((entry) => String(entry.id) === String(sessionId));
  if (!window.confirm(`确认删除记忆「${item?.title ?? sessionId}」及其全部消息？删除后无法恢复。`)) {
    return;
  }
  setBusy(button, true, '删除中');
  try {
    await api(`/api/memories/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    toast('记忆已删除');
    await renderPage();
  } catch (error) {
    toast(error.message, 'error');
    setBusy(button, false);
  }
}

export { renderMemoryPage };
