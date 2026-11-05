import {
  TURN_TYPES,
  createTurnContext,
} from './turnContext.js';
import { parseConversationDirective } from './conversationDirectives.js';
import { responseOutputText } from './harness.js';

const ALLOWED_TURN_TYPES = new Set(Object.values(TURN_TYPES));

function historyLines(history = []) {
  return history.slice(-6).map((message) => {
    const text = String(message?.content ?? '').replace(/\s+/g, ' ').slice(0, 220);
    return `${message?.role === 'assistant' ? '助手' : '用户'}：${text}`;
  }).join('\n');
}

function parseDecision(content) {
  const text = String(content ?? '').trim();
  const objectText = text.match(/\{[\s\S]*\}/)?.[0];
  if (!objectText) {
    return null;
  }
  try {
    const parsed = JSON.parse(objectText);
    const turnType = String(parsed.turnType ?? '').toUpperCase();
    if (!ALLOWED_TURN_TYPES.has(turnType)) {
      return null;
    }
    return {
      turnType,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      reason: String(parsed.reason ?? '').slice(0, 240),
      referencedTask: Boolean(parsed.referencedTask),
    };
  } catch {
    return null;
  }
}

export async function refineTurnContextWithHarness({
  context,
  history = [],
  harness,
  theme = null,
  user = null,
  signal = null,
  minConfidence = 0.72,
} = {}) {
  if (!context?.needsClassifier) {
    return context;
  }
  if (harness?.mode === 'local-rule' || typeof harness?.chat !== 'function') {
    return {
      ...context,
      needsClassifier: false,
      needsConfirmation: true,
      source: 'rule-fallback',
      reason: `${context.reason}_local_rule_fallback`,
    };
  }
  const prompt = [
    '你是问数系统的对话关系路由器。只判断当前问题与上一任务的关系，不回答业务问题，不生成查询条件。',
    '可选关系：',
    '- CONTINUATION：继续上一任务，省略了部分条件，例如“按周拆开”“只看某个筛选值”',
    '- REVISION：修正上一任务的条件，例如“不是本月，改成上月”',
    '- NEW_TASK：独立新问题，不应继承上一任务的指标、时间、筛选或结果',
    '- INSTRUCTION：设置会话偏好或输出规范，本身不执行问数，例如“以后金额都按万元展示”',
    '- RESULT_OPERATION：操作上一轮结果，例如“导出 Excel”“加一行汇总”',
    '- CLARIFICATION_ANSWER：回答上一轮的澄清问题',
    '- AMBIGUOUS：仅凭当前信息无法可靠判断',
    '判断原则：当前用户明确表达优先；没有明确指代时，不要为了“连贯”而继承旧条件；跨指标且没有指代通常视为 NEW_TASK。',
    '只输出 JSON：{"turnType":"CONTINUATION|REVISION|NEW_TASK|INSTRUCTION|RESULT_OPERATION|CLARIFICATION_ANSWER|AMBIGUOUS","confidence":0到1,"referencedTask":true或false,"reason":"一句话理由"}',
    '',
    `当前问题：${context.originalQuestion ?? ''}`,
    `规则初步判断：${context.turnType}（置信度 ${context.confidence}）`,
    `显式条件：${JSON.stringify(context.explicitSlots ?? {})}`,
    `上一任务：${context.previousTaskQuestion || '无'}`,
    `是否检测到指代：${String((context.reason || '').includes('anaphoric') || (context.reason || '').includes('reference'))}`,
    '',
    '最近对话：',
    historyLines(history) || '无',
  ].join('\n');
  try {
    const payload = await harness.chat([
      {
        role: 'system',
        content: '你只做结构化对话路由。不要输出解释、Markdown 或业务答案。',
      },
      { role: 'user', content: prompt },
    ], [], {
      callType: 'CONTEXT_ROUTER',
      userId: user?.id ?? null,
      themeId: theme?.id ?? null,
      signal,
    });
    const decision = parseDecision(responseOutputText(payload));
    const directive = decision?.turnType === TURN_TYPES.INSTRUCTION
      ? parseConversationDirective(context.originalQuestion)
      : null;
    if (
      !decision
      || decision.confidence < minConfidence
      || decision.turnType === TURN_TYPES.AMBIGUOUS
    ) {
      return {
        ...context,
        needsClassifier: false,
        needsConfirmation: true,
        source: 'model-fallback',
        reason: decision?.reason || 'model_router_low_confidence',
      };
    }
    return createTurnContext({
      question: context.originalQuestion,
      history,
      turnType: decision.turnType,
      confidence: decision.confidence,
      reason: decision.reason || 'model_router',
      source: 'model',
      needsClassifier: false,
      forceNewTask: decision.turnType === TURN_TYPES.NEW_TASK,
      memorySlots: context.memorySlots ?? {},
      maxInheritTurns: context.inheritBudget?.maxTurns,
      maxInheritedSlots: context.inheritBudget?.maxSlots,
      conversationDirective: directive,
    });
  } catch (error) {
    return {
      ...context,
      needsClassifier: false,
      needsConfirmation: true,
      source: 'model-fallback',
      reason: `model_router_failed: ${error.message}`,
    };
  }
}
