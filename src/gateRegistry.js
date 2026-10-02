import { incrementCounter } from './metrics.js';

export const GATE_PHASES = [
  'INTENT',
  'SKILL_AUDIT',
  'SEMANTIC_RESOLVE',
  'SEMANTIC_DISCOVERY',
  'SEMANTIC_CONFIRM',
  'PLAN',
  'VALIDATE',
  'EXECUTE',
  'RESULT_ANALYST',
  'RESULT_VALIDATION',
  'ANALYZE',
  'RESPOND',
];

const GATES = [
  {
    id: 'CONTEXT-001',
    phase: 'INTENT',
    layer: 'CONTEXT',
    name: '独立问题上下文隔离',
    description: 'INDEPENDENT 问题不得继承上一轮的指标、时间、过滤或维度。',
    owner: 'queryIntent.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'ARTIFACT-001',
    phase: 'INTENT',
    layer: 'ARTIFACT',
    name: '产物优先与受控重查',
    description: '能力清单满足时复用产物；缺少基础字段时允许最小重查并保留旧快照。',
    owner: 'artifactCapabilities.js',
    blocking: false,
    skillBypassAllowed: false,
  },
  {
    id: 'CLARIFY-001',
    phase: 'INTENT',
    layer: 'INTERACTION',
    name: '结构化澄清',
    description: '需要确认口径时返回选项、推荐项和 optionId，不使用纯文本反复追问。',
    owner: 'agent.js',
    blocking: false,
    skillBypassAllowed: false,
  },
  {
    id: 'SKILL-001',
    phase: 'SKILL_AUDIT',
    layer: 'SKILL',
    name: 'Skill 口径审计',
    description: 'Skill 只提供规划指导和检查清单，不拥有强制执行权限。',
    owner: 'skills.js / skillAdapter.js',
    blocking: false,
    skillBypassAllowed: true,
  },
  {
    id: 'SEMANTIC-001',
    phase: 'SEMANTIC_DISCOVERY',
    layer: 'SEMANTIC',
    name: '语义对象实时发现',
    description: '指标和数据集必须来自当前实时授权目录。',
    owner: 'indicatorClient.js / businessDatasets.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'SEMANTIC-003',
    phase: 'SEMANTIC_RESOLVE',
    layer: 'SEMANTIC',
    name: '候选裁决唯一性',
    description: '多策略评分必须产生唯一候选，或转入结构化澄清，不得静默择优。',
    owner: 'metricResolver.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'SOURCE-002',
    phase: 'SEMANTIC_DISCOVERY',
    layer: 'SOURCE',
    name: '指标目录来源必须显式标记',
    description: '指标读取必须返回 LIVE / SNAPSHOT{freshAt} / UNAVAILABLE；UNAVAILABLE 时不得继续规划。',
    owner: 'indicatorSource.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'SEMANTIC-002',
    phase: 'SEMANTIC_CONFIRM',
    layer: 'SEMANTIC',
    name: '口径确认',
    description: '执行前必须确认指标定义或数据集字段、枚举和聚合方式。',
    owner: 'agent.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'CONTRACT-001',
    phase: 'PLAN',
    layer: 'PLAN',
    name: '条件账本完整性',
    description: '每个有效问题片段必须绑定到指标、维度、过滤、时间、计算或结果动作。',
    owner: 'queryContractCompiler.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'CONTRACT-002',
    phase: 'PLAN',
    layer: 'PLAN',
    name: '字段映射与白名单',
    description: '指标、维度和过滤字段必须映射到当前数据源真实字段。',
    owner: 'queryContractCompiler.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'CONTRACT-003',
    phase: 'PLAN',
    layer: 'PLAN',
    name: '时间窗口与粒度',
    description: '时间表达、趋势粒度、同比环比窗口必须完整绑定。',
    owner: 'queryContractCompiler.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'CONTRACT-004',
    phase: 'PLAN',
    layer: 'PLAN',
    name: '派生指标表达式',
    description: '比率、增长率、差额和百分点变化必须提交结构化公式。',
    owner: 'derivedMetrics.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'CONTRACT-005',
    phase: 'PLAN',
    layer: 'PLAN',
    name: '口径与指标类型一致性',
    description: '含税、未税、金额、数量、比率等语义必须与绑定指标一致。',
    owner: 'queryContractCompiler.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'CONTRACT-006',
    phase: 'PLAN',
    layer: 'PLAN',
    name: '聚合阈值绑定',
    description: '金额、数量、毛利阈值必须绑定聚合过滤，不能静默丢失。',
    owner: 'queryContractCompiler.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'CONTRACT-007',
    phase: 'PLAN',
    layer: 'PLAN',
    name: '过滤和范围可追溯',
    description: '过滤值和全量范围必须来自问题原文或主题规则。',
    owner: 'queryContractCompiler.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'PERMISSION-001',
    phase: 'VALIDATE',
    layer: 'SECURITY',
    name: '用户权限边界',
    description: '主题、指标、数据集、行级和列级权限由平台强制求值。',
    owner: 'permissions.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'SOURCE-001',
    phase: 'VALIDATE',
    layer: 'SOURCE',
    name: '取数来源裁决',
    description: '主题绑定业务数据集时，最终取数必须使用业务数据集。',
    owner: 'agent.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'SQL-001',
    phase: 'EXECUTE',
    layer: 'SQL',
    name: '过滤作用域',
    description: '明细条件进入 WHERE，聚合条件进入 HAVING。',
    owner: 'businessDatasets.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'SQL-002',
    phase: 'EXECUTE',
    layer: 'SQL',
    name: 'LIKE 包含语义',
    description: '包含语义必须转换为 %value% 模式。',
    owner: 'querySemantics.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'SQL-003',
    phase: 'EXECUTE',
    layer: 'SQL',
    name: '时间粒度执行',
    description: '日期维度按 DAY/WEEK/MONTH/QUARTER/YEAR 在 SQL 中分组。',
    owner: 'businessDatasets.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'SQL-004',
    phase: 'EXECUTE',
    layer: 'SQL',
    name: '只读 SQL 边界',
    description: '模型不得生成 SQL，表达式由受控查询构建器执行。',
    owner: 'businessDatasets.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'CODE-001',
    phase: 'EXECUTE',
    layer: 'CODE',
    name: '生成式代码不得持有数据源访问能力',
    description: '模型生成的 Python 只能读写沙箱 input/ 与 output/，不得持有数据源凭证、不得直连数据库。',
    owner: 'codeExecution.js',
    blocking: true,
    skillBypassAllowed: false,
  },
  {
    id: 'SQL-005',
    phase: 'RESULT_VALIDATION',
    layer: 'RESULT',
    name: '截断与行数限制',
    description: '达到查询上限时必须显式标记 truncated。',
    owner: 'businessDatasets.js / agent.js',
    blocking: false,
    skillBypassAllowed: false,
  },
  {
    id: 'RESULT-001',
    phase: 'RESULT_VALIDATION',
    layer: 'RESULT',
    name: '结果一致性验证',
    description: '验证粒度、合计、比率复算、时间和权限证据。',
    owner: 'agent.js / skills.js',
    blocking: false,
    skillBypassAllowed: true,
  },
  {
    id: 'RESULT-002',
    phase: 'RESULT_ANALYST',
    layer: 'RESULT',
    name: '分析结论有据',
    description: '合计、TopN、趋势、异常与业务判断必须由确定性计算产生并附证据。',
    owner: 'resultAnalyst.js',
    blocking: false,
    skillBypassAllowed: false,
  },
  {
    id: 'PRESENT-001',
    phase: 'ANALYZE',
    layer: 'PRESENTATION',
    name: '展示契约',
    description: '模型生成结构化展示契约，确定性渲染器负责最终格式。',
    owner: 'resultPresentation.js',
    blocking: false,
    skillBypassAllowed: false,
  },
  {
    id: 'CANCEL-001',
    phase: 'RESPOND',
    layer: 'INTERACTION',
    name: '请求取消传播',
    description: '前端取消必须终止正在进行的模型请求。',
    owner: 'harness.js / server.js',
    blocking: false,
    skillBypassAllowed: false,
  },
];

const ISSUE_GATE_MAP = {
  CONDITION_LEDGER_REQUIRED: 'CONTRACT-001',
  METRIC_FIELD_UNRESOLVED: 'CONTRACT-002',
  DIMENSION_FIELD_UNRESOLVED: 'CONTRACT-002',
  FILTER_FIELD_UNRESOLVED: 'CONTRACT-002',
  TIME_FIELD_UNAVAILABLE: 'CONTRACT-003',
  TIME_CONDITION_NOT_COVERED: 'CONTRACT-003',
  TIME_GRAIN_NOT_RESOLVED: 'CONTRACT-003',
  TREND_TIME_DIMENSION_REQUIRED: 'CONTRACT-003',
  DERIVED_METRIC_INVALID: 'CONTRACT-004',
  METRIC_MEASURE_TYPE_MISMATCH: 'CONTRACT-005',
  METRIC_TAX_POLARITY_MISMATCH: 'CONTRACT-005',
  METRIC_RATE_MISMATCH: 'CONTRACT-005',
  FILTER_THRESHOLD_NOT_BOUND: 'CONTRACT-006',
  FILTER_RULE_NOT_TRACEABLE: 'CONTRACT-007',
  SCOPE_RULE_NOT_TRACEABLE: 'CONTRACT-007',
  QUESTION_CLAUSE_NOT_COVERED: 'CONTRACT-001',
  QUESTION_RESIDUE_NOT_BOUND: 'CONTRACT-001',
  CONDITION_BINDING_MISSING: 'CONTRACT-001',
  SEMANTIC_CATEGORY_NOT_BOUND: 'CONTRACT-001',
  SEMANTIC_MAPPING_AMBIGUOUS: 'CONTRACT-002',
  BUSINESS_DATASET_EXECUTION_REQUIRED: 'SOURCE-001',
  RESULT_TRUNCATED: 'SQL-005',
  CODE_DATASOURCE_ACCESS_FORBIDDEN: 'CODE-001',
  CODE_WORKSPACE_ESCAPE: 'CODE-001',
  INDICATOR_SOURCE_UNAVAILABLE: 'SOURCE-002',
  SEMANTIC_ADJUDICATION_AMBIGUOUS: 'SEMANTIC-003',
  RESULT_ANALYSIS_NOT_EVIDENCED: 'RESULT-002',
};

export function listGates({ phase = null, layer = null, blocking = null } = {}) {
  return GATES.filter((gate) => (
    (!phase || gate.phase === phase)
    && (!layer || gate.layer === layer)
    && (blocking === null || gate.blocking === blocking)
  ));
}

export function getGate(id) {
  return GATES.find((gate) => gate.id === String(id)) ?? null;
}

export function gateForIssue(issue) {
  const mapped = ISSUE_GATE_MAP[String(issue?.code ?? '')];
  if (mapped) {
    return getGate(mapped);
  }
  const phase = String(issue?.phase ?? '').toUpperCase();
  if (phase) {
    return listGates({ phase })[0] ?? null;
  }
  return null;
}

export function attachGateMetadata(issues = []) {
  return (issues ?? []).map((issue) => {
    const gate = gateForIssue(issue);
    return gate
      ? {
        ...issue,
        gateId: gate.id,
        gatePhase: gate.phase,
        gateLayer: gate.layer,
        gateOwner: gate.owner,
        blocking: gate.blocking && issue.level === 'ERROR',
      }
      : issue;
  });
}

export function summarizeGateIssues(issues = []) {
  const decorated = attachGateMetadata(issues);
  const errors = decorated.filter((issue) => issue.level === 'ERROR');
  const warnings = decorated.filter((issue) => issue.level === 'WARN');
  for (const issue of errors.filter((item) => item.blocking)) {
    incrementCounter('gate_block_total', {
      gateId: issue.gateId ?? 'UNKNOWN',
      phase: issue.gatePhase ?? 'UNKNOWN',
      blocking: 'true',
    });
  }
  return {
    total: decorated.length,
    errors: errors.length,
    warnings: warnings.length,
    blocking: errors.filter((issue) => issue.blocking).length,
    byPhase: Object.fromEntries(
      GATE_PHASES.map((phase) => [
        phase,
        decorated.filter((issue) => issue.gatePhase === phase).length,
      ]).filter(([, count]) => count > 0),
    ),
    issues: decorated,
  };
}

// Startup assertion: every workflow stage must own at least one gate so a newly
// added stage cannot silently ship without a rule (P0-7).
export function assertGateCoverage(stageCodes = GATE_PHASES) {
  const covered = new Set(GATES.map((gate) => gate.phase));
  const missing = [...new Set(stageCodes.map((code) => String(code).toUpperCase()))]
    .filter((code) => !covered.has(code));
  if (missing.length > 0) {
    throw new Error(
      `gate coverage assertion failed; stages without a gate: ${missing.join(', ')}`,
    );
  }
  return {
    stages: stageCodes.length,
    gates: GATES.length,
  };
}

export { GATES };
