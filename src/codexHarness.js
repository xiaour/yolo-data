import fs from 'node:fs';

import { CodexAppServerClient } from './codexAppServerClient.js';

const CODEX_PROVIDER_API_KEY_ENV = 'YOLO_CODEX_PROVIDER_API_KEY';

function configArg(key, value) {
  return ['-c', `${key}=${JSON.stringify(String(value))}`];
}

export function buildCodexRuntime({
  provider = 'ollama',
  providerBaseUrl = '',
  providerApiKey = '',
  wireApi = 'responses',
  args = null,
  env = process.env,
} = {}) {
  if (Array.isArray(args) && args.length > 0) return { args, env };
  const normalizedProvider = String(provider ?? 'ollama').trim().toLowerCase() || 'ollama';
  const runtimeArgs = ['app-server', '--stdio'];
  const runtimeEnv = { ...env };
  if (['ollama', 'lmstudio'].includes(normalizedProvider)) {
    runtimeArgs.push(...configArg('model_provider', normalizedProvider));
    return { args: runtimeArgs, env: runtimeEnv };
  }
  if (normalizedProvider === 'openai') {
    runtimeArgs.push(...configArg('model_provider', 'openai'));
    return { args: runtimeArgs, env: runtimeEnv };
  }

  const providerId = 'yolo_runtime';
  runtimeArgs.push(
    ...configArg('model_provider', providerId),
    ...configArg(`model_providers.${providerId}.name`, 'YOLO Runtime Provider'),
    ...configArg(`model_providers.${providerId}.base_url`, providerBaseUrl),
    ...configArg(`model_providers.${providerId}.wire_api`, wireApi),
    '-c', `model_providers.${providerId}.requires_openai_auth=false`,
  );
  if (String(providerApiKey ?? '').trim()) {
    runtimeEnv[CODEX_PROVIDER_API_KEY_ENV] = String(providerApiKey).trim();
    runtimeArgs.push(...configArg(`model_providers.${providerId}.env_key`, CODEX_PROVIDER_API_KEY_ENV));
  }
  return { args: runtimeArgs, env: runtimeEnv };
}

function dynamicTools(tools = []) {
  return tools
    .filter((tool) => tool?.type === 'function' && tool.function?.name)
    .map((tool) => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description ?? '',
      inputSchema: tool.function.parameters ?? { type: 'object', properties: {} },
    }));
}

function conversationInput(messages = []) {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const role = message.role === 'assistant' ? 'ASSISTANT' : message.role === 'tool' ? 'TOOL' : 'USER';
      return `${role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`;
    })
    .join('\n\n');
}

function currentTurnInput(messages = [], metadata = {}) {
  const originalQuestion = String(metadata.originalQuestion ?? metadata.question ?? '').trim();
  const messageQuestion = [...messages]
    .reverse()
    .find((message) => message.role === 'user')?.content ?? '';
  const question = originalQuestion || String(messageQuestion ?? '').trim();
  const replanHint = String(metadata.replanHint ?? '').trim();
  return replanHint
    ? `${question}\n\n[YOLO recovery guidance] ${replanHint}`
    : question;
}

function bootstrapCodexTurnInput(messages = [], metadata = {}) {
  const current = currentTurnInput(messages, metadata);
  const bootstrap = conversationInput(metadata.codexBootstrapHistory ?? []);
  if (!bootstrap) return current;
  return [
    'The following is the existing YOLO conversation before this durable Codex thread was created.',
    'Use it as prior conversation context. The final USER message is the current turn.',
    bootstrap,
    `USER: ${current}`,
  ].join('\n\n');
}

function codexTurnInput(messages = [], metadata = {}) {
  if (String(metadata.codexThreadId ?? '').trim()) {
    return currentTurnInput(messages, metadata);
  }
  return bootstrapCodexTurnInput(messages, metadata);
}

export class CodexAppServerHarness {
  constructor({
    enabled = false,
    command,
    args,
    env,
    model = '',
    provider = 'ollama',
    providerBaseUrl = '',
    providerApiKey = '',
    wireApi = 'responses',
    effort = 'high',
    timeoutMs = 300_000,
    cwd = process.cwd(),
    client = null,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.enabled = Boolean(enabled);
    this.model = String(model ?? '').trim();
    this.effort = String(effort ?? 'high').trim() || 'high';
    this.timeoutMs = Math.max(1_000, Number(timeoutMs) || 300_000);
    this.cwd = cwd;
    this.mode = 'codex';
    this.provider = `openai-codex:${provider}`;
    this.providerId = String(provider ?? 'ollama').trim().toLowerCase() || 'ollama';
    this.providerBaseUrl = String(providerBaseUrl ?? '').trim().replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.runtimeReady = Boolean(client)
      || (this.providerId === 'custom' && Boolean(this.providerBaseUrl) && Boolean(this.model))
      || this.providerId === 'openai';
    this.capabilities = { toolCalling: true, multiTurn: true, skills: true, streaming: true };
    const runtime = buildCodexRuntime({
      provider, providerBaseUrl, providerApiKey, wireApi, args, env,
    });
    this.client = client ?? new CodexAppServerClient({
      command, args: runtime.args, cwd, env: runtime.env,
    });
  }

  isAvailable() {
    return this.enabled && this.runtimeReady && fs.existsSync(this.cwd);
  }

  async initialize() {
    if (!this.enabled || this.runtimeReady) return this.isAvailable();
    const probeUrl = this.providerId === 'ollama'
      ? 'http://127.0.0.1:11434/api/tags'
      : this.providerId === 'lmstudio'
        ? 'http://127.0.0.1:1234/v1/models'
        : '';
    if (!probeUrl || typeof this.fetchImpl !== 'function') return false;
    try {
      const response = await this.fetchImpl(probeUrl, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) return false;
      const payload = await response.json();
      if (this.providerId === 'ollama' && this.model) {
        const names = (payload.models ?? []).flatMap((item) => [item.name, item.model]).filter(Boolean);
        this.runtimeReady = names.some((name) => String(name) === this.model);
      } else if (this.providerId === 'lmstudio' && this.model) {
        this.runtimeReady = (payload.data ?? []).some((item) => String(item.id) === this.model);
      } else {
        this.runtimeReady = true;
      }
    } catch {
      this.runtimeReady = false;
    }
    return this.isAvailable();
  }

  async run({ messages, tools, executeTool, metadata = {}, onEvent = null }) {
    if (!this.isAvailable()) {
      throw Object.assign(new Error('Codex app-server runtime is disabled'), {
        code: 'CODEX_RUNTIME_UNAVAILABLE',
      });
    }
    const system = messages.find((message) => message.role === 'system')?.content ?? '';
    onEvent?.({ type: 'llm_request', provider: this.provider, model: this.model || null, toolCount: tools?.length ?? 0 });
    const result = await this.client.runTurn({
      threadId: metadata.codexThreadId ?? null,
      threadParams: {
        ...(this.model ? { model: this.model } : {}),
        cwd: this.cwd,
        runtimeWorkspaceRoots: [this.cwd],
        approvalPolicy: 'never',
        sandbox: 'read-only',
        environments: [],
        ephemeral: false,
        baseInstructions: String(system),
        developerInstructions: [
          'You are the planning runtime for YOLO Data.',
          'The current baseInstructions contain the authoritative prompt and business rules for this YOLO agent.',
          'Previous turns in this durable Codex thread are the conversational source of truth.',
          'Determine whether the current user message is a new question, follow-up, revision, result operation, or clarification answer from the thread history.',
          'Do not require YOLO to restate inherited context when the thread makes the reference unambiguous.',
          'Use only the dynamic tools supplied by YOLO Data for data access and analysis.',
          'Do not use shell commands, file changes, web search, direct database access, or unlisted tools.',
          'All numerical claims must come from successful YOLO tool results.',
          'Never reveal private reasoning. Return only the final user-facing answer and tool-backed conclusions.',
        ].join('\n'),
        dynamicTools: dynamicTools(tools),
      },
      turnParams: {
        input: [{ type: 'text', text: codexTurnInput(messages, metadata), text_elements: [] }],
        effort: this.effort,
        responsesapiClientMetadata: {
          yolo_session_id: String(metadata.sessionId ?? ''),
          yolo_trace_id: String(metadata.traceId ?? ''),
        },
      },
      newThreadTurnParams: {
        input: [{ type: 'text', text: bootstrapCodexTurnInput(messages, metadata), text_elements: [] }],
        effort: this.effort,
        responsesapiClientMetadata: {
          yolo_session_id: String(metadata.sessionId ?? ''),
          yolo_trace_id: String(metadata.traceId ?? ''),
        },
      },
      executeTool,
      timeoutMs: this.timeoutMs,
      signal: metadata.signal,
      onEvent,
      onThreadReady: metadata.onCodexThreadReady,
    });
    onEvent?.({ type: 'llm_response', provider: this.provider, model: this.model || null, content: result.content });
    return { content: result.content, trace: result.trace, usage: null, codex: { threadId: result.threadId, turnId: result.turnId } };
  }

  close() {
    this.client.close();
  }
}

