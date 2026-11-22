import { listGates } from './gateRegistry.js';

// 14 个标准阶段是 Runtime、门禁、Skills、审计和页面展示的共同语言。
// 目录本身是纯数据；生命周期推进见 workflow.js 的 DataAgentWorkflow。
const BASE_STAGE_DEFINITIONS = [
  { code: 'INTENT', name: '理解问题', description: '识别问数意图、主题和多轮上下文' },
  { code: 'SKILL_AUDIT', name: 'Skill 口径审计', description: '按Skill检查数据含义、粒度、时间和来源' },
  { code: 'SEMANTIC_RESOLVE', name: '语义解析', description: '拆解指标、维度和枚举生成候选并执行多策略裁决' },
  { code: 'SEMANTIC_DISCOVERY', name: '检索语义对象', description: '搜索相关指标或业务数据集' },
  { code: 'SEMANTIC_CONFIRM', name: '确认口径', description: '确认指标定义或数据集字段口径' },
  { code: 'PLAN', name: '生成查询计划', description: '将问题编译为结构化查询计划' },
  { code: 'VALIDATE', name: '校验计划', description: '校验字段白名单、数据集和数据权限' },
  { code: 'EXECUTE', name: '执行查询', description: '通过受控适配器执行只读查询' },
  { code: 'RESULT_ANALYST', name: '结果分析', description: '生成合计、TopN、趋势、异常和业务判断' },
  { code: 'ANALYSIS_CODE', name: '代码驱动分析', description: '生成分析代码在沙箱内处理已锁定快照，产出符合分析结果契约的产物' },
  { code: 'RESULT_VALIDATION', name: 'Skill 结果验证', description: '按Skill验证结果和回答证据' },
  { code: 'ANALYZE', name: '分析结果', description: '选择可视化并提炼关键发现' },
  { code: 'RESPOND', name: '生成回答', description: '输出业务回答、证据与执行过程' },
  { code: 'REFLECT', name: '执行后反思', description: '答其所问、数字自洽与是否需换策略三检，失败触发换策略重规划' },
];

export const STAGE_DEFINITIONS = BASE_STAGE_DEFINITIONS.map((definition) => ({
  ...definition,
  gateIds: listGates({ phase: definition.code }).map((gate) => gate.id),
}));
