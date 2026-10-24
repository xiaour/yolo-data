export const DEFAULT_MCP_CONFIG = {
  enabled: false,
  mode: 'read',
  toolOverrides: {},
  tenantScope: [],
  rateLimit: { rpm: 60, burst: 10 },
  audit: { enabled: true, level: 'full' },
  sessionMode: 'stateful',
};

const VALID_MODES = ['disabled', 'read', 'standard', 'full'];


export function getDefaultMcpConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_MCP_CONFIG));
}

export function coerce(raw) {
  const cfg = getDefaultMcpConfig();
  if (!raw || typeof raw !== 'object') {
    return cfg;
  }
  if (typeof raw.enabled === 'boolean') cfg.enabled = raw.enabled;
  if (VALID_MODES.includes(raw.mode)) cfg.mode = raw.mode;
  if (raw.toolOverrides && typeof raw.toolOverrides === 'object') {
    cfg.toolOverrides = { ...raw.toolOverrides };
  }
  if (Array.isArray(raw.tenantScope)) cfg.tenantScope = raw.tenantScope.map(String);
  if (raw.rateLimit && typeof raw.rateLimit === 'object') {
    const rpm = Number(raw.rateLimit.rpm);
    const burst = Number(raw.rateLimit.burst);
    if (Number.isFinite(rpm) && rpm > 0) cfg.rateLimit.rpm = rpm;
    if (Number.isFinite(burst) && burst > 0) cfg.rateLimit.burst = burst;
  }
  if (raw.audit && typeof raw.audit === 'object') {
    if (typeof raw.audit.enabled === 'boolean') cfg.audit.enabled = raw.audit.enabled;
    if (['full', 'summary', 'off'].includes(raw.audit.level)) cfg.audit.level = raw.audit.level;
  }
  if (raw.sessionMode === 'stateless' || raw.sessionMode === 'stateful') {
    cfg.sessionMode = raw.sessionMode;
  }
  return cfg;
}
