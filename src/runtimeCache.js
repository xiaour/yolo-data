import crypto from 'node:crypto';

function stableHash(value) {
  const serialized = typeof value === 'string'
    ? value
    : JSON.stringify(value, (_key, item) => (
      item === undefined ? null : item
    ));
  return crypto
    .createHash('sha256')
    .update(serialized)
    .digest('hex')
    .slice(0, 24);
}

function normalizeTtl(value, fallback) {
  const ttl = Number(value);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : fallback;
}

export class RuntimeCache {
  constructor({
    defaultTtlMs = 60_000,
    maxEntries = 512,
  } = {}) {
    this.defaultTtlMs = normalizeTtl(defaultTtlMs, 60_000);
    this.maxEntries = Math.max(1, Number(maxEntries) || 512);
    this.entries = new Map();
  }

  get(namespace, key) {
    const id = `${namespace}:${key}`;
    const entry = this.entries.get(id);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(id);
      return null;
    }
    return entry.value;
  }

  set(namespace, key, value, { ttlMs = null } = {}) {
    const id = `${namespace}:${key}`;
    if (this.entries.size >= this.maxEntries && !this.entries.has(id)) {
      const oldest = [...this.entries.entries()]
        .sort((left, right) => left[1].expiresAt - right[1].expiresAt)[0];
      if (oldest) {
        this.entries.delete(oldest[0]);
      }
    }
    this.entries.set(id, {
      value,
      expiresAt: Date.now() + normalizeTtl(ttlMs, this.defaultTtlMs),
    });
    return value;
  }

  async getOrSet(namespace, key, loader, { ttlMs = null } = {}) {
    const cached = this.get(namespace, key);
    if (cached !== null) {
      return cached;
    }
    const value = await loader();
    return this.set(namespace, key, value, { ttlMs });
  }

  invalidate(namespace = null) {
    if (!namespace) {
      this.entries.clear();
      return;
    }
    const prefix = `${namespace}:`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }
}

export function buildCacheKey(parts = {}) {
  return stableHash(parts);
}

export function valueFingerprint(value) {
  return stableHash(value);
}

export class AgentRuntimeCache {
  constructor(options = {}) {
    this.catalog = new RuntimeCache({
      defaultTtlMs: options.catalogTtlMs ?? 60_000,
      maxEntries: options.maxEntries ?? 256,
    });
    this.indicatorDetails = new RuntimeCache({
      defaultTtlMs: options.indicatorTtlMs ?? 120_000,
      maxEntries: options.maxEntries ?? 256,
    });
    this.semanticContexts = new RuntimeCache({
      defaultTtlMs: options.semanticTtlMs ?? 300_000,
      maxEntries: options.maxEntries ?? 256,
    });
    this.presentationEvidence = new RuntimeCache({
      defaultTtlMs: options.presentationEvidenceTtlMs ?? 60_000,
      maxEntries: options.maxEntries ?? 256,
    });
    this.presentationContracts = new RuntimeCache({
      defaultTtlMs: options.presentationContractTtlMs ?? 30 * 60_000,
      maxEntries: options.maxEntries ?? 256,
    });
  }
}
