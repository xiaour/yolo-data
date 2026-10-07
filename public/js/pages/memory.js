// 记忆管理：用户长期记忆的查看与维护。
//
// 记忆的语义单元是“文档”，不是原子条目：
// - 记忆文档：按「用户 × 作用域」一份 Markdown 手册，摘要段注入上下文，正文按需检索。
// - 笔记时间线：追加式笔记，先落到这里，再由合并整理进文档。
// - 版本：每次合并生成一个快照，可回滚。
// 页面只负责展示与操作，不表达任何业务口径；管理员可查看与维护全部用户的记忆。
import * as core from '../core/runtime.js';

const {
  state, icon, escapeHtml, escapeAttr, formatDate, api, toast,
  emptyState, setBusy, openModal, closeModal, renderPage, renderSafeMarkdown,
} = core;

let memoryDocuments = [];
let memoryNotes = [];
let memoryUsers = [];
let memoryKinds = [];
let memoryStats = {};
let memoryMaintenance = { enabled: false, intervalMs: 0 };

const filters = { keyword: '', themeId: '', noteState: 'PENDING' };

const NOTE_STATE_LABELS = { PENDING: '待合并', MERGED: '已合并', ARCHIVED: '已归档' };

// 「我的记忆」只允许看本人；只有从系统设置进入的记忆管理（管理员）才能切换用户。
function isAllUsersView() {
  return state.memoryScope === 'all' && state.currentUser?.role === 'ADMIN';
}

function scopeUserId() {
  if (!isAllUsersView()) {
    return state.currentUser?.id ? Number(state.currentUser.id) : null;
  }
  return state.memoryUserId ? Number(state.memoryUserId) : null;
}

function scopeLabelOf(item) {
  return item.scopeLabel || (item.themeId ? (item.themeName ?? `智能体 #${item.themeId}`) : '通用（全部智能体）');
}

function buildQuery() {
  const params = new URLSearchParams();
  if (isAllUsersView()) {
    if (scopeUserId()) {
      params.set('userId', String(scopeUserId()));
    }
  } else if (scopeUserId()) {
    // 本人视图永远显式带上自己的 userId，避免管理员账号落到“全部用户”范围。
    params.set('userId', String(scopeUserId()));
  }
  if (filters.themeId) {
    params.set('themeId', filters.themeId);
  }
  if (filters.noteState) {
    params.set('state', filters.noteState);
  }
  if (filters.keyword) {
    params.set('q', filters.keyword);
  }
  return params.toString();
}

async function loadMemories() {
  const query = buildQuery();
  const data = await api(`/api/memories${query ? `?${query}` : ''}`);
  memoryDocuments = data.documents ?? [];
  memoryNotes = data.notes ?? [];
  memoryUsers = data.users ?? [];
  memoryKinds = data.kinds ?? [];
  memoryStats = data.stats ?? {};
  memoryMaintenance = data.maintenance ?? memoryMaintenance;
  return data;
}

function formatChars(value) {
  const count = Number(value) || 0;
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

function documentCard(doc) {
  const paused = Number(doc.status) !== 1;
  const hasContent = Boolean(String(doc.content ?? '').trim());
  const scope = scopeLabelOf(doc);
  const length = String(doc.content ?? '').length;
  const threshold = Math.floor((Number(doc.contentBudget) || 8000) * (memoryMaintenance.compactRatio || 0.8));
  const needsCompact = length >= threshold;
  return `
    <article class="memory-doc${paused ? ' is-paused' : ''}" data-doc-id="${doc.id}">
      <header class="memory-doc-head">
        <div class="memory-doc-titles">
          <h4>${escapeHtml(scope)}</h4>
          <div class="memory-doc-tags">
            <span class="memory-tag">v${doc.version}</span>
            <span class="memory-tag is-quiet">正文 ${formatChars(length)}/${formatChars(Number(doc.contentBudget) || 8000)} 字</span>
            ${needsCompact ? '<span class="memory-tag is-warn">待压缩</span>' : ''}
            ${paused ? '<span class="memory-tag is-warn">已暂停注入</span>' : ''}
            ${memoryUsers.length > 0 ? `<span class="memory-tag is-quiet">${escapeHtml(doc.userName ?? '-')}</span>` : ''}
          </div>
        </div>
        <div class="memory-doc-actions">
          <button class="btn btn-quiet" type="button" data-doc-consolidate="${doc.id}">${icon('brain-circuit', '合并笔记')}合并笔记</button>
          <button class="btn btn-quiet" type="button" data-doc-compact="${doc.id}">${icon('list-checks', '压缩')}压缩</button>
          <button class="btn btn-quiet" type="button" data-doc-versions="${doc.id}">${icon('clock', '版本')}版本</button>
          <button class="btn btn-quiet" type="button" data-doc-edit="${doc.id}">${icon('edit', '编辑')}编辑</button>
          <button class="btn btn-quiet" type="button" data-doc-toggle="${doc.id}">
            ${icon(paused ? 'saved' : 'x', paused ? '启用' : '暂停')}${paused ? '启用' : '暂停注入'}
          </button>
          <button class="btn btn-quiet btn-danger" type="button" data-doc-delete="${doc.id}">${icon('trash', '清空')}清空</button>
        </div>
      </header>
      ${doc.summary
        ? `<p class="memory-doc-summary"><strong>常驻摘要</strong>${escapeHtml(doc.summary)}</p>`
        : '<p class="memory-doc-summary is-empty">还没有摘要，合并笔记后会自动生成。</p>'}
      ${hasContent
        ? `<details class="memory-doc-body"><summary>查看手册正文</summary><div class="memory-doc-markdown">${renderSafeMarkdown(doc.content)}</div></details>`
        : '<p class="memory-doc-empty">这份作用域下还没有正文，先沉淀笔记再合并即可生成手册。</p>'}
      <p class="memory-doc-meta">
        更新于 ${escapeHtml(formatDate(doc.updatedAt))}
        ${doc.lastConsolidatedAt ? ` · 最近合并 ${escapeHtml(formatDate(doc.lastConsolidatedAt))}` : ''}
        ${doc.injectedCount ? ` · 已注入 ${doc.injectedCount} 次` : ''}
      </p>
    </article>
  `;
}

function noteItem(note) {
  const stateLabel = NOTE_STATE_LABELS[note.state] ?? note.state;
  const archived = note.state === 'ARCHIVED';
  return `
    <li class="memory-note" data-note-id="${note.id}">
      <div class="memory-note-main">
        <div class="memory-note-tags">
          <span class="memory-tag">${escapeHtml(note.kindLabel ?? note.kind)}</span>
          <span class="memory-tag is-quiet">${escapeHtml(note.sourceLabel ?? note.source)}</span>
          <span class="memory-tag is-quiet">${escapeHtml(scopeLabelOf(note))}</span>
          <span class="memory-tag is-quiet">${escapeHtml(stateLabel)}</span>
          ${note.mergedVersion ? `<span class="memory-tag is-quiet">并入 v${note.mergedVersion}</span>` : ''}
          ${memoryUsers.length > 0 ? `<span class="memory-tag is-quiet">${escapeHtml(note.userName ?? '-')}</span>` : ''}
        </div>
        <p class="memory-note-content">${escapeHtml(note.content)}</p>
        <p class="memory-note-meta">${escapeHtml(formatDate(note.createdAt))}</p>
      </div>
      <div class="memory-note-actions">
        ${note.state === 'MERGED' ? '' : `<button class="btn btn-quiet" type="button" data-note-archive="${note.id}">
          ${icon(archived ? 'saved' : 'file-text', archived ? '恢复' : '归档')}${archived ? '恢复待合并' : '归档'}
        </button>`}
        <button class="btn btn-quiet btn-danger" type="button" data-note-delete="${note.id}">${icon('trash', '删除')}删除</button>
      </div>
    </li>
  `;
}

const KIND_OPTIONS = (selected) => memoryKinds
  .map((item) => `<option value="${escapeAttr(item.code)}"${item.code === selected ? ' selected' : ''}>${escapeHtml(item.label)}</option>`)
  .join('');

const THEME_OPTIONS = (selected) => [
  '<option value="">通用（全部智能体）</option>',
  ...(state.themes ?? []).map((item) => `<option value="${item.id}"${Number(item.id) === Number(selected) ? ' selected' : ''}>${escapeHtml(item.name)}</option>`),
].join('');

function openNoteEditor() {
  openModal({
    title: '新增记忆笔记',
    wide: true,
    body: `
      <div class="form-grid">
        <div class="form-field span-2">
          <label for="memoryNoteContent">笔记内容</label>
          <textarea class="field" id="memoryNoteContent" rows="4" maxlength="400" placeholder="例如：本部门默认按含税口径看销售额"></textarea>
          <small>4-400 字。只写可跨会话复用的业务知识、口径偏好或术语习惯，不写一次性问题。</small>
        </div>
        <div class="form-field">
          <label for="memoryNoteKind">类型</label>
          <select class="select" id="memoryNoteKind">${KIND_OPTIONS('BUSINESS_KNOWLEDGE')}</select>
        </div>
        <div class="form-field">
          <label for="memoryNoteTheme">作用域</label>
          <select class="select" id="memoryNoteTheme">${THEME_OPTIONS(null)}</select>
        </div>
      </div>
    `,
    footer: `<button class="btn btn-quiet" type="button" data-close-modal>取消</button>
      <button class="btn btn-primary" type="button" id="memoryNoteSaveBtn">保存</button>`,
  });
  document.getElementById('memoryNoteSaveBtn').addEventListener('click', async (event) => {
    const content = document.getElementById('memoryNoteContent').value.trim();
    if (content.length < 4) {
      toast('笔记内容至少 4 个字', 'error');
      return;
    }
    setBusy(event.currentTarget, true, '保存中');
    try {
      await api('/api/memories/notes', {
        method: 'POST',
        body: JSON.stringify({
          content,
          kind: document.getElementById('memoryNoteKind').value,
          themeId: document.getElementById('memoryNoteTheme').value || null,
          userId: scopeUserId(),
        }),
      });
      closeModal();
      toast('笔记已保存，可随时合并进记忆文档');
      await renderPage();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(event.currentTarget, false);
    }
  });
}

function openDocumentEditor(doc) {
  openModal({
    title: `编辑记忆文档 · ${scopeLabelOf(doc)}`,
    wide: true,
    body: `
      <div class="form-grid">
        <div class="form-field span-2">
          <label for="memoryDocSummary">常驻摘要</label>
          <textarea class="field" id="memoryDocSummary" rows="3" maxlength="${Number(doc.summaryBudget) || 1200}" placeholder="注入模型上下文的一句话摘要">${escapeHtml(doc.summary)}</textarea>
          <small>这段摘要会常驻问数上下文，建议只写覆盖范围与关键默认口径。</small>
        </div>
        <div class="form-field span-2">
          <label for="memoryDocContent">手册正文（Markdown）</label>
          <textarea class="field memory-doc-textarea" id="memoryDocContent" rows="16">${escapeHtml(doc.content)}</textarea>
          <small>按「## 分节」组织，每条写成可独立读懂的一句或两句。保存会生成新版本，可回滚。</small>
        </div>
      </div>
    `,
    footer: `<button class="btn btn-quiet" type="button" data-close-modal>取消</button>
      <button class="btn btn-primary" type="button" id="memoryDocSaveBtn">保存为新版本</button>`,
  });
  document.getElementById('memoryDocSaveBtn').addEventListener('click', async (event) => {
    setBusy(event.currentTarget, true, '保存中');
    try {
      await api(`/api/memories/documents/${doc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          summary: document.getElementById('memoryDocSummary').value,
          content: document.getElementById('memoryDocContent').value,
        }),
      });
      closeModal();
      toast('记忆文档已保存');
      await renderPage();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(event.currentTarget, false);
    }
  });
}

async function openVersions(doc) {
  let versions = [];
  try {
    const data = await api(`/api/memories/documents/${doc.id}/versions`);
    versions = data.versions ?? [];
  } catch (error) {
    toast(`读取版本失败：${error.message}`, 'error');
    return;
  }
  openModal({
    title: `版本历史 · ${scopeLabelOf(doc)}`,
    wide: true,
    body: versions.length === 0
      ? '<p class="memory-doc-empty">还没有可回滚的历史版本。</p>'
      : `<ul class="memory-version-list">${versions.map((item) => `
          <li class="memory-version" data-version="${item.version}">
            <div>
              <strong>v${item.version}</strong>
              <span class="memory-tag is-quiet">${item.noteCount} 条笔记</span>
              ${item.version === doc.version ? '<span class="memory-tag">当前版本</span>' : ''}
              <p class="memory-note-meta">${escapeHtml(item.changeReason || '—')} · ${escapeHtml(formatDate(item.createdAt))}</p>
            </div>
            ${item.version === doc.version ? '' : `<button class="btn btn-quiet" type="button" data-rollback="${item.version}">回滚到此版本</button>`}
          </li>`).join('')}</ul>`,
    footer: '<button class="btn btn-quiet" type="button" data-close-modal>关闭</button>',
  });
  document.querySelectorAll('[data-rollback]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm(`确认回滚到 v${button.dataset.rollback}？回滚会生成一个新版本。`)) {
        return;
      }
      try {
        await api(`/api/memories/documents/${doc.id}/rollback`, {
          method: 'POST',
          body: JSON.stringify({ version: Number(button.dataset.rollback) }),
        });
        closeModal();
        toast('已回滚，并生成新版本');
        await renderPage();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
}

async function compactScope(doc, button) {
  setBusy(button, true, '压缩中');
  try {
    const result = await api('/api/memories/maintain', {
      method: 'POST',
      body: JSON.stringify({ userId: doc.userId, themeId: doc.themeId ?? null }),
    });
    const compacted = result.compacted ?? {};
    if (compacted.changed) {
      toast(`已压缩 ${compacted.before}→${compacted.after} 字，生成 v${compacted.document?.version ?? ''}`);
    } else if (compacted.reason === 'MODEL_REQUIRED') {
      toast('未配置大模型，记忆无法自动压缩（可先合并笔记）', 'error');
    } else if (compacted.reason === 'EMPTY_DOCUMENT') {
      toast('这份作用域还没有正文，先合并笔记再压缩');
    } else if (compacted.reason === 'OVER_COMPRESSED' || compacted.reason === 'NOT_SHORTER') {
      toast('压缩结果不安全或没有更短，已保留原文档');
    } else if (compacted.reason === 'NO_MEANINGFUL_CHANGE') {
      toast('没有可继续压缩的内容，文档保持不变');
    } else {
      toast('文档还不需要压缩');
    }
    await renderPage();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function consolidateScope(doc, button) {
  setBusy(button, true, '合并中');
  try {
    const result = await api('/api/memories/consolidate', {
      method: 'POST',
      body: JSON.stringify({
        userId: doc.userId,
        themeId: doc.themeId ?? null,
      }),
    });
    const messages = {
      NO_PENDING_NOTES: '这个作用域还没有待合并的笔记',
      NO_MEANINGFUL_CHANGE: '笔记没有带来实质变化，文档保持不变',
      IDENTICAL_CONTENT: '合并结果与当前文档一致，未生成新版本',
      EMPTY_RESULT: '合并结果为空，文档保持不变',
    };
    if (result.changed) {
      toast(`已合并 ${result.merged} 条笔记，文档升级到 v${result.document?.version ?? ''}`);
    } else {
      toast(messages[result.reason] ?? '没有需要合并的笔记');
    }
    await renderPage();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function openDistillDialog() {
  let sessions = [];
  try {
    sessions = await api('/api/chat/sessions');
  } catch (error) {
    toast(`读取会话失败：${error.message}`, 'error');
    return;
  }
  if (!Array.isArray(sessions) || sessions.length === 0) {
    toast('暂无可沉淀的会话，先去问数再回来沉淀');
    return;
  }
  openModal({
    title: '从会话沉淀记忆笔记',
    wide: true,
    body: `
      <div class="form-grid">
        <div class="form-field span-2">
          <label for="distillSession">选择会话</label>
          <select class="select" id="distillSession">${sessions.map((item) => (
    `<option value="${item.id}">${escapeHtml(item.title || `会话 #${item.id}`)} · ${escapeHtml(item.themeName ?? '')}</option>`
  )).join('')}</select>
          <small>平台会从所选会话中提炼可跨会话复用的业务知识，结果先落成笔记。没有配置大模型时，只沉淀你在提问中明确要求“记住”的内容。</small>
        </div>
      </div>
      <div id="distillResult" class="distill-result"></div>
    `,
    footer: `<button class="btn btn-quiet" type="button" data-close-modal>关闭</button>
      <button class="btn btn-primary" type="button" id="distillRunBtn">开始沉淀</button>`,
  });
  document.getElementById('distillRunBtn').addEventListener('click', async (event) => {
    setBusy(event.currentTarget, true, '沉淀中');
    try {
      const result = await api('/api/memories/distill', {
        method: 'POST',
        body: JSON.stringify({ sessionId: Number(document.getElementById('distillSession').value) }),
      });
      document.getElementById('distillResult').innerHTML = result.count === 0
        ? '<p>本次没有识别到可沉淀的业务知识。</p>'
        : `<p>已落成 ${result.count} 条笔记，去「合并笔记」即可整理进文档：</p><ul>${result.notes
          .map((item) => `<li>${escapeHtml(item.content)}</li>`).join('')}</ul>`;
      toast(`沉淀完成，新增或更新 ${result.count} 条笔记`);
      await renderPage();
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(event.currentTarget, false);
    }
  });
}

function bindActions(root) {
  const documentOf = (id) => memoryDocuments.find((item) => Number(item.id) === Number(id));
  const noteOf = (id) => memoryNotes.find((item) => Number(item.id) === Number(id));

  root.querySelectorAll('[data-doc-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const item = documentOf(button.dataset.docEdit);
      if (item) {
        openDocumentEditor(item);
      }
    });
  });
  root.querySelectorAll('[data-doc-versions]').forEach((button) => {
    button.addEventListener('click', async () => {
      const item = documentOf(button.dataset.docVersions);
      if (item) {
        await openVersions(item);
      }
    });
  });
  root.querySelectorAll('[data-doc-consolidate]').forEach((button) => {
    button.addEventListener('click', async () => {
      const item = documentOf(button.dataset.docConsolidate);
      if (item) {
        await consolidateScope(item, button);
      }
    });
  });
  root.querySelectorAll('[data-doc-compact]').forEach((button) => {
    button.addEventListener('click', async () => {
      const item = documentOf(button.dataset.docCompact);
      if (item) {
        await compactScope(item, button);
      }
    });
  });
  root.querySelectorAll('[data-doc-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      const item = documentOf(button.dataset.docToggle);
      try {
        await api(`/api/memories/documents/${button.dataset.docToggle}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: Number(item?.status) === 1 ? 0 : 1 }),
        });
        toast(Number(item?.status) === 1 ? '已暂停注入，后续问数不再引用' : '已恢复注入');
        await renderPage();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
  root.querySelectorAll('[data-doc-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      const item = documentOf(button.dataset.docDelete);
      if (!window.confirm(`确认清空「${scopeLabelOf(item ?? {})}」的记忆文档与全部笔记？清空后无法恢复。`)) {
        return;
      }
      try {
        await api(`/api/memories/documents/${button.dataset.docDelete}`, { method: 'DELETE' });
        toast('已清空该作用域的记忆');
        await renderPage();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
  root.querySelectorAll('[data-note-archive]').forEach((button) => {
    button.addEventListener('click', async () => {
      const item = noteOf(button.dataset.noteArchive);
      try {
        await api(`/api/memories/notes/${button.dataset.noteArchive}`, {
          method: 'PATCH',
          body: JSON.stringify({ state: item?.state === 'ARCHIVED' ? 'PENDING' : 'ARCHIVED' }),
        });
        await renderPage();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
  root.querySelectorAll('[data-note-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      const item = noteOf(button.dataset.noteDelete);
      if (!window.confirm(`确认删除笔记「${item?.content ?? ''}」？删除后无法恢复。`)) {
        return;
      }
      try {
        await api(`/api/memories/notes/${button.dataset.noteDelete}`, { method: 'DELETE' });
        toast('笔记已删除');
        await renderPage();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });
}

async function renderMemoryPage(root) {
  root.innerHTML = '<div class="loading-state"><span class="spinner"></span>正在读取记忆</div>';
  try {
    await loadMemories();
  } catch (error) {
    root.innerHTML = `<div class="page-stack">${emptyState(`记忆读取失败：${error.message}`)}</div>`;
    return;
  }
  const allUsersView = isAllUsersView();
  const currentUser = memoryUsers.find((item) => Number(item.id) === scopeUserId());
  const pending = memoryNotes.filter((item) => item.state === 'PENDING').length;
  root.innerHTML = `
    <div class="page-stack">
      <section class="section-band">
        <div class="section-head">
          <div>
            <h2>${allUsersView ? '记忆管理' : '我的记忆'}</h2>
            <p>${allUsersView
    ? '长期记忆按「用户 × 智能体」沉淀成一份手册：摘要常驻问数上下文，正文按需检索。'
    : '这里只显示你自己的长期记忆：摘要会注入你自己的问数上下文，用于补全默认口径与表达习惯。'}</p>
          </div>
          <div class="memory-actions">
            <button class="btn btn-primary" id="memoryNoteAddBtn" type="button">${icon('plus', '新增笔记')}新增笔记</button>
            <button class="btn" id="memoryDistillBtn" type="button">${icon('library', '从会话沉淀')}从会话沉淀</button>
            <button class="btn btn-quiet" id="memoryRefreshBtn" type="button">${icon('refresh', '刷新')}刷新</button>
          </div>
        </div>
        <div class="detail-list memory-summary">
          <div class="detail-row"><span>记忆文档</span><strong>${memoryStats.documents ?? memoryDocuments.length}</strong></div>
          <div class="detail-row"><span>待合并笔记</span><strong>${memoryStats.pendingNotes ?? pending}</strong></div>
          <div class="detail-row"><span>范围</span><strong>${escapeHtml(allUsersView ? (currentUser?.name ?? '全部用户') : (state.currentUser?.displayName ?? '本人'))}</strong></div>
        </div>
        <p class="memory-maintenance">
          ${memoryMaintenance.enabled
    ? `自动整理已开启：每 ${Math.round((memoryMaintenance.intervalMs || 0) / 60_000)} 分钟巡检一次，攒够 ${memoryMaintenance.autoConsolidateAt ?? '-'} 条笔记自动合并，正文超过 ${Math.round((memoryMaintenance.compactRatio ?? 0.8) * 100)}% 自动压缩。`
    : '自动整理已关闭（可用下方「合并笔记」「压缩」手动整理）。'}
          ${memoryMaintenance.lastRunAt
    ? ` 上次巡检 ${escapeHtml(formatDate(memoryMaintenance.lastRunAt))}：处理 ${memoryMaintenance.lastProcessed ?? 0} 个作用域，更新 ${memoryMaintenance.lastChanged ?? 0} 个。`
    : ''}
        </p>
        <div class="page-toolbar memory-filters">
          ${allUsersView ? `<label><span>用户</span>
            <select class="select" id="memoryUserFilter">
              <option value="">全部用户（${memoryUsers.length}）</option>
              ${memoryUsers.map((item) => `<option value="${item.id}"${Number(item.id) === scopeUserId() ? ' selected' : ''}>${escapeHtml(item.name)}（${escapeHtml(item.username ?? '')}）${item.pendingNotes ? ` · ${item.pendingNotes} 条待合并` : ''}</option>`).join('')}
            </select></label>` : ''}
          <label><span>智能体</span>
            <select class="select" id="memoryThemeFilter">
              <option value="">全部智能体</option>
              ${(state.themes ?? []).map((item) => `<option value="${item.id}"${Number(item.id) === Number(filters.themeId) ? ' selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}
            </select></label>
          <label><span>笔记状态</span>
            <select class="select" id="memoryNoteStateFilter">
              ${[['PENDING', '待合并'], ['MERGED', '已合并'], ['ARCHIVED', '已归档'], ['', '全部']].map(([code, label]) => (
    `<option value="${code}"${filters.noteState === code ? ' selected' : ''}>${label}</option>`
  )).join('')}
            </select></label>
          <input class="field" id="memoryKeyword" type="search" placeholder="搜索笔记内容" value="${escapeAttr(filters.keyword)}" />
        </div>
      </section>
      <section class="section-band">
        <div class="section-head compact">
          <div><h3>记忆文档</h3><p>每个作用域一份 Markdown 手册，摘要注入上下文、正文按需检索。</p></div>
        </div>
        ${memoryDocuments.length === 0
          ? emptyState('还没有记忆文档。先新增或从会话沉淀笔记，再点「合并笔记」即可生成手册', 'scroll-text')
          : `<div class="memory-doc-list">${memoryDocuments.map(documentCard).join('')}</div>`}
      </section>
      <section class="section-band">
        <div class="section-head compact">
          <div><h3>笔记时间线</h3><p>笔记只追加不改写，合并后整理进对应作用域的记忆文档。</p></div>
        </div>
        ${memoryNotes.length === 0
          ? emptyState('当前筛选下没有笔记', 'list-checks')
          : `<ul class="memory-note-list">${memoryNotes.map(noteItem).join('')}</ul>`}
      </section>
    </div>
  `;

  document.getElementById('memoryRefreshBtn').addEventListener('click', () => renderMemoryPage(root));
  document.getElementById('memoryNoteAddBtn').addEventListener('click', () => openNoteEditor());
  document.getElementById('memoryDistillBtn').addEventListener('click', () => openDistillDialog());
  document.getElementById('memoryKeyword').addEventListener('change', (event) => {
    filters.keyword = event.target.value.trim();
    renderMemoryPage(root);
  });
  document.getElementById('memoryThemeFilter').addEventListener('change', (event) => {
    filters.themeId = event.target.value;
    renderMemoryPage(root);
  });
  document.getElementById('memoryNoteStateFilter').addEventListener('change', (event) => {
    filters.noteState = event.target.value;
    renderMemoryPage(root);
  });
  document.getElementById('memoryUserFilter')?.addEventListener('change', (event) => {
    state.memoryUserId = event.target.value ? Number(event.target.value) : null;
    renderPage();
  });
  bindActions(root);
}

export { renderMemoryPage };
