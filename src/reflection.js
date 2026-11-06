import { responseOutputText } from './harness.js';

// Execution-time reflection for the DataAgent pipeline.
//
// After the 13-stage workflow produces a RESPOND, we run three checks to
// decide whether the answer is good enough or whether the agent should
// replan with a *changed strategy* (not merely clarify):
//
//   ① answerable       —— does the answer actually answer, or did the model
//                          decline despite having data?
//   ② numeric_consistency —— do the headline numbers in the answer match the
//                          locked result (backstop against fabrication)?
//   ③ strategy_sound   —— LLM-as-Judge: is the answer on-topic, consistent
//                          with the data, and would a changed strategy help?
//
// The module is intentionally pure and dependency-light so it can be unit
// tested without a model and reused by the eval runner (L3 answer-level).
//
// IMPORTANT (platform invariant): the Judge only ever makes a *go / no-go*
// decision about replanning. It never participates in producing numbers;
// every number still flows through the deterministic query path.

export const REFLECTION_VERSION = '1.0.0';

// Relative tolerance for headline magnitude matching (numeric backstop).
const NUM_REL_TOLERANCE = 0.02;
// An answer number is "significant" (worth verifying) at/above this magnitude
// or when it carries a 万/亿 scale unit.
const SIGNIFICANT_MAGNITUDE = 100;
// Log-order tolerance: a headline within 10x of *some* result magnitude passes.
const LOG_ORDER_TOLERANCE = 1;
const DEFAULT_JUDGE_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// deterministic helpers
// ---------------------------------------------------------------------------

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s,，。.、；;:：!！?？()（）[\]【】%％"“"]/g, '');
}

const STOPWORDS = new Set([
  '的', '了', '是', '和', '与', '在', '我', '你', '他', '她', '它', '们',
  '请', '多少', '什么', '哪个', '怎么', '如何', '分析', '查询', '统计',
  '显示', '列出', '对比', '比较', '排名', '前', '按照', '根据', '本月',
  '上周', '今年', '去年', '同比', '环比', '趋势', '变化', '这个', '那个',
  '以及', '并且', '还是', '是否', '一下', '我们', '你们', '他们', '对于',
  '关于', '进行', '需要', '可以', '能够', '因为', '所以', '但是', '然而',
]);

function extractNumbers(text) {
  const raw = String(text ?? '');
  const matches = raw.match(
    /(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:万|亿|w|千|百|个|家|元|万元|亿元|百分比|倍|%|percent)?/gi,
  ) ?? [];
  const values = [];
  for (const m of matches) {
    const numPart = m.match(/(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/);
    if (!numPart) {
      continue;
    }
    let value = Number(numPart[0].replaceAll(',', ''));
    if (!Number.isFinite(value)) {
      continue;
    }
    const unit = m.replace(/[\d.,\s]/g, '').toLowerCase();
    if (unit.includes('亿') || unit === 'yi') {
      value *= 1e8;
    } else if (unit.includes('万') || unit === 'w') {
      value *= 1e4;
    } else if (unit.includes('千') || unit === 'q') {
      value *= 1e3;
    } else if (unit.includes('百') || unit === 'b') {
      value *= 1e2;
    }
    values.push({ raw: m.trim(), value, unit: unit || 'raw' });
  }
  return values;
}

function resultMagnitudes(result) {
  const magnitudes = [];
  const rows = result?.rows ?? [];
  if (!Array.isArray(rows)) {
    return magnitudes;
  }
  const columns = Array.isArray(result?.columns) ? result.columns : [];
  // Answers are written in the display contract's unit (for example 万元),
  // while rows still carry the raw value (for example 元). Compare against
  // both representations so a correct converted headline is not treated as a
  // fabricated number.
  for (const column of columns) {
    if (!column || typeof column !== 'object') {
      continue;
    }
    const keys = [column.bizName, column.field, column.name].filter(Boolean);
    const scale = Number(column.displayScale);
    if (!Number.isFinite(scale) || scale <= 0 || scale === 1) {
      continue;
    }
    const key = keys.find((candidate) => rows.some(
      (row) => row && Number.isFinite(Number(row[candidate])),
    ));
    if (!key) {
      continue;
    }
    let sum = 0;
    let has = false;
    for (const row of rows) {
      const n = Number(row?.[key]);
      if (Number.isFinite(n)) {
        const scaled = Math.abs(n * scale);
        if (scaled !== 0) {
          magnitudes.push(scaled);
        }
        sum += scaled;
        has = true;
      }
    }
    if (has && sum !== 0) {
      magnitudes.push(sum);
    }
  }
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue;
    }
    for (const value of Object.values(row)) {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(n) && n !== 0) {
        magnitudes.push(Math.abs(n));
      }
    }
  }
  // Include per-column sums as candidate magnitudes (headline totals).
  if (Array.isArray(columns) && columns.length > 0) {
    for (const column of columns) {
      const key = typeof column === 'string'
        ? column
        : column?.bizName ?? column?.field ?? column?.name;
      if (!key) {
        continue;
      }
      let sum = 0;
      let has = false;
      for (const row of rows) {
        const n = Number(row?.[key]);
        if (Number.isFinite(n)) {
          sum += n;
          has = true;
        }
      }
      if (has && sum !== 0) {
        magnitudes.push(Math.abs(sum));
      }
    }
  }
  return magnitudes;
}

function hasData(result) {
  const rows = result?.rows ?? [];
  return Array.isArray(rows) && rows.length > 0;
}

const REFUSAL_PATTERNS = [
  /(抱歉|对不起|很遗憾)[^。\n]{0,24}(无法|不能|暂时不能|没有)/,
  /我(们)?(无法|不能|暂时无法|暂时不能)(回答|确定|提供|给出|查询|获取|完成)/,
  /(无法|不能)(回答|确定|提供|给出|查询|获取)(这个|该|您|你|此|问题|需求)/,
  /缺少(必要|所需|足够)?(的)?(规则|口径|信息|数据|依据)来/,
  /(由于|因)[^。\n]{0,20}(缺少|不足|缺失)[^。\n]{0,12}(规则|口径|信息|数据)/,
];

function isRefusal(answer) {
  const text = String(answer ?? '');
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// check ①: answerable
// ---------------------------------------------------------------------------

export function checkAnswerable({ question, answer, result }) {
  if (!hasData(result)) {
    return {
      name: 'answerable',
      pass: true,
      detail: '无查询结果（澄清/无数据场景），跳过答其所问硬检查',
      refusalWithData: false,
    };
  }
  const declined = isRefusal(answer);
  if (declined) {
    return {
      name: 'answerable',
      pass: false,
      detail: '锁定结果已有数据，但回答疑似拒绝作答（出现澄清/歉意式拒答），应直接基于锁定结果给出结论',
      refusalWithData: true,
    };
  }
  return {
    name: 'answerable',
    pass: true,
    detail: '回答未出现明显拒答，进入后续检查',
    refusalWithData: false,
  };
}

// ---------------------------------------------------------------------------
// check ②: numeric consistency (headline backstop)
// ---------------------------------------------------------------------------

export function checkNumericConsistency({ answer, result }) {
  if (!hasData(result)) {
    return {
      name: 'numeric_consistency',
      pass: true,
      detail: '无查询结果，跳过数字自洽检查',
      headline: null,
    };
  }
  const magnitudes = resultMagnitudes(result);
  if (magnitudes.length === 0) {
    return {
      name: 'numeric_consistency',
      pass: true,
      detail: '锁定结果无可比对数值，跳过',
      headline: null,
    };
  }
  const numbers = extractNumbers(answer).filter(
    (item) => item.value >= SIGNIFICANT_MAGNITUDE
      || item.unit === '万'
      || item.unit === '亿'
      || item.unit === 'w'
      || item.unit === 'yi',
  );
  if (numbers.length === 0) {
    return {
      name: 'numeric_consistency',
      pass: true,
      detail: '回答未给出需校验的显著数值，跳过',
      headline: null,
    };
  }
  // The headline is the largest-magnitude number the answer states.
  const headline = numbers.reduce(
    (max, item) => (item.value > max.value ? item : max),
    numbers[0],
  );
  const maxResult = Math.max(...magnitudes);
  const minResult = Math.min(...magnitudes);
  const withinAny = magnitudes.some((r) => {
    if (r === 0) {
      return false;
    }
    const rel = Math.abs(headline.value - r) / Math.max(Math.abs(headline.value), Math.abs(r));
    const logDiff = Math.abs(Math.log10(Math.abs(headline.value)) - Math.log10(Math.abs(r)));
    return rel <= NUM_REL_TOLERANCE || logDiff <= LOG_ORDER_TOLERANCE;
  });
  if (withinAny) {
    return {
      name: 'numeric_consistency',
      pass: true,
      detail: `回答头条数值 ${headline.raw} 与锁定结果量级一致（结果区间 ${minResult.toExponential(2)}~${maxResult.toExponential(2)}）`,
      headline: headline.raw,
    };
  }
  return {
    name: 'numeric_consistency',
    pass: false,
    detail: `回答头条数值 ${headline.raw} 与锁定结果量级严重不符（结果区间 ${minResult.toExponential(2)}~${maxResult.toExponential(2)}），疑似编造或单位错配`,
    headline: headline.raw,
  };
}

// ---------------------------------------------------------------------------
// check ③: strategy soundness via LLM-as-Judge
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM = `你是一个严格的指标问数答案质检员。你会拿到：用户问题、基于平台确定性查询得到的「结果摘要」、以及智能体生成的「回答」。
只依据给定信息判断，不要编造数据，不要替用户做查询。
请输出严格的一行 JSON（不要 markdown 代码块），包含四个字段：
- answersQuestion: 布尔，回答是否真正回答了用户问题（而非只讲方法、只反问、或答非所问）
- consistentWithData: 布尔，回答的核心结论（数字、维度、时间范围）是否与结果摘要一致
- needsReplan: 布尔，当且仅当当前回答明显跑偏、数据不足以支撑、或换一种查询/分析策略（换维度、换指标、拆分子板块、改时间粒度、改归因口径）更可能得到正确结论时为 true；普通澄清或已正确作答必须为 false
- reason: 字符串，一句话说明判断依据
- hint: 字符串，仅当 needsReplan 为 true 时给出给下游「重规划」的具体可执行提示（例如“应改按 customer_name 维度拆分而非整体求和”）；否则为空字符串`;

function buildJudgeUserPrompt({ question, answer, result }) {
  const rows = result?.rows ?? [];
  let summary = '（无数据）';
  if (Array.isArray(rows) && rows.length > 0) {
    const head = rows.slice(0, 5);
    summary = `共 ${rows.length} 行；字段：${Object.keys(head[0] ?? {}).join('、')}；样例：${JSON.stringify(head)}`;
  }
  return [
    `【用户问题】${question}`,
    `【结果摘要】${summary}`,
    `【智能体回答】${answer}`,
  ].join('\n');
}

function parseJudgeVerdict(text) {
  if (!text) {
    return null;
  }
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    const obj = JSON.parse(match[0]);
    // Require complete boolean decisions; partial or coerced verdicts cannot
    // safely determine whether an answer passes or needs a strategy replan.
    const hasValidDecisions = ['answersQuestion', 'consistentWithData', 'needsReplan']
      .every((key) => typeof obj[key] === 'boolean');
    if (!hasValidDecisions) {
      return null;
    }
    return {
      answersQuestion: obj.answersQuestion,
      consistentWithData: obj.consistentWithData,
      needsReplan: obj.needsReplan,
      reason: String(obj.reason ?? ''),
      hint: String(obj.hint ?? ''),
    };
  } catch {
    return null;
  }
}

export async function checkStrategySound({
  question,
  answer,
  result,
  judge,
  timeoutMs = DEFAULT_JUDGE_TIMEOUT_MS,
}) {
  if (!hasData(result)) {
    return {
      name: 'strategy_sound',
      pass: true,
      detail: '无数据（澄清场景），策略检查交由上游，不触发换策略',
      judgeUsed: false,
      degraded: false,
      needsReplan: false,
      hint: '',
      reason: '',
    };
  }
  if (typeof judge !== 'function') {
    return {
      name: 'strategy_sound',
      pass: true,
      detail: '未配置 Judge（无可用模型），退化为规则检查，不触发换策略',
      judgeUsed: false,
      degraded: true,
      needsReplan: false,
      hint: '',
      reason: '',
    };
  }
  let verdictText;
  let timedOut = false;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  try {
    verdictText = await Promise.race([
      judge(JUDGE_SYSTEM, buildJudgeUserPrompt({ question, answer, result }), {
        signal: controller?.signal,
      }),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller?.abort();
          reject(new Error('REFLECTION_JUDGE_TIMEOUT'));
        }, Math.max(1, Number(timeoutMs) || DEFAULT_JUDGE_TIMEOUT_MS));
      }),
    ]);
  } catch {
    return {
      name: 'strategy_sound',
      pass: true,
      detail: timedOut
        ? 'Judge 超时，退化为规则检查，不触发换策略'
        : 'Judge 调用失败，退化为规则检查，不触发换策略',
      judgeUsed: timedOut,
      degraded: true,
      needsReplan: false,
      hint: '',
      reason: '',
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
  const verdict = parseJudgeVerdict(verdictText);
  if (!verdict) {
    return {
      name: 'strategy_sound',
      pass: true,
      detail: 'Judge 返回无法解析，退化为规则检查，不触发换策略',
      judgeUsed: true,
      degraded: true,
      needsReplan: false,
      hint: '',
      reason: '',
    };
  }
  const pass = verdict.answersQuestion && verdict.consistentWithData;
  return {
    name: 'strategy_sound',
    pass,
    detail: verdict.reason || (pass ? 'Judge 判定回答切题且与数据一致' : 'Judge 判定回答存在偏差'),
    judgeUsed: true,
    degraded: false,
    needsReplan: Boolean(verdict.needsReplan),
    hint: verdict.hint || '',
    reason: verdict.reason || '',
  };
}

// ---------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------

export function buildReplanHint(checks) {
  const failed = checks.filter((check) => !check.pass);
  if (failed.length === 0) {
    return '请基于已锁定结果换一种分析策略（例如换维度、拆分子板块、改时间粒度或归因口径）重新作答。';
  }
  const parts = failed.map((check) => {
    if (check.name === 'numeric_consistency') {
      return '回答数字与锁定结果不一致，请严格以平台锁定结果为准重算，不要引入结果外的数值';
    }
    if (check.name === 'answerable') {
      return '回答未真正作答，请直接基于锁定结果给出业务结论，不要反问或歉意式拒答';
    }
    return check.detail || check.name;
  });
  return parts.join('；');
}

export async function reflectOnAnswer({
  question,
  answer,
  result,
  contract = null,
  judge = null,
  depth = 0,
  judgeTimeoutMs = DEFAULT_JUDGE_TIMEOUT_MS,
}) {
  const answerable = checkAnswerable({ question, answer, result });
  const numeric = checkNumericConsistency({ answer, result });
  const strategy = await checkStrategySound({
    question,
    answer,
    result,
    judge,
    timeoutMs: judgeTimeoutMs,
  });

  // Whether to trigger a changed-strategy replan (not a clarification).
  // Replan is driven by the intelligent Judge (③) or a high-confidence
  // refusal-with-data (①). The heuristic numeric backstop (②) is recorded for
  // observability but never auto-triggers a re-run, so unit/scale ambiguity
  // cannot break the platform's determinism / idempotency guarantees.
  const needsReplan = Boolean(strategy.needsReplan || answerable.refusalWithData);

  const passed = answerable.pass && numeric.pass && strategy.pass;
  const hint = needsReplan
    ? (strategy.hint || buildReplanHint([answerable, numeric, strategy]))
    : null;

  return {
    version: REFLECTION_VERSION,
    depth,
    passed,
    needsReplan,
    hint,
    judgeUsed: strategy.judgeUsed,
    degraded: strategy.degraded,
    checks: [answerable, numeric, strategy],
  };
}

// ---------------------------------------------------------------------------
// Judge factory: wrap a harness as a (system, user) => text judge.
// Uses the low-level `chat` (single round, NO tools, NO executeTool) so the
// judge call is side-effect-free and can never re-run the agent's query tools
// or corrupt agent/run state. Returns null for local-rule (no real model) so
// reflection degrades cleanly to the deterministic checks.
// ---------------------------------------------------------------------------

export function createHarnessJudge(harness) {
  if (!harness || typeof harness.chat !== 'function' || harness.mode === 'local-rule') {
    return null;
  }
  return async function judge(systemText, userText, options = {}) {
    const payload = await harness.chat(
      [
        { role: 'system', content: systemText },
        { role: 'user', content: userText },
      ],
      [],
      { judge: true, callType: 'REFLECTION_JUDGE', signal: options.signal },
    );
    return responseOutputText(payload);
  };
}

export default { reflectOnAnswer, createHarnessJudge, REFLECTION_VERSION };
