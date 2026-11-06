import { spawn } from 'node:child_process';
import readline from 'node:readline';

function rpcError(payload) {
  const message = payload?.error?.message ?? payload?.message ?? 'Codex app-server request failed';
  return Object.assign(new Error(message), {
    code: payload?.error?.code ?? 'CODEX_APP_SERVER_ERROR',
    detail: payload?.error?.data ?? null,
  });
}

function serializeResult(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ error: 'tool result is not serializable' });
  }
}

function isMissingThreadError(error) {
  const text = `${error?.code ?? ''} ${error?.message ?? ''} ${JSON.stringify(error?.detail ?? '')}`.toLowerCase();
  return text.includes('thread') && (
    text.includes('not found')
    || text.includes('does not exist')
    || text.includes('unknown')
    || text.includes('missing')
  );
}

function resumeParams(threadId, threadParams = {}) {
  const allowed = [
    'baseInstructions',
    'developerInstructions',
    'cwd',
    'model',
    'approvalPolicy',
    'sandbox',
    'runtimeWorkspaceRoots',
  ];
  return Object.fromEntries([
    ['threadId', threadId],
    ...allowed
      .filter((key) => threadParams[key] !== undefined)
      .map((key) => [key, threadParams[key]]),
    ['excludeTurns', true],
  ]);
}

function normalizePlanSteps(plan) {
  const steps = Array.isArray(plan)
    ? plan
    : Array.isArray(plan?.steps)
      ? plan.steps
      : [];
  return steps.map((step, index) => ({
    id: String(step?.id ?? index + 1),
    status: String(step?.status ?? (index === 0 ? 'running' : 'pending')),
    title: String(step?.title ?? step?.step ?? step?.description ?? `步骤 ${index + 1}`)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80),
    detail: '',
    category: step?.category ?? null,
  })).filter((step) => step.title);
}

function normalizeCodexItem(item, status, startedAt = null) {
  const type = String(item?.type ?? '').toLowerCase();
  if (!item?.id || type === 'agentmessage' || type.includes('toolcall')) return null;
  const isReasoning = type.includes('reason');
  const isPlan = type.includes('plan');
  const isAnalysis = isReasoning || type.includes('analysis');
  return {
    type: 'codex_item',
    id: String(item.id),
    status,
    title: isPlan
      ? '规划解题路径'
      : isAnalysis
        ? '分析问题'
        : '执行计算',
    detail: status === 'running' ? '正在处理当前任务' : '已完成',
    category: isPlan || isReasoning ? 'UNDERSTAND' : isAnalysis ? 'ANALYZE' : 'EXECUTE',
    startedAt,
    durationMs: startedAt && status !== 'running'
      ? Math.max(0, Date.now() - new Date(startedAt).getTime())
      : null,
  };
}

export class CodexAppServerClient {
  constructor({
    command = process.platform === 'win32' ? 'codex.cmd' : 'codex',
    args = ['app-server', '--stdio'],
    cwd = process.cwd(),
    env = process.env,
    spawnImpl = spawn,
    clientInfo = { name: 'yolo-data', title: 'YOLO Data', version: '1.2.0' },
  } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.clientInfo = clientInfo;
    this.process = null;
    this.pending = new Map();
    this.turns = new Map();
    this.nextId = 1;
    this.initializing = null;
    this.stderr = '';
  }

  async ensureStarted() {
    if (this.process && !this.process.killed) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.start();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async start() {
    const useWindowsCommandShell = process.platform === 'win32'
      && /\.(?:cmd|bat)$/i.test(this.command);
    this.useWindowsCommandShell = useWindowsCommandShell;
    const child = this.spawnImpl(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: useWindowsCommandShell,
    });
    this.process = child;
    this.stderr = '';
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on?.('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8000);
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    child.once('error', (error) => this.handleExit(error));
    child.once('exit', (code, signal) => {
      this.handleExit(Object.assign(
        new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'})${this.stderr ? `: ${this.stderr.trim()}` : ''}`),
        { code: 'CODEX_APP_SERVER_EXIT' },
      ));
    });
    try {
      await this.request('initialize', {
        clientInfo: this.clientInfo,
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      }, 15_000);
      this.notify('initialized');
    } catch (error) {
      this.close();
      throw error;
    }
  }

  write(message) {
    if (!this.process?.stdin?.writable) {
      throw Object.assign(new Error('Codex app-server is not running'), {
        code: 'CODEX_APP_SERVER_NOT_RUNNING',
      });
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = 0) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(String(id));
          reject(Object.assign(new Error(`Codex app-server request timed out: ${method}`), {
            code: 'CODEX_APP_SERVER_TIMEOUT',
          }));
        }, timeoutMs)
        : null;
      this.pending.set(String(id), {
        resolve: (value) => { if (timer) clearTimeout(timer); resolve(value); },
        reject: (error) => { if (timer) clearTimeout(timer); reject(error); },
        method,
      });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(String(id));
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params = undefined) {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  respond(id, result) {
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id, error) {
    this.write({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: error?.message ?? String(error) },
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id != null && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(rpcError(message));
      else pending.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      void this.handleServerRequest(message);
      return;
    }
    if (message.method) this.handleNotification(message.method, message.params ?? {});
  }

  async handleServerRequest(message) {
    if (message.method !== 'item/tool/call') {
      this.respondError(message.id, new Error(`unsupported Codex server request: ${message.method}`));
      return;
    }
    const context = this.turns.get(String(message.params?.turnId));
    if (!context) {
      this.respondError(message.id, new Error('tool call does not belong to an active YOLO turn'));
      return;
    }
    const name = message.params?.tool;
    const args = message.params?.arguments ?? {};
    context.trace.push({ type: 'tool_call', name, args });
    try {
      const result = await context.executeTool(name, args);
      context.trace.push({ type: 'tool_result', name });
      this.respond(message.id, {
        success: true,
        contentItems: [{ type: 'inputText', text: serializeResult(result) }],
      });
    } catch (error) {
      context.trace.push({ type: 'tool_error', name, message: error.message });
      this.respond(message.id, {
        success: false,
        contentItems: [{ type: 'inputText', text: serializeResult({ error: error.message }) }],
      });
    }
  }

  handleNotification(method, params) {
    const context = this.turns.get(String(params?.turnId ?? params?.turn?.id ?? ''));
    if (!context) return;
    if (method === 'thread/tokenUsage/updated') {
      context.usage = params.tokenUsage ?? context.usage;
      return;
    }
    if (method === 'turn/plan/updated') {
      context.onEvent?.({
        type: 'codex_plan_updated',
        steps: normalizePlanSteps(params.plan ?? params.steps ?? params.turn?.plan),
      });
      return;
    }
    if (method === 'item/started') {
      const startedAt = new Date().toISOString();
      context.itemStartedAt.set(String(params.item?.id ?? ''), startedAt);
      const event = normalizeCodexItem(params.item, 'running', startedAt);
      if (event) context.onEvent?.(event);
      return;
    }
    if (method === 'item/agentMessage/delta') {
      context.content += String(params.delta ?? '');
      // Keep raw Codex prose out of the user-visible answer stream until YOLO's
      // grounding and answer-composition stages have validated it.
      context.onEvent?.({ type: 'codex_delta', text: String(params.delta ?? '') });
      return;
    }
    if (method === 'item/completed') {
      if (params.item?.type === 'agentMessage') {
        context.content = String(params.item.text ?? context.content);
        return;
      }
      const startedAt = context.itemStartedAt.get(String(params.item?.id ?? '')) ?? null;
      const event = normalizeCodexItem(params.item, params.item?.status ?? 'completed', startedAt);
      if (event) context.onEvent?.(event);
      return;
    }
    if (method !== 'turn/completed') return;
    context.onEvent?.({
      type: 'codex_turn_completed',
      status: params.turn?.status ?? 'completed',
    });
    this.turns.delete(String(params.turn?.id));
    context.cleanup();
    if (params.turn?.status === 'failed') {
      context.reject(Object.assign(
        new Error(params.turn?.error?.message ?? 'Codex turn failed'),
        { code: 'CODEX_TURN_FAILED', detail: params.turn?.error ?? null },
      ));
      return;
    }
    context.resolve({
      content: context.content,
      trace: context.trace,
      threadId: context.threadId,
      turnId: params.turn?.id,
      status: params.turn?.status,
      usage: context.usage,
      durationMs: Math.max(0, Date.now() - context.startedAt),
    });
  }

  async runTurn({
    threadId: existingThreadId = null,
    threadParams,
    turnParams,
    newThreadTurnParams = null,
    executeTool,
    timeoutMs = 300_000,
    signal,
    onEvent,
    onThreadReady = null,
  }) {
    await this.ensureStarted();
    const setupTimeoutMs = Math.min(timeoutMs, 30_000);
    let threadId = String(existingThreadId ?? '').trim();
    let created = false;
    if (threadId) {
      try {
        await this.request('thread/resume', resumeParams(threadId, threadParams), setupTimeoutMs);
      } catch (error) {
        if (!isMissingThreadError(error)) throw error;
        threadId = '';
      }
    }
    if (!threadId) {
      const started = await this.request('thread/start', threadParams, setupTimeoutMs);
      threadId = String(started?.thread?.id ?? '').trim();
      if (!threadId) throw new Error('Codex app-server did not return a thread id');
      created = true;
    }
    await onThreadReady?.(threadId, { created });
    const effectiveTurnParams = created && newThreadTurnParams
      ? newThreadTurnParams
      : turnParams;
    const turnStarted = await this.request('turn/start', { ...effectiveTurnParams, threadId }, setupTimeoutMs);
    const turnId = turnStarted?.turn?.id;
    if (!turnId) throw new Error('Codex app-server did not return a turn id');
    return new Promise((resolve, reject) => {
      const abort = () => {
        void this.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        const context = this.turns.get(String(turnId));
        if (context) {
          this.turns.delete(String(turnId));
          context.cleanup();
        }
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      };
      const timeout = setTimeout(() => {
        void this.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        this.turns.delete(String(turnId));
        signal?.removeEventListener?.('abort', abort);
        reject(Object.assign(new Error(`Codex 深度计算超时（${timeoutMs} 毫秒）`), {
          code: 'CODEX_TURN_TIMEOUT',
        }));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener?.('abort', abort);
      };
      this.turns.set(String(turnId), {
        threadId, executeTool, onEvent, resolve, reject, cleanup, content: '', trace: [],
        itemStartedAt: new Map(), usage: null, startedAt: Date.now(),
      });
      signal?.addEventListener?.('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  handleExit(error) {
    if (!this.process) return;
    this.process = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const context of this.turns.values()) {
      context.cleanup();
      context.reject(error);
    }
    this.turns.clear();
  }

  close() {
    const child = this.process;
    this.process = null;
    if (!child || child.killed) return;
    if (process.platform === 'win32' && this.useWindowsCommandShell && child.pid) {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.unref();
      return;
    }
    child.kill();
  }
}

