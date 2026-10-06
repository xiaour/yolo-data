// 登录门禁组件：登录页、登录态读取、右上角账号菜单与修改密码弹窗。
// 这里刻意不 import runtime.js，避免与核心运行时形成循环依赖。

const ROLE_LABELS = { ADMIN: '管理员', ANALYST: '分析员' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

let gate = { root: null, onAuthenticated: null, toast: null };
// 引导页模块由 runtime 注入，避免 authGate 反向依赖 runtime 形成循环引用。
let replayGuideHandler = null;
let openMemoryHandler = null;

export function setOpenMemoryHandler(handler) {
  openMemoryHandler = typeof handler === 'function' ? handler : null;
}

export function setReplayGuideHandler(handler) {
  replayGuideHandler = typeof handler === 'function' ? handler : null;
}

export function mountAuthGate(root, options = {}) {
  gate = {
    root,
    onAuthenticated: options.onAuthenticated ?? null,
    toast: options.toast ?? null,
  };
}

export async function readSession() {
  try {
    const response = await fetch('/api/auth/me', { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      return { authenticated: false, user: null };
    }
    return await response.json();
  } catch {
    return { authenticated: false, user: null };
  }
}

function setAuthChrome(active) {
  document.body.classList.toggle('is-auth', active);
  const menu = document.getElementById('userMenu');
  if (menu && active) {
    menu.hidden = true;
  }
}

function showToast(message) {
  if (typeof gate.toast === 'function') {
    gate.toast(message);
    return;
  }
  const stack = document.getElementById('toastStack');
  const element = document.createElement('div');
  element.className = 'toast';
  element.textContent = message;
  stack.appendChild(element);
  setTimeout(() => element.remove(), 3200);
}

export function showLogin(message = '') {
  if (!gate.root) {
    return;
  }
  setAuthChrome(true);
  gate.root.dataset.page = 'login';
  gate.root.innerHTML = `
    <div class="login-shell">
      <form class="login-card" id="loginForm" novalidate>
        <div class="login-brand">
          <img src="/yolo-mark.svg" alt="" />
          <div><strong>YOLO</strong><small>基于指标语义的智能问数平台</small></div>
        </div>
        <h1>登录</h1>
        <p class="login-hint">${escapeHtml(message || '使用平台账号登录后开始问数')}</p>
        <label class="login-field">
          <span>用户名</span>
          <input id="loginUsername" name="username" autocomplete="username" required />
        </label>
        <label class="login-field">
          <span>密码</span>
          <input id="loginPassword" name="password" type="password" autocomplete="current-password" required />
        </label>
        <p class="login-error" id="loginError" hidden></p>
        <button class="btn btn-primary login-submit" type="submit">登录</button>
      </form>
    </div>
  `;
  const form = gate.root.querySelector('#loginForm');
  form.querySelector('#loginUsername').focus();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = form.querySelector('#loginError');
    const submit = form.querySelector('.login-submit');
    errorBox.hidden = true;
    submit.disabled = true;
    submit.textContent = '登录中…';
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.querySelector('#loginUsername').value.trim(),
          password: form.querySelector('#loginPassword').value,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message ?? `登录失败（${response.status}）`);
      }
      setAuthChrome(false);
      await gate.onAuthenticated?.(payload?.user ?? null);
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      submit.disabled = false;
      submit.textContent = '登录';
      form.querySelector('#loginPassword').select();
    }
  });
}

// 任何接口返回 401 时回到登录页，避免停留在半截界面上报错。
export function notifyUnauthorized() {
  if (document.body.classList.contains('is-auth')) {
    return;
  }
  showLogin('登录状态已失效，请重新登录');
}

export async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.reload();
  }
}

function openPasswordDialog() {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop" data-password-backdrop>
      <form class="modal is-narrow" id="passwordForm" role="dialog" aria-modal="true">
        <header class="modal-head">
          <h2>修改密码</h2>
          <button class="btn btn-quiet btn-icon" type="button" data-close-password aria-label="关闭">×</button>
        </header>
        <div class="modal-body">
          <label class="login-field"><span>当前密码</span>
            <input id="passwordCurrent" type="password" autocomplete="current-password" required /></label>
          <label class="login-field"><span>新密码</span>
            <input id="passwordNext" type="password" autocomplete="new-password" required /></label>
          <label class="login-field"><span>确认新密码</span>
            <input id="passwordConfirm" type="password" autocomplete="new-password" required /></label>
          <p class="login-error" id="passwordError" hidden></p>
        </div>
        <footer class="modal-foot">
          <button class="btn btn-quiet" type="button" data-close-password>取消</button>
          <button class="btn btn-primary" type="submit">保存</button>
        </footer>
      </form>
    </div>
  `;
  const form = root.querySelector('#passwordForm');
  const close = () => {
    root.innerHTML = '';
  };
  root.querySelectorAll('[data-close-password]').forEach((button) => {
    button.addEventListener('click', close);
  });
  root.querySelector('[data-password-backdrop]').addEventListener('click', (event) => {
    if (event.target.dataset.passwordBackdrop !== undefined) {
      close();
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = form.querySelector('#passwordError');
    const next = form.querySelector('#passwordNext').value;
    if (next !== form.querySelector('#passwordConfirm').value) {
      errorBox.textContent = '两次输入的新密码不一致';
      errorBox.hidden = false;
      return;
    }
    errorBox.hidden = true;
    try {
      const response = await fetch('/api/auth/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: form.querySelector('#passwordCurrent').value,
          newPassword: next,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message ?? `修改失败（${response.status}）`);
      }
      close();
      showToast('密码已更新');
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    }
  });
}

export function renderUserSelect(user) {
  const menu = document.getElementById('userMenu');
  if (!menu || !user) {
    return;
  }
  const role = String(user.role ?? '').toUpperCase();
  const displayName = user.displayName ?? user.username ?? '';
  menu.hidden = false;
  const trigger = menu.querySelector('#userMenuTrigger');
  const panel = menu.querySelector('#userMenuPanel');
  menu.querySelector('#userMenuName').textContent = displayName;
  menu.querySelector('#userMenuAvatar').textContent = String(displayName || '?').slice(0, 1).toUpperCase();
  menu.querySelector('#userMenuDisplay').textContent = `${displayName} · ${user.username ?? ''}`;
  menu.querySelector('#userMenuRole').textContent = ROLE_LABELS[role] ?? '分析员';
  trigger.onclick = (event) => {
    event.stopPropagation();
    panel.hidden = !panel.hidden;
    trigger.setAttribute('aria-expanded', String(!panel.hidden));
  };
  const replayItem = panel.querySelector('[data-action="tour"]');
  if (replayItem) {
    replayItem.onclick = () => {
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      replayGuideHandler?.();
    };
  }
  const memoryItem = panel.querySelector('[data-action="memory"]');
  if (memoryItem) {
    memoryItem.onclick = () => {
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      openMemoryHandler?.();
    };
  }
  panel.querySelector('[data-action="password"]').onclick = () => {
    panel.hidden = true;
    openPasswordDialog();
  };
  panel.querySelector('[data-action="logout"]').onclick = () => {
    panel.hidden = true;
    logout();
  };
  if (!menu.dataset.bound) {
    menu.dataset.bound = '1';
    document.addEventListener('click', (event) => {
      if (!menu.contains(event.target)) {
        panel.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
      }
    });
  }
}
