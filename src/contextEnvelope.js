import crypto from 'node:crypto';

const CONTEXT_ENVELOPE_SCHEMA_VERSION = 1;

function compactTurn(turn) {
  return {
    id: turn?.id ?? turn?.messageId ?? null,
    role: turn?.role ?? 'user',
    content: String(turn?.content ?? ''),
    taskState: turn?.taskState ?? null,
    artifactId: turn?.artifactId ?? null,
    runtimeMode: turn?.runtimeMode ?? null,
    computeMode: turn?.computeMode ?? null,
    createdAt: turn?.createdAt ?? null,
  };
}

function stableHash(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 24);
}

export function createCapabilityVersion(value) {
  return `cap-${stableHash(value)}`;
}

export function requiresCodexThreadReset(session, capabilityVersion) {
  return Boolean(
    String(session?.codexThreadId ?? '').trim()
    && String(session?.codexContextVersion ?? '') !== String(capabilityVersion ?? ''),
  );
}

function fastTurnsSinceLastCodex(turns) {
  let lastCodexIndex = -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.runtimeMode === 'codex') {
      lastCodexIndex = index;
      break;
    }
  }
  return turns.slice(lastCodexIndex + 1).filter((turn) => turn.runtimeMode !== 'codex');
}

export function createContextEnvelope({
  session,
  theme,
  question,
  resolvedQuestion,
  conversationContext,
  executionContext,
  historyTurns = [],
  memoryText = '',
  runtimeDecision = null,
  capabilityVersion = null,
} = {}) {
  const canonicalTurns = historyTurns.map(compactTurn);
  const payload = {
    schemaVersion: CONTEXT_ENVELOPE_SCHEMA_VERSION,
    authority: 'YOLO_SESSION',
    session: {
      id: session?.id ?? null,
      themeId: session?.themeId ?? theme?.id ?? null,
      modelId: session?.modelId ?? null,
    },
    theme: {
      id: theme?.id ?? null,
      name: theme?.name ?? '',
    },
    turn: {
      originalQuestion: String(question ?? ''),
      resolvedQuestion: String(resolvedQuestion ?? question ?? ''),
      type: conversationContext?.turnType ?? 'NEW_TASK',
      mode: conversationContext?.mode ?? 'NEW_TOPIC',
      reason: conversationContext?.reason ?? '',
      inheritQueryContext: Boolean(conversationContext?.inheritQueryContext),
      taskId: conversationContext?.taskId ?? null,
      rootTaskId: conversationContext?.rootTaskId ?? null,
      taskState: conversationContext?.taskState ?? null,
    },
    execution: {
      contractContext: executionContext?.sourceContext ?? '',
    },
    memory: {
      retrievedText: String(memoryText ?? ''),
    },
    runtime: runtimeDecision ? {
      requested: runtimeDecision.requested,
      resolved: runtimeDecision.resolved,
      reason: runtimeDecision.reason,
    } : null,
    capabilityVersion,
    canonicalTurns,
    fastTurnsSinceLastCodex: fastTurnsSinceLastCodex(canonicalTurns),
  };
  return {
    ...payload,
    revision: stableHash(payload),
  };
}

export function formatContextEnvelope(envelope) {
  return [
    '[YOLO ContextEnvelope]',
    JSON.stringify(envelope ?? {}, null, 2),
    '[/YOLO ContextEnvelope]',
  ].join('\n');
}

export { CONTEXT_ENVELOPE_SCHEMA_VERSION };
