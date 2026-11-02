// MCP 认证：独立 API Key（不复用用户 Session），绑定租户。
// 仅存储 SHA-256 哈希，明文仅在创建时返回一次。同时提供 Origin 校验辅助（防 DNS rebinding）。

import crypto from 'node:crypto';
import { callPlatformDatabase } from '../platformDatabaseAccess.js';

export function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(String(rawKey ?? '')).digest('hex');
}

export function validateApiKey(database, rawKey) {
  const trimmed = String(rawKey ?? '').trim();
  if (!trimmed || !trimmed.startsWith('mcp_')) {
    return null;
  }
  const info = database.getMcpApiKeyByHash(hashApiKey(trimmed));
  if (!info) return null;
  return { keyId: info.keyId, tenantId: info.tenantId, scopes: info.scopes };
}

export async function validateApiKeyAsync(database, rawKey) {
  const trimmed = String(rawKey ?? '').trim();
  if (!trimmed || !trimmed.startsWith('mcp_')) return null;
  const info = await callPlatformDatabase(
    database,
    'getMcpApiKeyByHashAsync',
    'getMcpApiKeyByHash',
    hashApiKey(trimmed),
  );
  if (!info) return null;
  return { keyId: info.keyId, tenantId: info.tenantId, scopes: info.scopes };
}

export function generateApiKey(database, { name, tenantId, createdBy, scopes = 'mcp' } = {}) {
  return database.createMcpApiKey({ name, tenantId, createdBy, scopes });
}

export async function generateApiKeyAsync(database, { name, tenantId, createdBy, scopes = 'mcp' } = {}) {
  if (typeof database?.createMcpApiKeyAsync !== 'function') {
    if (database?.isAsyncPlatformStore) {
      throw new Error('Async platform database is missing createMcpApiKeyAsync()');
    }
    return generateApiKey(database, { name, tenantId, createdBy, scopes });
  }
  const rawKey = `mcp_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = hashApiKey(rawKey);
  const keyId = `key_${crypto.randomBytes(6).toString('hex')}`;
  const created = await database.createMcpApiKeyAsync({
    keyId,
    keyHash,
    name,
    tenantId,
    createdBy,
    scopes,
    createdAt: new Date().toISOString(),
  });
  return { ...created, rawKey };
}

export function revokeApiKey(database, keyId) {
  return database.revokeMcpApiKey(keyId);
}

export async function revokeApiKeyAsync(database, keyId) {
  return callPlatformDatabase(database, 'revokeMcpApiKeyAsync', 'revokeMcpApiKey', keyId);
}

export function listApiKeys(database) {
  // Preserve the synchronous SQLite API while routing async stores through
  // their async contract. Callers using a MySQL store must await this result.
  return callPlatformDatabase(database, 'listMcpApiKeysAsync', 'listMcpApiKeys');
}

export async function listApiKeysAsync(database) {
  return await callPlatformDatabase(database, 'listMcpApiKeysAsync', 'listMcpApiKeys');
}
