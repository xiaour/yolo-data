// MCP 配置读写：存入平台设置表（key='mcp'），5 秒缓存，管理员后台修改后最多 5 秒生效。
// 默认拒绝原则：配置无效时回退到只读模式（disabled 关闭 / read 最小可见）。
import { callPlatformDatabase } from '../platformDatabaseAccess.js';

import { coerce } from './configValues.js';
export { DEFAULT_MCP_CONFIG, getDefaultMcpConfig } from './configValues.js';

const CACHE_TTL = 5000;
let cache = new WeakMap();
function entryFor(database) {
  if (!cache.has(database)) cache.set(database, { value: null, at: 0 });
  return cache.get(database);
}

export function getMcpConfig(database) {
  const entry = entryFor(database);
  const now = Date.now();
  if (entry.value && now - entry.at < CACHE_TTL) {
    return entry.value;
  }
  const record = database.getPlatformSetting('mcp', null);
  const raw = record && record.value && typeof record.value === 'object' ? record.value : null;
  const cfg = coerce(raw);
  cache.set(database, { value: cfg, at: now });
  return cfg;
}

export function setMcpConfig(database, patch) {
  const next = coerce(patch && typeof patch === 'object' ? patch : {});
  database.savePlatformSetting('mcp', next);
  cache.set(database, { value: next, at: Date.now() });
  return next;
}

export async function getMcpConfigAsync(database) {
  const entry = entryFor(database);
  const now = Date.now();
  if (entry.value && now - entry.at < CACHE_TTL) return entry.value;
  const record = await callPlatformDatabase(database, 'getPlatformSettingAsync', 'getPlatformSetting', 'mcp', null);
  const cfg = coerce(record?.value);
  if (cache.get(database) !== entry) return cache.get(database)?.value ?? cfg;
  cache.set(database, { value: cfg, at: now });
  return cfg;
}

export async function setMcpConfigAsync(database, patch) {
  const next = coerce(patch && typeof patch === 'object' ? patch : {});
  await callPlatformDatabase(database, 'savePlatformSettingAsync', 'savePlatformSetting', 'mcp', next);
  cache.set(database, { value: next, at: Date.now() });
  return next;
}

// 仅用于测试或进程内重置，避免缓存陈旧。
export function _resetMcpConfigCache() {
  cache = new WeakMap();
}
