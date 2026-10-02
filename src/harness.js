import crypto from 'node:crypto';

function parseToolArguments(value) {
  if (!value) {
    return {};
  }
  if (typeof value === 'object') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function lastUserMessage(messages) {
  return [...(messages ?? [])].reverse()
    .find((message) => message.role === 'user')?.content ?? '';
}

function truncate(value, maxLength = 240) {
  const text = String(value ?? '');
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function normalizeMatchText(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '').trim();
}

function fieldAliases(field) {
  return [
    field?.name,
    field?.fieldName,
    field?.displayName,
    field?.bizName,
  ].map(normalizeMatchText).filter(Boolean);
}

function matchingFields(question, fields, role = null) {
  const text = normalizeMatchText(question);
  return (fields ?? []).filter((field) => {
    if (role && field.role !== role) {
      return false;
    }
    return fieldAliases(field).some((alias) => text.includes(alias));
  });
}

function scoreBusinessDataset(question, dataset) {
  const text = normalizeMatchText(question);
  const fields = dataset?.fields ?? [];
  const matchedFields = fields.filter((field) => (
    fieldAliases(field).some((alias) => text.includes(alias))
  ));
  const matchedValues = fields.flatMap((field) => (
    (field.valueDomain?.values ?? field.values ?? [])
      .map((value) => normalizeMatchText(value?.value ?? value))
      .filter((value) => value && text.includes(value))
  ));
  if (matchedFields.length === 0 && matchedValues.length === 0) {
    return { score: 0, matchedConcepts: 0 };
  }
  const name = normalizeMatchText(dataset?.name);
  const code = normalizeMatchText(dataset?.code);
  let score = matchedFields.length * 10 + matchedValues.length * 4;
  if (name && text.includes(name)) {
    score += 8;
  }
  if (code && text.includes(code)) {
    score += 6;
  }
  return {
    score,
    matchedConcepts: matchedFields.length + matchedValues.length,
  };
}

function selectBusinessDataset(question, datasets) {
  const ranked = (datasets ?? [])
    .map((dataset) => ({
      dataset,
      ...scoreBusinessDataset(question, dataset),
    }))
    .filter((item) => item.matchedConcepts > 0)
    .sort((left, right) => right.score - left.score);
  if (
    ranked.length === 0
    || ranked[0].score <= 0
    || (ranked[1] && ranked[1].score === ranked[0].score)
  ) {
    return null;
  }
  return ranked[0].dataset;
}

export class OpenAICompatibleDeepSeekHarness {
  constructor({
    baseUrl,
    apiKey,
    model,
    temperature = 0,
    maxTokens = 0,
    timeoutMs = 60_000,
    maxToolRounds = 12,
    fetchImpl = fetch,
    provider = 'deepseek',
    onCall = null,
  }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.timeoutMs = timeoutMs;
    this.maxToolRounds = maxToolRounds;
    this.fetchImpl = fetchImpl;
    this.provider = provider;
    this.onCall = onCall;
    this.mode = 'deepseek';
    this.capabilities = {
      toolCalling: true,
      multiTurn: true,
      skills: true,
      streaming: false,
    };
  }

  async run({
    messages,
    tools,
    executeTool,
    metadata = {},
    onEvent = null,
  }) {
    const conversation = [...messages];
    const trace = [];
    for (let round = 0; round < this.maxToolRounds; round += 1) {
      onEvent?.({
        type: 'llm_request',
        round: round + 1,
        provider: this.provider,
        model: this.model,
        messageCount: conversation.length,
        toolCount: tools?.length ?? 0,
      });
      const response = await this.chat(conversation, tools, metadata);
      const choice = response?.choices?.[0]?.message;
      if (!choice) {
        throw new Error('DeepSeek returned an empty response');
      }
      onEvent?.({
        type: 'llm_response',
        round: round + 1,
        provider: this.provider,
        model: this.model,
        content: truncate(choice.content, 500),
        toolCalls: (choice.tool_calls ?? []).map((toolCall) => ({
          name: toolCall.function?.name,
          args: parseToolArguments(toolCall.function?.arguments),
        })),
        usage: response.usage ?? null,
      });
      conversation.push(choice);

      const toolCalls = choice.tool_calls ?? [];
      if (toolCalls.length === 0) {
        return {
          content: choice.content ?? '',
          trace,
          usage: response.usage ?? null,
        };
      }

      for (const toolCall of toolCalls) {
        const name = toolCall.function?.name;
        const args = parseToolArguments(toolCall.function?.arguments);
        trace.push({ type: 'tool_call', name, args });
        try {
          const result = await executeTool(name, args);
          trace.push({
            type: 'tool_result',
            name,
            summary: summarizeToolResult(result),
          });
          if (result?.stopAgent) {
            return {
              content: result.finalMessage ?? result.summary ?? '',
              trace,
              usage: response.usage ?? null,
              stoppedByResultLock: true,
            };
          }
          conversation.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        } catch (error) {
          const result = { error: error.message };
          trace.push({ type: 'tool_error', name, message: error.message });
          if (error.terminal) {
            return {
              content: error.message,
              trace,
              usage: response.usage ?? null,
              stoppedByTerminalError: true,
            };
          }
          conversation.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }
      }
    }

    return {
      content: '已达到工具调用轮次上限，请缩小问题范围后重试。',
      trace,
      stoppedByLimit: true,
    };
  }

  async chat(messages, tools, metadata = {}) {
    const startedAt = Date.now();
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(),
      this.timeoutMs,
    );
    const signal = metadata.signal
      ? AbortSignal.any([timeoutController.signal, metadata.signal])
      : timeoutController.signal;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools,
          tool_choice: 'auto',
          temperature: this.temperature,
          ...(Number(this.maxTokens) > 0 ? { max_tokens: Number(this.maxTokens) } : {}),
        }),
        signal,
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = { raw: text };
      }
      if (!response.ok) {
        throw new Error(
          `DeepSeek request failed (${response.status}): ${payload?.error?.message ?? text}`,
        );
      }
      this.onCall?.({
        ...metadata,
        callType: metadata.callType ?? 'AGENT_TOOL_ROUND',
        provider: this.provider,
        model: this.model,
        messages,
        response: payload?.choices?.[0]?.message?.content
          ?? payload?.choices?.[0]?.message?.tool_calls
          ?? '',
        tokenUsage: payload?.usage ?? {},
        latencyMs: Date.now() - startedAt,
        success: true,
        errorMessage: '',
      });
      return payload;
    } catch (error) {
      this.onCall?.({
        ...metadata,
        callType: metadata.callType ?? 'AGENT_TOOL_ROUND',
        provider: this.provider,
        model: this.model,
        messages,
        response: '',
        tokenUsage: {},
        latencyMs: Date.now() - startedAt,
        success: false,
        errorMessage: error.message,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class RuleBasedHarness {
  constructor({ onCall = null } = {}) {
    this.onCall = onCall;
    this.mode = 'local-rule';
    this.capabilities = {
      toolCalling: true,
      multiTurn: true,
      skills: true,
      streaming: false,
    };
  }

  async run({
    messages,
    executeTool,
    metadata = {},
    onEvent = null,
  }) {
    const startedAt = Date.now();
    const question = String(lastUserMessage(messages));
    const effectiveQuestion = contextualizeQuestion(messages);
    const trace = [];
    onEvent?.({
      type: 'runtime_request',
      provider: 'local-rule',
      model: 'rule-based',
      messageCount: messages?.length ?? 0,
    });
    if (metadata.preferBusinessDatasets) {
      trace.push({
        type: 'tool_call',
        name: 'list_business_datasets',
        args: {},
      });
      const catalog = await executeTool('list_business_datasets', {});
      trace.push({
        type: 'tool_result',
        name: 'list_business_datasets',
        summary: summarizeToolResult(catalog),
      });
      const relevantDataset = selectBusinessDataset(effectiveQuestion, catalog?.datasets);
      const dataset = relevantDataset
        ?? (metadata.preferBusinessDatasets ? null : catalog?.datasets?.[0]);
      if (metadata.preferBusinessDatasets && !dataset) {
        const content = '指标平台尚未配置，当前已接入的业务数据集无法回答该问题。请配置指标平台，或补充相关业务数据集。';
        this.onCall?.({
          ...metadata,
          callType: 'AGENT_RULE_FALLBACK',
          provider: 'local-rule',
          model: 'rule-based',
          messages,
          response: content,
          tokenUsage: {},
          latencyMs: Date.now() - startedAt,
          success: true,
          errorMessage: '',
        });
        onEvent?.({
          type: 'runtime_response',
          provider: 'local-rule',
          model: 'rule-based',
          content,
          toolCalls: trace
            .filter((item) => item.type === 'tool_call')
            .map((item) => ({ name: item.name, args: item.args })),
          latencyMs: Date.now() - startedAt,
        });
        return { content, trace };
      }
      if (dataset?.fields?.length) {
        const definitionArgs = { datasetId: dataset.id };
        trace.push({
          type: 'tool_call',
          name: 'get_business_dataset_definition',
          args: definitionArgs,
        });
        const definition = await executeTool(
          'get_business_dataset_definition',
          definitionArgs,
        );
        trace.push({
          type: 'tool_result',
          name: 'get_business_dataset_definition',
          summary: summarizeToolResult(definition),
        });
        const fields = new Map(dataset.fields.map((field) => [field.name, field]));
        const metricFields = matchingFields(
          effectiveQuestion,
          dataset.fields,
          'METRIC',
        ).map((field) => field.name ?? field.fieldName).filter(Boolean);
        if (metricFields.length === 0) {
          const content = '本地规则运行时未找到与问题明确匹配的指标字段，且不会按相似名称猜测。请配置主题大模型或业务语义包后重试。';
          this.onCall?.({
            ...metadata,
            callType: 'AGENT_RULE_FALLBACK',
            provider: 'local-rule',
            model: 'rule-based',
            messages,
            response: content,
            tokenUsage: {},
            latencyMs: Date.now() - startedAt,
            success: false,
            errorMessage: 'metric mapping unresolved',
          });
          onEvent?.({
            type: 'runtime_response',
            provider: 'local-rule',
            model: 'rule-based',
            content,
            toolCalls: trace
              .filter((item) => item.type === 'tool_call')
              .map((item) => ({ name: item.name, args: item.args })),
            latencyMs: Date.now() - startedAt,
          });
          return { content, trace };
        }
        const dimensionFields = matchingFields(
          effectiveQuestion,
          dataset.fields.filter((field) => field.role !== 'METRIC'),
        ).map((field) => field.name ?? field.fieldName).filter(Boolean);
        if (
          (metadata.analysisMode === 'TREND' || /趋势|走势|按日|每天/.test(effectiveQuestion))
          && !dimensionFields.some((fieldName) => fields.get(fieldName)?.role === 'TIME')
        ) {
          const timeField = dataset.fields.find((field) => field.role === 'TIME');
          if (timeField) {
            dimensionFields.push(timeField.name ?? timeField.fieldName);
          }
        }
        const filters = [];
        for (const field of dataset.fields) {
          const values = field.valueDomain?.values ?? field.values ?? [];
          const matchedValue = values
            .map((value) => value?.value ?? value)
            .find((value) => (
              value && normalizeMatchText(effectiveQuestion).includes(normalizeMatchText(value))
            ));
          if (matchedValue !== undefined && matchedValue !== null) {
            filters.push({
              field: field.name ?? field.fieldName,
              operator: '=',
              value: matchedValue,
            });
          }
        }
        const queryArgs = {
          datasetId: dataset.id,
          metrics: metricFields.map((field) => ({
            field,
            aggregator: fields.get(field)?.aggregator ?? 'SUM',
          })),
          dimensions: dimensionFields,
          filters,
          limit: 500,
        };
        trace.push({
          type: 'tool_call',
          name: 'query_business_dataset',
          args: queryArgs,
        });
        const result = await executeTool('query_business_dataset', queryArgs);
        trace.push({
          type: 'tool_result',
          name: 'query_business_dataset',
          summary: summarizeToolResult(result),
        });
        const content = result.summary || `已完成「${dataset.name}」业务数据查询。`;
        this.onCall?.({
          ...metadata,
          callType: 'AGENT_RULE_FALLBACK',
          provider: 'local-rule',
          model: 'rule-based',
          messages,
          response: content,
          tokenUsage: {},
          latencyMs: Date.now() - startedAt,
          success: true,
          errorMessage: '',
        });
        onEvent?.({
          type: 'runtime_response',
          provider: 'local-rule',
          model: 'rule-based',
          content: truncate(content, 500),
          toolCalls: trace
            .filter((item) => item.type === 'tool_call')
            .map((item) => ({ name: item.name, args: item.args })),
          latencyMs: Date.now() - startedAt,
        });
        return { content, trace };
      }
    }
    if (
      metadata.sourceMode
      && !['supersonic'].includes(String(metadata.sourceMode))
    ) {
      const content = '指标平台尚未配置，无法执行真实指标查询。请配置指标平台后重试。';
      this.onCall?.({
        ...metadata,
        callType: 'AGENT_RULE_FALLBACK',
        provider: 'local-rule',
        model: 'rule-based',
        messages,
        response: content,
        tokenUsage: {},
        latencyMs: Date.now() - startedAt,
        success: true,
        errorMessage: '',
      });
      onEvent?.({
        type: 'runtime_response',
        provider: 'local-rule',
        model: 'rule-based',
        content,
        toolCalls: trace
          .filter((item) => item.type === 'tool_call')
          .map((item) => ({ name: item.name, args: item.args })),
        latencyMs: Date.now() - startedAt,
      });
      return { content, trace };
    }
    const searchArgs = { keyword: effectiveQuestion, limit: 8 };
    trace.push({ type: 'tool_call', name: 'search_indicators', args: searchArgs });
    const candidates = await executeTool('search_indicators', searchArgs);
    trace.push({
      type: 'tool_result',
      name: 'search_indicators',
      summary: summarizeToolResult(candidates),
    });

    if (!candidates?.indicators?.length) {
      this.onCall?.({
        ...metadata,
        callType: 'AGENT_RULE_FALLBACK',
        provider: 'local-rule',
        model: 'rule-based',
        messages,
        response: 'no indicator matched',
        tokenUsage: {},
        latencyMs: Date.now() - startedAt,
        success: true,
        errorMessage: '',
      });
      onEvent?.({
        type: 'runtime_response',
        provider: 'local-rule',
        model: 'rule-based',
        content: 'no indicator matched',
        toolCalls: trace
          .filter((item) => item.type === 'tool_call')
          .map((item) => ({ name: item.name, args: item.args })),
        latencyMs: Date.now() - startedAt,
      });
      return {
        content: '当前主题下没有找到可访问的指标，请调整问题或联系管理员配置指标权限。',
        trace,
      };
    }

    const indicator = candidates.indicators[0];
    const detailArgs = { indicatorId: indicator.id };
    trace.push({ type: 'tool_call', name: 'get_indicator', args: detailArgs });
    const detail = await executeTool('get_indicator', detailArgs);
    trace.push({
      type: 'tool_result',
      name: 'get_indicator',
      summary: summarizeToolResult(detail),
    });

    const dimensions = selectDimensions(effectiveQuestion, detail);
    const queryArgs = {
      indicatorId: indicator.id,
      dimensions,
      filters: extractQuestionFilters(effectiveQuestion, detail),
      dateRange: extractDateRange(effectiveQuestion),
      limit: 200,
    };
    trace.push({ type: 'tool_call', name: 'query_indicator', args: queryArgs });
    const result = await executeTool('query_indicator', queryArgs);
    trace.push({
      type: 'tool_result',
      name: 'query_indicator',
      summary: summarizeToolResult(result),
    });

    const content = result.summary || `已完成「${indicator.name}」查询。`;
    this.onCall?.({
      ...metadata,
      callType: 'AGENT_RULE_FALLBACK',
      provider: 'local-rule',
      model: 'rule-based',
      messages,
      response: content,
      tokenUsage: {},
      latencyMs: Date.now() - startedAt,
      success: true,
      errorMessage: '',
    });
    onEvent?.({
      type: 'runtime_response',
      provider: 'local-rule',
      model: 'rule-based',
      content: truncate(content, 500),
      toolCalls: trace
        .filter((item) => item.type === 'tool_call')
        .map((item) => ({ name: item.name, args: item.args })),
      latencyMs: Date.now() - startedAt,
    });
    return {
      content,
      trace,
    };
  }
}

function contextualizeQuestion(messages) {
  const userMessages = (messages ?? [])
    .filter((message) => message.role === 'user')
    .map((message) => String(message.content ?? '').trim())
    .filter(Boolean);
  const current = userMessages.at(-1) ?? '';
  const previous = userMessages.slice(-3, -1);
  if (previous.length === 0) {
    return current;
  }
  const needsContext = current.length < 18
    || /^(那|再|换|按|这个|上述|它|他|她|还有|呢)|同比|环比|继续/.test(current);
  return needsContext ? `${previous.join('；')}；${current}` : current;
}

function summarizeToolResult(result) {
  if (!result || typeof result !== 'object') {
    return truncate(result);
  }
  if (Array.isArray(result.indicators)) {
    return `matched ${result.indicators.length} indicators`;
  }
  if (result.summary) {
    return truncate(result.summary, 500);
  }
  if (result.error) {
    return result.error;
  }
  return truncate(JSON.stringify(result), 500);
}

function selectDimensions(question, detail) {
  const available = new Set((detail.dimensions ?? []).flatMap((dimension) => [
    dimension.dimensionBizName,
    dimension.bizName,
    dimension.dimensionName,
    dimension.name,
  ]).filter(Boolean));
  const requested = [];
  if (/趋势|走势|变化|每天|按日|日级|近\d+天|最近\d+天/.test(question) && available.has('date')) {
    requested.push('date');
  }
  for (const dimension of ['region', 'channel', 'category', 'warehouse', 'carrier', 'customer_type']) {
    if (available.has(dimension) && new RegExp(
      `${dimension}|${
        {
          region: '区域|大区|地区',
          channel: '渠道',
          category: '品类|分类',
          warehouse: '仓库|仓',
          carrier: '承运商|物流',
          customer_type: '客户类型|客群',
        }[dimension]
      }`,
    ).test(question)) {
      requested.push(dimension);
    }
  }
  if (requested.length === 0 && /对比|排名|排行|分布|构成|各|top/i.test(question)) {
    const fallback = ['region', 'channel', 'category', 'warehouse', 'carrier']
      .find((dimension) => available.has(dimension));
    if (fallback) {
      requested.push(fallback);
    }
  }
  return [...new Set(requested)].slice(0, 2);
}

function extractQuestionFilters(question, detail) {
  const filters = [];
  const candidateDimensions = (detail.dimensions ?? []).map(
    (dimension) => dimension.dimensionBizName ?? dimension.bizName,
  ).filter(Boolean);
  if (candidateDimensions.includes('region')) {
    const region = ['华东', '华南', '华北', '西南'].find(
      (value) => question.includes(value),
    );
    if (region) {
      filters.push({ bizName: 'region', operator: 'IN', value: [region] });
    }
  }
  if (candidateDimensions.includes('channel')) {
    const channel = ['线上', '门店', '分销', '团购'].find(
      (value) => question.includes(value),
    );
    if (channel) {
      filters.push({ bizName: 'channel', operator: 'IN', value: [channel] });
    }
  }
  return filters;
}

function extractDateRange(question) {
  const match = question.match(/(?:最近|近)\s*(\d+)\s*(天|周|月|季度|年)/);
  if (!match) {
    return undefined;
  }
  const unit = Number(match[1]);
  const periodMap = {
    天: 'DAY',
    周: 'WEEK',
    月: 'MONTH',
    季度: 'QUARTER',
    年: 'YEAR',
  };
  return {
    dateMode: 'RECENT',
    unit,
    period: periodMap[match[2]],
  };
}

export function createHarness(deepseekConfig) {
  if (deepseekConfig.apiKey) {
    return new OpenAICompatibleDeepSeekHarness(deepseekConfig);
  }
  return new RuleBasedHarness();
}

export class HarnessFactory {
  constructor(
    baseConfig,
    fetchImpl = fetch,
    onCall = null,
    credentialCrypto = null,
  ) {
    this.baseConfig = baseConfig;
    this.fetchImpl = fetchImpl;
    this.onCall = onCall;
    this.credentialCrypto = credentialCrypto;
    this.cache = new Map();
  }

  forTheme(themeConfig = {}) {
    const storedApiKey = themeConfig.apiKeyEncrypted && this.credentialCrypto
      ? this.credentialCrypto.decrypt(themeConfig.apiKeyEncrypted)
      : '';
    const merged = {
      baseUrl: String(themeConfig.baseUrl || this.baseConfig.baseUrl || '').replace(/\/+$/, ''),
      model: String(themeConfig.model || this.baseConfig.model || 'deepseek-chat'),
      temperature: themeConfig.temperature === undefined
        ? (this.baseConfig.temperature ?? 0)
        : Number(themeConfig.temperature ?? 0),
      maxTokens: Number(themeConfig.maxTokens ?? this.baseConfig.maxTokens ?? 0),
      timeoutMs: Number(themeConfig.timeoutMs ?? this.baseConfig.timeoutMs ?? 60_000),
      maxToolRounds: Number(
        themeConfig.maxToolRounds ?? this.baseConfig.maxToolRounds ?? 12,
      ),
      apiKey: String(storedApiKey || '').trim()
        || (themeConfig.apiKeyEnv
          ? String(process.env[themeConfig.apiKeyEnv] ?? '').trim()
          : this.baseConfig.apiKey),
      provider: themeConfig.provider || 'deepseek',
    };
    if (!merged.apiKey) {
      if (!this.cache.has('local-rule')) {
        this.cache.set('local-rule', new RuleBasedHarness({ onCall: this.onCall }));
      }
      return this.cache.get('local-rule');
    }
    const cacheKey = JSON.stringify({
      baseUrl: merged.baseUrl,
      model: merged.model,
      temperature: merged.temperature,
      maxTokens: merged.maxTokens,
      maxToolRounds: merged.maxToolRounds,
      provider: merged.provider,
      apiKeyFingerprint: crypto
        .createHash('sha256')
        .update(String(merged.apiKey))
        .digest('hex')
        .slice(0, 16),
    });
    if (!this.cache.has(cacheKey)) {
      this.cache.set(cacheKey, new OpenAICompatibleDeepSeekHarness({
        ...merged,
        fetchImpl: this.fetchImpl,
        onCall: this.onCall,
      }));
    }
    return this.cache.get(cacheKey);
  }
}
