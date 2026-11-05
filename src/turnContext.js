import { TIME_PATTERN, TIME_HINT_PATTERN } from './conversationTimePatterns.js';
import crypto from 'node:crypto';
import { getPlatformLexicon } from './businessLexicon.js';
import { isAttributionText, isTrendText } from './analysisIntent.js';
import { cleanGenericQueryPhrase, isGenericQueryResidual } from './queryLanguage.js';
import { parseConversationDirective } from './conversationDirectives.js';

export const TURN_TYPES = {
  NEW_TASK: 'NEW_TASK',
  INSTRUCTION: 'INSTRUCTION',
  CONTINUATION: 'CONTINUATION',
  REVISION: 'REVISION',
  RESULT_OPERATION: 'RESULT_OPERATION',
  CLARIFICATION_ANSWER: 'CLARIFICATION_ANSWER',
  AMBIGUOUS: 'AMBIGUOUS',
};

export const DEFAULT_MAX_INHERIT_TURNS = 4;
export const DEFAULT_MAX_INHERITED_SLOTS = 3;

const SLOT_ORDER = ['metric', 'time', 'filters', 'dimensions', 'analysisMode'];
const SLOT_LABELS = {
  metric: '指标',
  time: '时间',
  filters: '筛选',
  dimensions: '维度',
  analysisMode: '分析方式',
};
const FILTER_PATTERN = /(?:只看|仅看|限定|过滤|筛选|排除)([^，。；,;]{1,24})/g;
const TIME_GRAINS = new Set(['日', '天', '周', '月', '季度', '年']);
const FILTER_VALUE_PATTERN = /^(?:只看|仅看|限定为|是|为|等于|=)\s*(.+)$/;
const LEGACY_CLARIFICATION_PATTERN = /请补充|请确认|需要确认|请指定|请提供|请明确|请选择|是否确认/;
const DIMENSION_STOP_TERMS = [
  '拆分', '分组', '分析', '分别', '展示', '统计', '看', '维度', '排序', '对比', '趋势', '走势',
  '进行', '指标', '数据', '呢', '吗', '的',
];
const FIELD_LABEL_TERMS = ['名称', '名字', '编号', '编码', '代码', '字段', '维度'];
const TURN_PATTERN_CACHE = new WeakMap();

function escapePattern(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileTurnPatterns(lexicon) {
  const metricTerms = unique(lexicon?.metricTerms ?? []);
  const metricAlternation = metricTerms.map(escapePattern).join('|');
  const dimensionStops = unique([...DIMENSION_STOP_TERMS, ...metricTerms])
    .map(escapePattern)
    .join('|');
  const dimensionTail = dimensionStops
    ? `(?=${dimensionStops}|，|,|。|；|;|！|!|？|\\?|$)`
    : '(?=，|,|。|；|;|！|!|？|\\?|$)';
  const fieldTerms = unique([
    ...FIELD_LABEL_TERMS,
    ...(lexicon?.enumFieldTerms ?? []),
    ...Object.values(lexicon?.dimensionAliases ?? {}).flat(),
  ]).map(escapePattern).join('|');
  return {
    metric: metricAlternation
      ? new RegExp(`[\\u4e00-\\u9fa5A-Za-z0-9]{1,16}(?:${metricAlternation})`, 'gi')
      : null,
    dimensions: [
      new RegExp(
        // 分组动作中的词尾不能被再次切成一个独立维度名。
        `(?:按照?|分(?!析|别|组)|各|每个|逐个)([\\u4e00-\\u9fa5A-Za-z0-9_、]{1,18}?)${dimensionTail}`,
        'g',
      ),
      new RegExp(
        `(?:拆到|拆成|拆解到|细分到|落到|重点看|重点分析|主要看|主要分析|关注|聚焦)([^，,。；;！!？?\\n]{1,24}?)${dimensionTail}`,
        'g',
      ),
      new RegExp(
        `(?:主要)?(?:来自|来源于)(?:哪些|哪类|哪几个|什么)?([^，,。；;！!？?\\n]{1,20}?)${dimensionTail}`,
        'g',
      ),
      new RegExp(
        '([^，,。；;！!？?\\n]{1,30}?)分别(?:影响|贡献|拉动|拖累|变化|下降|上升|增长|减少|是多少|多少|如何|怎么)',
        'g',
      ),
    ],
    fieldLabel: fieldTerms ? new RegExp(`(?:${fieldTerms})(?:字段)?$`) : null,
  };
}

function turnPatterns() {
  const lexicon = getPlatformLexicon();
  const cached = TURN_PATTERN_CACHE.get(lexicon);
  if (cached) {
    return cached;
  }
  const patterns = compileTurnPatterns(lexicon);
  TURN_PATTERN_CACHE.set(lexicon, patterns);
  return patterns;
}

function unique(values) {
  return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function compact(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s，,。；;：:！!？?、"'“”‘’（）()【】[\]{}]/g, '');
}

function slot(value, sourceText = value, source = 'explicit') {
  return {
    value: String(value ?? sourceText ?? '').trim(),
    sourceText: String(sourceText ?? value ?? '').trim(),
    source,
  };
}

function slotList(values, source = 'explicit') {
  const list = [];
  const seen = new Set();
  for (const item of values ?? []) {
    const normalized = typeof item === 'object'
      ? slot(item.value ?? item.sourceText, item.sourceText ?? item.value, item.source ?? source)
      : slot(item, item, source);
    if (!normalized.value || seen.has(normalized.value)) {
      continue;
    }
    seen.add(normalized.value);
    list.push(normalized);
  }
  return list;
}

function mergeSlotSets(...sets) {
  const merged = {};
  for (const key of SLOT_ORDER) {
    const values = [];
    const seen = new Set();
    for (const set of sets) {
      for (const item of set?.[key] ?? []) {
        const normalized = slot(item.value ?? item.sourceText, item.sourceText ?? item.value, item.source ?? 'explicit');
        if (!normalized.value || seen.has(normalized.value)) {
          continue;
        }
        seen.add(normalized.value);
        values.push(normalized);
      }
    }
    if (values.length > 0) {
      merged[key] = values;
    }
  }
  return merged;
}

function matches(pattern, question) {
  if (!pattern) {
    return [];
  }
  const values = [];
  for (const match of String(question ?? '').matchAll(pattern)) {
    values.push(match[1] ?? match[0]);
  }
  return unique(values);
}

function matchesAll(patterns, question) {
  const values = [];
  for (const pattern of patterns ?? []) {
    if (!pattern) {
      continue;
    }
    for (const match of String(question ?? '').matchAll(pattern)) {
      values.push(match[1] ?? match[0]);
    }
  }
  return unique(values);
}

function cleanExtractedValue(value) {
  return String(value ?? '')
    .replace(/^(?:那|再|还有|以及|另外|请|帮我|麻烦|查询|查一下|查看|统计|分析|计算|看一下|展示|列出|给我|改成|改为|换成|换为|调整为|的)+/, '')
    .replace(/(?:呢|吗|呀|吧|啊|的)+$/, '')
    .trim();
}

function cleanDimension(value) {
  const cleaned = cleanGenericQueryPhrase(cleanExtractedValue(value))
    .replace(/(?:拆开?|拆分|分组|展示|统计|看|维度|排序|对比|趋势|走势)+$/, '')
    .replace(/(?:等)?相关(?:的)?(?:维度|字段)?$/, '')
    .replace(/等$/, '')
    .trim();
  return TIME_GRAINS.has(cleaned) || isGenericQueryResidual(cleaned) ? '' : cleaned;
}

export function extractExplicitSlots(question) {
  const source = String(question ?? '');
  const patterns = turnPatterns();
  const dimensions = matchesAll(patterns.dimensions, source)
    .flatMap((value) => cleanDimension(value).split(/(?:、|\/|以及|和|及)/))
    .map((value) => value.trim())
    .map((value) => cleanDimension(value))
    .filter(Boolean);
  const slots = {
    metric: slotList(matches(patterns.metric, source).map(cleanExtractedValue).filter(Boolean)),
    time: slotList(matches(TIME_PATTERN, source).map(cleanExtractedValue).filter(Boolean)),
    filters: slotList(matches(FILTER_PATTERN, source).map(cleanExtractedValue).filter(Boolean)),
    dimensions: slotList(dimensions),
  };
  if (isTrendText(source)) {
    slots.analysisMode = slotList(['TREND']);
  } else if (isAttributionText(source)) {
    slots.analysisMode = slotList(['ATTRIBUTION']);
  }
  return slots;
}

// 长期记忆只转成最低优先级的默认槽位；当前显式条件始终覆盖记忆。
export function extractMemorySlots(...texts) {
  const merged = {};
  for (const text of texts) {
    const slots = extractExplicitSlots(text);
    for (const [key, values] of Object.entries(slots)) {
      merged[key] = slotList([...(merged[key] ?? []), ...values].slice(0, 1), 'memory');
    }
  }
  return merged;
}

// 澄清回答往往是字段名或枚举裸值，普通抽取器无法判断槽位类型。
// 这里只做一个窄范围的类型提示，最终是否可用仍由查询编译器校验。
export function inferClarificationSlots(question) {
  const source = String(question ?? '').trim();
  if (!source || source.length > 30) {
    return {};
  }
  const slots = {};
  if (TIME_HINT_PATTERN.test(source) || extractExplicitSlots(source).time?.length) {
    return slots;
  }
  if (turnPatterns().fieldLabel?.test(source)) {
    slots.dimensions = slotList([source], 'clarification');
    return slots;
  }
  const filterMatch = source.match(FILTER_VALUE_PATTERN);
  if (filterMatch) {
    slots.filters = slotList([filterMatch[1]], 'clarification');
    return slots;
  }
  if (/^[\u4e00-\u9fa5A-Za-z0-9_-]{2,20}$/.test(source)) {
    slots.filters = slotList([source], 'clarification');
  }
  return slots;
}

function normalizeTaskState(task) {
  if (!task) {
    return null;
  }
  return {
    taskId: String(task.taskId ?? ''),
    turnId: String(task.turnId ?? ''),
    rootTaskId: task.rootTaskId ?? null,
    parentTaskId: task.parentTaskId ?? null,
    inheritDepth: Number(task.inheritDepth) || 0,
    inheritBudget: task.inheritBudget ?? null,
    turnType: task.turnType ?? TURN_TYPES.NEW_TASK,
    question: String(task.question ?? ''),
    resolvedQuestion: String(task.resolvedQuestion ?? task.question ?? ''),
    slots: task.slots ?? {},
    explicitSlots: task.explicitSlots ?? {},
    inheritedSlots: task.inheritedSlots ?? {},
    memorySlots: task.memorySlots ?? {},
    clearedSlots: task.clearedSlots ?? [],
    result: task.result ?? null,
    status: task.status ?? 'COMPLETED',
    updatedAt: task.updatedAt ?? null,
    createdAt: task.createdAt ?? null,
  };
}

function filterMemorySlotsForQuestion(memorySlots, question) {
  const questionText = compact(question);
  const contextualKeys = new Set(['metric', 'dimensions', 'filters', 'analysisMode']);
  return Object.fromEntries(
    Object.entries(memorySlots ?? {}).filter(([key, values]) => {
      if (!contextualKeys.has(key)) {
        return true;
      }
      return (values ?? []).some((item) => (
        [item?.value, item?.sourceText]
          .map((value) => compact(value))
          .filter(Boolean)
          .some((value) => questionText.includes(value))
      ));
    }),
  );
}

export function previousTaskFromHistory(history = []) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    const task = normalizeTaskState(message?.taskState ?? message?.result?.taskState);
    if (!task) {
      continue;
    }
    if (task.turnType === TURN_TYPES.INSTRUCTION) {
      continue;
    }
    const turnsSince = history.slice(index + 1)
      .filter((item) => item?.role === 'user').length;
    return { task, turnsSince, historyIndex: index };
  }
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== 'user' || !String(message.content ?? '').trim()) {
      continue;
    }
    if (parseConversationDirective(message.content)) {
      continue;
    }
    const questions = [String(message.content).trim()];
    for (let cursor = index - 1; cursor >= 0 && questions.length < 4; cursor -= 1) {
      const earlier = history[cursor];
      const content = String(earlier?.content ?? '').trim();
      if (earlier?.role === 'user' && content) {
        questions.unshift(content);
        continue;
      }
      if (earlier?.role === 'assistant' && LEGACY_CLARIFICATION_PATTERN.test(content)) {
        continue;
      }
      break;
    }
    const slots = mergeSlotSets(...questions.map((item, questionIndex) => mergeSlotSets(
      extractExplicitSlots(item),
      questionIndex === questions.length - 1 ? inferClarificationSlots(item) : {},
    )));
    const question = questions[0];
    return {
      task: normalizeTaskState({
        taskId: `legacy-${index + 1}`,
        turnId: `legacy-turn-${index + 1}`,
        rootTaskId: `legacy-${index + 1}`,
        turnType: TURN_TYPES.NEW_TASK,
        question,
        resolvedQuestion: question,
        slots,
        explicitSlots: slots,
        status: 'COMPLETED',
      }),
      turnsSince: history.slice(index + 1)
        .filter((item) => item?.role === 'user').length,
      historyIndex: index,
    };
  }
  return { task: null, turnsSince: 0, historyIndex: -1 };
}

export function legacyModeForTurnType(turnType, hasPreviousTask = false) {
  if (turnType === TURN_TYPES.INSTRUCTION) {
    return 'INSTRUCTION';
  }
  if (turnType === TURN_TYPES.NEW_TASK) {
    return hasPreviousTask ? 'INDEPENDENT' : 'NEW_TOPIC';
  }
  if (turnType === TURN_TYPES.AMBIGUOUS) {
    return 'INDEPENDENT';
  }
  return 'FOLLOW_UP';
}

function inheritedSlotSelection(previousSlots, explicitSlots, maxSlots) {
  const selected = {};
  const cleared = [];
  let count = 0;
  for (const key of SLOT_ORDER) {
    const explicit = explicitSlots?.[key] ?? [];
    if (explicit.length > 0) {
      if (previousSlots?.[key]?.length) {
        cleared.push(key);
      }
      continue;
    }
    if (count >= maxSlots) {
      break;
    }
    const values = previousSlots?.[key] ?? [];
    if (values.length > 0) {
      selected[key] = values;
      count += 1;
    }
  }
  return { selected, cleared };
}

function describeSlots(slots) {
  return Object.entries(slots ?? {})
    .map(([key, values]) => `${SLOT_LABELS[key] ?? key}：${values.map((item) => item.sourceText).join('、')}`)
    .join('；');
}

export function composeResolvedQuestion(question, inheritedSlots) {
  const inheritedText = describeSlots(inheritedSlots);
  return inheritedText ? `${question}；沿用任务条件：${inheritedText}` : String(question ?? '');
}

export function createTaskId() {
  return `task-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

export function createTurnContext({
  question,
  history = [],
  turnType = TURN_TYPES.NEW_TASK,
  resolvedQuestionOverride = '',
  confidence = 0.5,
  reason = '',
  source = 'rule',
  needsClassifier = false,
  forceNewTask = false,
  memorySlots = {},
  inheritedUserMessages = [],
  referencesResult = false,
  maxInheritTurns = DEFAULT_MAX_INHERIT_TURNS,
  maxInheritedSlots = DEFAULT_MAX_INHERITED_SLOTS,
  conversationDirective = null,
} = {}) {
  const normalizedQuestion = String(question ?? '').trim();
  const extractedSlots = extractExplicitSlots(normalizedQuestion);
  const clarificationSlots = turnType === TURN_TYPES.CLARIFICATION_ANSWER
    ? inferClarificationSlots(normalizedQuestion)
    : {};
  const explicitSlots = mergeSlotSets(extractedSlots, clarificationSlots);
  const { task: previousTask, turnsSince, historyIndex } = previousTaskFromHistory(history);
  const hasPreviousTask = Boolean(previousTask);
  const previousDepth = Number(previousTask?.inheritDepth) || 0;
  const stale = hasPreviousTask && (
    turnsSince > maxInheritTurns
    || previousDepth >= maxInheritTurns
  );
  const effectiveTurnType = forceNewTask || stale
    ? TURN_TYPES.NEW_TASK
    : turnType;
  const canInherit = hasPreviousTask
    && !stale
    && ![TURN_TYPES.NEW_TASK, TURN_TYPES.INSTRUCTION, TURN_TYPES.AMBIGUOUS].includes(effectiveTurnType);
  const { selected: inheritedSlots, cleared } = canInherit
    ? inheritedSlotSelection(previousTask?.slots, explicitSlots, maxInheritedSlots)
    : { selected: {}, cleared: [] };
  const relevantMemorySlots = effectiveTurnType === TURN_TYPES.INSTRUCTION
    ? {}
    : filterMemorySlotsForQuestion(memorySlots, normalizedQuestion);
  const usableMemorySlots = Object.fromEntries(
    Object.entries(relevantMemorySlots).filter(([key]) => (
      !explicitSlots?.[key]?.length && !inheritedSlots?.[key]?.length
    )),
  );
  const slots = mergeSlotSets(usableMemorySlots, inheritedSlots, explicitSlots);
  const taskId = canInherit && previousTask?.taskId
    ? previousTask.taskId
    : createTaskId();
  const turnId = createTaskId().replace(/^task-/, 'turn-');
  const rootTaskId = canInherit
    ? previousTask?.rootTaskId ?? previousTask?.taskId ?? taskId
    : taskId;
  const inheritDepth = canInherit ? previousDepth + 1 : 0;
  const inheritBudget = {
    maxTurns: maxInheritTurns,
    maxSlots: maxInheritedSlots,
    usedTurns: inheritDepth,
    usedSlots: Object.keys(inheritedSlots).length,
    remainingTurns: Math.max(0, maxInheritTurns - inheritDepth),
    remainingSlots: Math.max(0, maxInheritedSlots - Object.keys(inheritedSlots).length),
    expired: stale,
  };
  const mode = legacyModeForTurnType(effectiveTurnType, hasPreviousTask);
  const inherited = Object.keys(inheritedSlots).length > 0;
  const resolvedQuestion = String(resolvedQuestionOverride ?? '').trim()
    || composeResolvedQuestion(normalizedQuestion, inheritedSlots);
  return {
    question: resolvedQuestion,
    originalQuestion: normalizedQuestion,
    mode,
    turnType: effectiveTurnType,
    reason: stale ? 'task_context_expired' : reason,
    confidence: Number(confidence) || 0,
    source,
    needsClassifier: Boolean(needsClassifier) && !forceNewTask && !stale,
    needsConfirmation: Boolean(needsClassifier) && !forceNewTask && !stale,
    inheritQueryContext: inherited,
    inheritedUserMessages: effectiveTurnType === TURN_TYPES.INSTRUCTION
      ? []
      : inheritedUserMessages.slice(-4),
    conversationDirective,
    historyMessageCount: history.length,
    taskId,
    turnId,
    rootTaskId,
    parentTaskId: canInherit ? previousTask?.taskId ?? null : null,
    inheritDepth,
    inheritBudget,
    referencedArtifactId: (effectiveTurnType === TURN_TYPES.RESULT_OPERATION || referencesResult)
      ? previousTask?.result?.artifactId ?? null
      : null,
    taskState: {
      taskId,
      turnId,
      rootTaskId,
      parentTaskId: canInherit ? previousTask?.taskId ?? null : null,
      inheritDepth,
      inheritBudget,
      turnType: effectiveTurnType,
      question: normalizedQuestion,
      resolvedQuestion,
      slots,
      explicitSlots,
      inheritedSlots,
      memorySlots: usableMemorySlots,
      clearedSlots: cleared,
      result: canInherit ? previousTask?.result ?? null : null,
      status: 'PLANNING',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    slots,
    explicitSlots,
    inheritedSlots,
    memorySlots: usableMemorySlots,
    clearedSlots: cleared,
    inheritedTurns: turnsSince,
    previousTaskId: previousTask?.taskId ?? null,
    previousTurnId: previousTask?.turnId ?? null,
    previousTaskQuestion: previousTask?.question ?? '',
    previousTaskHistoryIndex: historyIndex,
  };
}

function slotValues(fields, labelKey = 'sourceText') {
  return slotList((fields ?? []).map((field) => (
    field?.[labelKey]
      ?? field?.field
      ?? field?.name
      ?? field?.value
  )).filter(Boolean), 'result');
}

export function extractSlotsFromAnswer(answer = {}) {
  const semanticParse = answer.semanticParse ?? {};
  const metrics = slotValues(
    semanticParse.metricFields?.length
      ? semanticParse.metricFields
      : answer.indicator?.name
        ? [{ sourceText: answer.indicator.name }]
        : [],
  );
  const times = slotList(
    (semanticParse.timeWindows ?? []).map((window) => (
      window?.sourceText
        ?? [window?.startDate, window?.endDate].filter(Boolean).join(' ~ ')
    )).filter(Boolean),
    'result',
  );
  const dimensions = slotValues(semanticParse.dimensionFields);
  const filters = slotList(
    (semanticParse.filterFields ?? []).map((filter) => (
      filter?.sourceText
        ?? [filter?.field, filter?.value].filter(Boolean).join('=')
    )).filter(Boolean),
    'result',
  );
  const slots = {};
  if (metrics.length) slots.metric = metrics;
  if (times.length) slots.time = times;
  if (dimensions.length) slots.dimensions = dimensions;
  if (filters.length) slots.filters = filters;
  if (answer.analysisMode?.mode) slots.analysisMode = slotList([answer.analysisMode.mode], 'result');
  return slots;
}

export function completeTaskState({
  contextTask,
  answer = {},
  artifactId = null,
  messageId = null,
}) {
  const base = normalizeTaskState(contextTask) ?? {
    taskId: createTaskId(),
    question: '',
    resolvedQuestion: '',
    slots: {},
    explicitSlots: {},
    inheritedSlots: {},
  };
  if (base.turnType === TURN_TYPES.INSTRUCTION) {
    return {
      ...base,
      slots: {},
      explicitSlots: {},
      inheritedSlots: {},
      memorySlots: {},
      result: null,
      resolvedQuestion: answer.resolvedQuestion ?? base.resolvedQuestion,
      status: 'COMPLETED',
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }
  const resultSlots = extractSlotsFromAnswer(answer);
  const slots = mergeSlotSets(base.inheritedSlots, base.memorySlots, base.explicitSlots, resultSlots);
  return {
    ...base,
    slots,
    result: {
      messageId,
      artifactId,
      queryFingerprint: answer.queryFingerprint ?? null,
      dataHash: answer.dataHash ?? null,
    },
    status: 'COMPLETED',
    resolvedQuestion: answer.resolvedQuestion ?? base.resolvedQuestion,
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
}

export function serializeTaskForContract(taskState, question = '') {
  const currentQuestion = String(
    taskState?.question ?? question ?? taskState?.resolvedQuestion ?? '',
  ).trim();
  const parts = [currentQuestion];
  const explicit = describeSlots(taskState?.explicitSlots);
  if (explicit) {
    parts.push(`显式条件：${explicit}`);
  }
  const inherited = taskState?.inheritedSlots ?? {};
  const descriptions = [];
  for (const key of SLOT_ORDER) {
    const values = inherited[key] ?? [];
    if (values.length === 0) {
      continue;
    }
    descriptions.push(`${SLOT_LABELS[key] ?? key}：${values.map((item) => item.sourceText).join('、')}`);
  }
  if (descriptions.length > 0) {
    parts.push(`继承条件（仅以下槽位生效）：${descriptions.join('；')}`);
  }
  const memory = describeSlots(taskState?.memorySlots);
  if (memory) {
    parts.push(`记忆默认：${memory}`);
  }
  if ((taskState?.clearedSlots ?? []).length > 0) {
    parts.push(`本轮已清除：${taskState.clearedSlots.map((key) => SLOT_LABELS[key] ?? key).join('、')}`);
  }
  if (taskState?.result?.artifactId) {
    parts.push(`引用结果产物：${taskState.result.artifactId}`);
  }
  return parts.filter(Boolean).join('\n');
}

// 查询编译器的溯源扫描会读取整段文本，因此这里只拼接真实问题与槽位原文，
// 不加入“显式条件/继承条件”等标签，避免标签被误判为业务片段。
export function serializeTaskBindingText(taskState, question = '') {
  const currentQuestion = String(
    taskState?.question ?? question ?? taskState?.resolvedQuestion ?? '',
  ).trim();
  const contextualSlots = mergeSlotSets(
    taskState?.memorySlots,
    taskState?.inheritedSlots,
  );
  const slotTexts = SLOT_ORDER.flatMap((key) => (
    (contextualSlots[key] ?? []).map((item) => item.sourceText ?? item.value)
  ));
  return unique([currentQuestion, ...slotTexts]).join('；');
}

export function formatTaskForPrompt(taskState) {
  if (!taskState) {
    return '- 无';
  }
  const inherited = describeSlots(taskState.inheritedSlots) || '无';
  const explicit = describeSlots(taskState.explicitSlots) || '无';
  return [
    `- 任务ID：${taskState.taskId ?? '-'}`,
    `- 轮次ID：${taskState.turnId ?? '-'}`,
    `- 关系：${taskState.turnType ?? '-'}`,
    `- 继承深度：${taskState.inheritDepth ?? 0}/${taskState.inheritBudget?.maxTurns ?? DEFAULT_MAX_INHERIT_TURNS}`,
    `- 显式条件：${explicit}`,
    `- 继承条件：${inherited}`,
    `- 记忆默认：${describeSlots(taskState.memorySlots) || '无'}`,
    `- 已清除条件：${(taskState.clearedSlots ?? []).map((key) => SLOT_LABELS[key] ?? key).join('、') || '无'}`,
    `- 引用产物：${taskState.result?.artifactId ?? '无'}`,
  ].join('\n');
}

export function publicContextDecision(context) {
  const toPublic = (slots) => Object.entries(slots ?? {}).flatMap(([key, values]) => (
    values.map((item) => ({
      key,
      label: SLOT_LABELS[key] ?? key,
      value: item.value,
      sourceText: item.sourceText,
      source: item.source,
    }))
  ));
  return {
    turnType: context?.turnType ?? TURN_TYPES.NEW_TASK,
    mode: context?.mode ?? 'INDEPENDENT',
    confidence: context?.confidence ?? 0,
    reason: context?.reason ?? '',
    source: context?.source ?? 'rule',
    taskId: context?.taskId ?? null,
    turnId: context?.turnId ?? null,
    rootTaskId: context?.rootTaskId ?? null,
    originalQuestion: context?.originalQuestion ?? '',
    resolvedQuestion: context?.question ?? '',
    turnTypeLabel: TURN_TYPES[context?.turnType] ?? context?.turnType ?? TURN_TYPES.NEW_TASK,
    inheritDepth: context?.inheritDepth ?? 0,
    inheritBudget: context?.inheritBudget ?? null,
    inheritedSlots: toPublic(context?.inheritedSlots),
    explicitSlots: toPublic(context?.explicitSlots),
    memorySlots: toPublic(context?.memorySlots),
    clearedSlots: context?.clearedSlots ?? [],
    needsConfirmation: Boolean(context?.needsConfirmation),
    referencedArtifactId: context?.referencedArtifactId ?? null,
    conversationDirective: context?.conversationDirective ?? null,
  };
}

export { SLOT_LABELS, SLOT_ORDER };
