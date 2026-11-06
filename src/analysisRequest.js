import { isAttributionText, isTrendText } from './analysisIntent.js';

export const TASK_KINDS = Object.freeze({
  QUERY: 'QUERY',
  ANALYSIS: 'ANALYSIS',
  RESULT_OPERATION: 'RESULT_OPERATION',
  CLARIFICATION: 'CLARIFICATION',
});

export const ANALYSIS_PURPOSES = Object.freeze({
  DESCRIBE: 'DESCRIBE',
  COMPARE: 'COMPARE',
  DIAGNOSE: 'DIAGNOSE',
  EXPLAIN: 'EXPLAIN',
  OPPORTUNITY: 'OPPORTUNITY',
  DECISION: 'DECISION',
});

const RESULT_OPERATION_PATTERN = /导出|下载|转成|转换成|生成\s*(?:excel|xlsx|csv|文件)|换成?(?:折线|柱状|饼|表格)|重新排序|改名|格式化/i;
const REPORT_PATTERN = /分析报告|诊断报告|经营分析|深入分析|系统分析|复盘|洞察/i;
const COMPARE_PATTERN = /同比|环比|同期|对比|比较|较(?:去年|上年|上月|上期)|变化|增减/i;
const DIAGNOSE_PATTERN = /下降|下滑|减少|流失|异常|风险|问题|短板|拖累|恶化|改善较差|下降较多|下降比较多/i;
const EXPLAIN_PATTERN = /原因|为什么|为何|驱动|影响因素|贡献|归因|拆解|解读/i;
const OPPORTUNITY_PATTERN = /机会点|机会|潜力|提升空间|增长点|突破口|可挽回|怎么改善|如何改善|建议/i;
const DECISION_PATTERN = /优先|应该|下一步|行动|策略|资源|投入|取舍|决策/i;

function unique(values) {
  return [...new Set(values)];
}

function buildStages(purposes) {
  const stages = ['VALIDATE_SCOPE', 'LOCK_EVIDENCE'];
  if (purposes.includes(ANALYSIS_PURPOSES.COMPARE)) stages.push('PERIOD_COMPARISON');
  if (purposes.some((item) => [
    ANALYSIS_PURPOSES.DIAGNOSE,
    ANALYSIS_PURPOSES.EXPLAIN,
  ].includes(item))) stages.push('MATERIALITY_RANKING', 'SEGMENT_DIAGNOSIS');
  if (purposes.includes(ANALYSIS_PURPOSES.OPPORTUNITY)) stages.push('OPPORTUNITY_HYPOTHESES');
  if (purposes.includes(ANALYSIS_PURPOSES.DECISION)) stages.push('ACTION_PRIORITIZATION');
  stages.push('EVIDENCE_VALIDATION', 'REPORT');
  return unique(stages);
}

export function inferAnalysisRequest(question, context = {}) {
  const source = String(question ?? '').trim();
  const contextReason = String(context.contextReason ?? '');
  const isClarification = String(context.turnType ?? '') === 'CLARIFICATION_ANSWER'
    || /clarification/i.test(contextReason);
  if (contextReason === 'result_operation' || RESULT_OPERATION_PATTERN.test(source)) {
    return {
      taskKind: TASK_KINDS.RESULT_OPERATION,
      interactionKind: isClarification ? TASK_KINDS.CLARIFICATION : TASK_KINDS.RESULT_OPERATION,
      purposes: [],
      requiresReport: false,
      requiresCode: false,
      requiresPostQueryAnalysis: false,
      stages: [],
    };
  }

  const purposes = [];
  if (COMPARE_PATTERN.test(source)) purposes.push(ANALYSIS_PURPOSES.COMPARE);
  if (DIAGNOSE_PATTERN.test(source)) purposes.push(ANALYSIS_PURPOSES.DIAGNOSE);
  if (EXPLAIN_PATTERN.test(source) || isAttributionText(source)) {
    purposes.push(ANALYSIS_PURPOSES.EXPLAIN);
  }
  if (OPPORTUNITY_PATTERN.test(source)) purposes.push(ANALYSIS_PURPOSES.OPPORTUNITY);
  if (DECISION_PATTERN.test(source)) purposes.push(ANALYSIS_PURPOSES.DECISION);
  if (isTrendText(source) && purposes.length === 0) purposes.push(ANALYSIS_PURPOSES.DESCRIBE);

  const normalizedPurposes = unique(purposes);
  const deepPurpose = normalizedPurposes.some((item) => [
    ANALYSIS_PURPOSES.DIAGNOSE,
    ANALYSIS_PURPOSES.EXPLAIN,
    ANALYSIS_PURPOSES.OPPORTUNITY,
    ANALYSIS_PURPOSES.DECISION,
  ].includes(item));
  const requiresReport = REPORT_PATTERN.test(source)
    || deepPurpose
    || normalizedPurposes.length >= 2;
  const taskKind = requiresReport ? TASK_KINDS.ANALYSIS : TASK_KINDS.QUERY;

  return {
    taskKind,
    interactionKind: isClarification ? TASK_KINDS.CLARIFICATION : taskKind,
    purposes: normalizedPurposes,
    requiresReport,
    requiresCode: requiresReport,
    requiresPostQueryAnalysis: requiresReport,
    stages: requiresReport ? buildStages(normalizedPurposes) : [],
  };
}

export function buildAnalysisRequestPrompt(request) {
  if (!request || request.taskKind !== TASK_KINDS.ANALYSIS) {
    return '本轮任务类型：QUERY（直接问数）。查询结果锁定后直接回答。';
  }
  return [
    '本轮任务类型：ANALYSIS（分析报告）。',
    `分析目的：${request.purposes.join('、') || ANALYSIS_PURPOSES.DESCRIBE}`,
    `必须完成的阶段：${request.stages.join(' -> ')}`,
    '查询只负责形成可复现的证据快照，不是本轮终点。',
    '查询成功后必须调用 execute_analysis_code，读取返回的 workspaceArtifactId，并将它放入 inputArtifactIds。',
    '规划查询时先明确指标、实体粒度、当前期、对比期和必要拆解维度；查询快照必须保留完成后续计算所需的最细粒度，不能只取一个总数。',
    '比较阶段至少计算本期值、对比期值、绝对变化和相对变化；排序时同时考虑变化绝对值与变化率，避免小基数对象仅凭百分比排在最前。',
    '诊断阶段区分新增、流失、持续增长、持续下降和抵消增长等可由数据直接判定的类型；没有对应字段时不得臆测原因。',
    '报告必须按“结论摘要、关键发现、机会与行动、限制”组织，关键发现要能回指具体结果行或总计。',
    '代码必须生成 output/analysis.json；最终回答必须来自通过校验的分析产物。',
    '机会点必须区分数据直接支持的机会与待验证假设；不得把相关性写成因果结论。',
  ].join('\n');
}
