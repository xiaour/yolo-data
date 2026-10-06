// 本地上传入口：把本地文件传给平台，作为当前会话的工作区产物参与问数算数。
// 组件保持零依赖，只负责选择/拖拽、base64 读取、调用上传接口与展示结果，
// 不猜测文件语义，也不参与业务口径。

import * as core from '../core/runtime.js';

const { icon, escapeHtml, escapeAttr, toast } = core;

const MAX_BYTES = 8 * 1024 * 1024;
const ACCEPT_EXTENSIONS = ['csv', 'xls', 'xlsx'];

let uploads = [];

function chipsMarkup() {
  if (uploads.length === 0) {
    return '';
  }
  return uploads.map((item) => `
    <span class="attachment-chip${item.status === 'error' ? ' is-error' : ''}"
      title="${escapeAttr(item.message ?? item.label ?? '')}">
      ${icon(item.status === 'error' ? 'circle-alert' : 'file-spreadsheet', item.label)}
      <span>${escapeHtml(item.label)}</span>
    </span>
  `).join('');
}

export function fileUploadMarkup() {
  return `
    <div class="chat-attachment-bar" id="chatAttachmentBar">
      <button class="attachment-add" id="attachmentAddBtn" type="button">
        ${icon('plus', '上传本地文件')}<span>本地文件</span>
      </button>
      <input type="file" class="attachment-input" id="attachmentInput" hidden
        multiple accept="${ACCEPT_EXTENSIONS.map((item) => `.${item}`).join(',')}" />
      <span class="attachment-chips" id="chatAttachmentChips">${chipsMarkup()}</span>
    </div>
  `;
}

export function clearLocalFileUploads() {
  uploads = [];
  const host = document.getElementById('chatAttachmentChips');
  if (host) {
    host.innerHTML = '';
  }
}

// 当前待随提问提交的附件（已成功上传并取得产物 ID 的文件）。
export function pendingUploadAttachments() {
  return uploads
    .filter((item) => item.status === 'ok' && item.artifactId)
    .map((item) => ({
      artifactId: item.artifactId,
      name: item.name,
      label: item.label,
    }));
}

function extensionOf(name) {
  const match = String(name ?? '').match(/\.([A-Za-z0-9]+)$/);
  return match ? match[1].toLowerCase() : '';
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? '').split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('本地文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function describeUpload(result) {
  if (!result?.table) {
    const note = result?.warnings?.[0] ? ` · ${result.warnings[0]}` : ' · 已保存';
    return `${result.file.name}${note}`;
  }
  const sheet = result.table.sheetName ? `工作表「${result.table.sheetName}」· ` : '';
  return `${result.file.name} · ${sheet}${result.table.rowCount} 行 / ${result.table.columnCount} 列`;
}

async function uploadOne(file, { ensureSession, refresh }) {
  const extension = extensionOf(file.name);
  if (!ACCEPT_EXTENSIONS.includes(extension)) {
    return { ok: false, message: `暂不支持 .${extension || '未知'} 文件，请使用 CSV、XLS 或 XLSX` };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, message: `文件超过 ${Math.floor(MAX_BYTES / 1024 / 1024)}MB 上限` };
  }
  const session = await ensureSession();
  const contentBase64 = await readAsBase64(file);
  const result = await core.api('/api/workspaces/files', {
    method: 'POST',
    body: JSON.stringify({ sessionId: session.id, name: file.name, contentBase64 }),
  });
  await refresh();
  return { ok: true, result };
}

export function bindFileUpload(root, { ensureSession, onUploaded } = {}) {
  const bar = root.querySelector('#chatAttachmentBar');
  const input = root.querySelector('#attachmentInput');
  const addButton = root.querySelector('#attachmentAddBtn');
  const chipHost = root.querySelector('#chatAttachmentChips');
  if (!bar || !input || !addButton || !chipHost) {
    return;
  }
  const repaint = () => {
    chipHost.innerHTML = chipsMarkup();
  };
  let busy = false;
  const handleFiles = async (fileList) => {
    const files = [...(fileList ?? [])];
    if (busy || files.length === 0) {
      return;
    }
    busy = true;
    addButton.disabled = true;
    for (const file of files) {
      uploads.push({ label: `${file.name} 上传中…`, status: 'pending' });
      repaint();
      try {
        const outcome = await uploadOne(file, { ensureSession, refresh: onUploaded });
        uploads = uploads.filter((item) => item.status !== 'pending');
        if (outcome.ok) {
          uploads.push({
            label: describeUpload(outcome.result),
            status: 'ok',
            message: '已加入当前会话工作区，可直接在提问中引用',
            artifactId: outcome.result.file?.artifactId ?? null,
            name: outcome.result.file?.name ?? file.name,
          });
          toast(`已上传 ${file.name}`);
        } else {
          uploads.push({ label: `${file.name} 上传失败`, status: 'error', message: outcome.message });
          toast(outcome.message, 'error');
        }
      } catch (error) {
        uploads = uploads.filter((item) => item.status !== 'pending');
        uploads.push({ label: `${file.name} 上传失败`, status: 'error', message: error.message });
        toast(error.message, 'error');
      }
      repaint();
    }
    busy = false;
    addButton.disabled = false;
  };
  addButton.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    handleFiles(files);
  });
  bar.addEventListener('dragover', (event) => {
    event.preventDefault();
    bar.classList.add('is-dragging');
  });
  bar.addEventListener('dragleave', () => bar.classList.remove('is-dragging'));
  bar.addEventListener('drop', (event) => {
    event.preventDefault();
    bar.classList.remove('is-dragging');
    handleFiles(event.dataTransfer?.files);
  });
}

export { ACCEPT_EXTENSIONS, MAX_BYTES };
