import path from 'node:path';

// 环境变量标量解析原语：loadConfig 组装配置时使用。

export function readInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

export function parsePathList(value, fallback = []) {
  const items = String(value ?? '')
    .split(new RegExp(`[${path.delimiter},;]+`))
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(items.length > 0 ? items : fallback)];
}
