import { resolveRecentDateInfo } from './timeSemantics.js';

function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

function unwrapPayload(payload) {
  if (payload && typeof payload === 'object' && 'data' in payload
      && ('code' in payload || 'success' in payload || 'message' in payload)) {
    return payload.data;
  }
  return payload;
}

function normalizePage(payload) {
  const data = unwrapPayload(payload) ?? {};
  const list = Array.isArray(data)
    ? data
    : data.list ?? data.records ?? data.resultList ?? data.rows ?? [];
  return {
    list: Array.isArray(list) ? list : [],
    total: Number(data.total ?? data.totalCount ?? list.length ?? 0),
    pageNum: Number(data.pageNum ?? data.pageNo ?? 1),
    pageSize: Number(data.pageSize ?? list.length ?? 0),
    raw: payload,
  };
}

function parseTokenExpiry(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    );
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp : null;
  } catch {
    return null;
  }
}

export class SupersonicIndicatorClient {
  constructor({
    baseUrl,
    token = '',
    appKey = '',
    serviceClientId = '',
    serviceClientSecret = '',
    timeoutMs = 30_000,
    fetchImpl = fetch,
  }) {
    if (!baseUrl) {
      throw new Error('Supersonic base URL is required');
    }
    this.baseUrl = baseUrl;
    this.token = token;
    this.appKey = String(appKey ?? '').trim();
    this.serviceClientId = String(serviceClientId ?? '').trim();
    this.serviceClientSecret = String(serviceClientSecret ?? '').trim();
    this.tokenExpiresAt = parseTokenExpiry(token);
    this.tokenRequest = null;
    this.serviceTokenAttempted = false;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.mode = 'supersonic';
  }

  hasUsableToken() {
    if (!this.token) {
      return false;
    }
    if (!this.tokenExpiresAt) {
      return true;
    }
    return Date.now() < (this.tokenExpiresAt - 60) * 1000;
  }

  async ensureAuthentication() {
    if (
      this.serviceClientId
      && this.serviceClientSecret
      && !this.serviceTokenAttempted
    ) {
      this.serviceTokenAttempted = true;
      try {
        await this.exchangeServiceToken();
        return;
      } catch (error) {
        if (!this.hasUsableToken()) {
          throw error;
        }
      }
    }
    if (this.hasUsableToken()) {
      return;
    }
    if (!this.serviceClientId || !this.serviceClientSecret) {
      if (this.tokenExpiresAt && Date.now() >= this.tokenExpiresAt * 1000) {
        const expiredAt = new Date(this.tokenExpiresAt * 1000).toLocaleString('zh-CN', {
          hour12: false,
        });
        throw new Error(`Supersonic Token 已于 ${expiredAt} 过期，请重新登录并更新 Token`);
      }
      return;
    }
    if (!this.tokenRequest) {
      this.tokenRequest = this.exchangeServiceToken().finally(() => {
        this.tokenRequest = null;
      });
    }
    await this.tokenRequest;
  }

  async exchangeServiceToken() {
    const url = new URL(joinUrl(this.baseUrl, '/api/auth/service/token'));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientId: this.serviceClientId,
          clientSecret: this.serviceClientSecret,
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = { message: text };
      }
      if (!response.ok) {
        throw new Error(
          `Supersonic service token request failed (${response.status}): ${
            payload?.message ?? payload?.msg ?? response.statusText
          }`,
        );
      }
      const code = Number(payload?.code ?? 200);
      if (code !== 200) {
        throw new Error(
          `Supersonic service token error (${code}): ${
            payload?.msg ?? payload?.message ?? 'unknown error'
          }`,
        );
      }
      const data = unwrapPayload(payload);
      if (!data?.token) {
        throw new Error('Supersonic service token response did not contain a token');
      }
      this.token = String(data.token);
      this.appKey = String(data.appKey ?? this.appKey ?? '').trim();
      this.tokenExpiresAt = Number(data.expireAt)
        ? Math.floor(Number(data.expireAt) / 1000)
        : parseTokenExpiry(this.token);
      return this.token;
    } finally {
      clearTimeout(timeout);
    }
  }

  async request(path, { method = 'GET', body, query } = {}) {
    await this.ensureAuthentication();
    const url = new URL(joinUrl(this.baseUrl, path));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.token) {
      headers.Authorization = this.token.startsWith('Bearer ') ? this.token : `Bearer ${this.token}`;
      headers['login-token'] = this.token.replace(/^Bearer\s+/i, '');
    }
    if (this.appKey) {
      headers['App-Key'] = this.appKey;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      }
      if (!response.ok) {
        const message = payload?.message ?? payload?.error ?? text ?? response.statusText;
        throw new Error(`Supersonic request failed (${response.status}): ${message}`);
      }
      if (payload && typeof payload === 'object' && 'code' in payload) {
        const code = Number(payload.code);
        if (code !== 200) {
          const message = payload.msg ?? payload.message ?? payload.error ?? 'unknown error';
          throw new Error(`Supersonic API error (${code}): ${message}`);
        }
      }
      return unwrapPayload(payload);
    } finally {
      clearTimeout(timeout);
    }
  }

  async health() {
    await this.request('/api/semantic/asset/indicatorType/query', {
      query: { status: 1 },
    });
    return true;
  }

  async listTypes() {
    const payload = await this.request('/api/semantic/asset/indicatorType/query', {
      query: { status: 1 },
    });
    const list = Array.isArray(payload) ? payload : payload?.list ?? [];
    return list;
  }

  async listIndicators({ keyword = '', typeId = '', current = 1, pageSize = 500 } = {}) {
    const payload = await this.request('/api/semantic/asset/indicator/query', {
      method: 'POST',
      body: {
        current,
        pageSize: Math.min(Number(pageSize) || 500, 500),
        key: keyword || undefined,
        typeId: typeId || undefined,
      },
    });
    return normalizePage(payload);
  }

  async listCatalog({
    keyword = '',
    typeId = '',
    current = 1,
    pageSize = 500,
  } = {}) {
    try {
      const payload = await this.request('/api/semantic/asset/indicator/catalog', {
        method: 'POST',
        body: {
          current,
          pageSize: Math.min(Number(pageSize) || 500, 500),
          key: keyword || undefined,
          typeId: typeId || undefined,
        },
      });
      return normalizePage(payload);
    } catch (error) {
      if (/\(401\)|\(403\)/.test(error.message)) {
        throw error;
      }
      return this.listIndicators({ keyword, typeId, current, pageSize });
    }
  }

  async getIndicator(id) {
    const payload = await this.request(
      `/api/semantic/asset/indicator/detail/${encodeURIComponent(id)}`,
    );
    return unwrapPayload(payload);
  }

  async queryDimensionValues({
    elementId,
    modelId,
    bizName,
    value = '',
    dateField = '',
  } = {}) {
    const endDate = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 2 * 365 * 86400000)
      .toISOString()
      .slice(0, 10);
    const payload = await this.request('/api/semantic/dimension/queryDimValue', {
      method: 'POST',
      body: {
        elementID: Number(elementId),
        modelId: Number(modelId),
        bizName,
        value: String(value ?? ''),
        dataSetIds: [],
        dateInfo: {
          dateMode: 'ALL',
          startDate,
          endDate,
          dateField: dateField || undefined,
        },
      },
    });
    const rows = payload?.resultList ?? payload?.list ?? [];
    return [...new Set(rows
      .map((row) => row?.[bizName] ?? Object.values(row ?? {})[0])
      .map((item) => String(item ?? '').trim())
      .filter(Boolean))].slice(0, 500);
  }

  async queryIndicator({
    metricNames = [],
    dimensionNames = [],
    filters = [],
    dateInfo,
    limit = 200,
  } = {}) {
    const effectiveDateInfo = String(dateInfo?.dateMode ?? '').toUpperCase() === 'RECENT'
      ? { ...dateInfo, ...resolveRecentDateInfo(dateInfo) }
      : dateInfo;
    const payload = await this.request('/api/semantic/query/metric', {
      method: 'POST',
      body: {
        metricNames,
        dimensionNames,
        filters,
        dateInfo: effectiveDateInfo,
        limit: Math.max(1, Math.min(Number(limit) || 200, 2000)),
      },
    });
    return payload ?? { columns: [], resultList: [] };
  }

  async queryIndicatorPresentationEvidence(args = {}) {
    return this.queryIndicator(args);
  }

  async queryIndicatorFormatted(args = {}) {
    return this.queryIndicatorPresentationEvidence(args);
  }
}

export class UnavailableIndicatorClient {
  constructor(message = 'Supersonic 指标系统尚未配置，无法执行指标查询') {
    this.message = message;
    this.mode = 'unconfigured';
  }

  fail() {
    throw new Error(this.message);
  }

  async listTypes() {
    return this.fail();
  }

  async listIndicators() {
    return this.fail();
  }

  async listCatalog() {
    return this.fail();
  }

  async getIndicator() {
    return this.fail();
  }

  async queryIndicator() {
    return this.fail();
  }

  async queryIndicatorPresentationEvidence() {
    return this.fail();
  }

  async queryIndicatorFormatted() {
    return this.fail();
  }
}

export function createSupersonicIndicatorClient(config) {
  return new SupersonicIndicatorClient(config);
}

export { normalizePage, unwrapPayload };
