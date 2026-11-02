export {
  hashApiKey, validateApiKey, validateApiKeyAsync,
  generateApiKey, generateApiKeyAsync, revokeApiKey, revokeApiKeyAsync,
  listApiKeys, listApiKeysAsync,
} from './apiKeys.js';

// Origin 校验：当配置了允许源时才强制；未配置则放行（真实门禁是 API Key + 管理员开关）。
export function isOriginAllowed(origin, allowedOrigins) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    return true;
  }
  if (!origin) return false;
  try {
    const req = new URL(origin);
    return allowedOrigins.some((allowed) => {
      try {
        const a = new URL(allowed);
        return req.hostname === a.hostname
          && req.protocol === a.protocol
          && (req.port || (req.protocol === 'https:' ? '443' : '80')) === (a.port || (a.protocol === 'https:' ? '443' : '80'));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
