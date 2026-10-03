// 用户编辑器：维护用户名、显示名称、角色（ADMIN/ANALYST）和启用状态。

import * as core from '../core/runtime.js';

const {
  api,
  toast,
  setBusy,
  openModal,
  closeModal,
  escapeAttr,
} = core;

function openUserEditor(user, options = {}) {
  const { onSaved } = options;
  const editing = Boolean(user);
  const modal = openModal({
    title: editing ? `编辑用户「${user.displayName}」` : '新增用户',
    editor: true,
    body: `
      <div class="form-grid">
        <div class="form-field">
          <label for="userUsername">用户名</label>
          <input class="field mono" id="userUsername" value="${escapeAttr(user?.username ?? '')}"${editing ? ' disabled' : ''} placeholder="east_manager" />
        </div>
        <div class="form-field">
          <label for="userDisplayName">显示名称</label>
          <input class="field" id="userDisplayName" value="${escapeAttr(user?.displayName ?? '')}" placeholder="华东区域经理" />
        </div>
        <div class="form-field">
          <label for="userRole">角色</label>
          <select class="select" id="userRole">
            <option value="ANALYST"${user?.role === 'ADMIN' ? '' : ' selected'}>分析员（仅问数）</option>
            <option value="ADMIN"${user?.role === 'ADMIN' ? ' selected' : ''}>平台管理员</option>
          </select>
        </div>
        <div class="form-field">
          <label for="userStatus">状态</label>
          <select class="select" id="userStatus">
            <option value="1"${user?.status === 0 ? '' : ' selected'}>启用</option>
            <option value="0"${user?.status === 0 ? ' selected' : ''}>停用</option>
          </select>
        </div>
      </div>
      <p class="muted">分析员只能查看已授权的智能体并用它们问数；平台管理、模型、数据集、指标平台等入口不会展示。</p>
    `,
    footer: `
      <button class="btn" type="button" data-close-modal>取消</button>
      <button class="btn btn-primary" type="button" id="saveUserBtn">保存用户</button>
    `,
  });
  modal.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', closeModal);
  });
  modal.querySelector('#saveUserBtn').addEventListener('click', async (event) => {
    setBusy(event.currentTarget, true, '保存中');
    try {
      await api(editing ? `/api/users/${user.id}` : '/api/users', {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify({
          username: modal.querySelector('#userUsername').value.trim(),
          displayName: modal.querySelector('#userDisplayName').value.trim(),
          role: modal.querySelector('#userRole').value,
          status: Number(modal.querySelector('#userStatus').value),
          attributes: user?.attributes ?? {},
        }),
      });
      toast(editing ? '用户已更新' : '用户已创建');
      closeModal();
      await onSaved?.();
    } catch (error) {
      toast(error.message, 'error');
      setBusy(event.currentTarget, false);
    }
  });
}

export { openUserEditor };
