export const ANALYSIS_REQUEST_CASES = [
  {
    id: 'TASK-QUERY-SUMMARY',
    category: '新问题',
    question: '上个月的销售额是多少',
    expect: { taskKind: 'QUERY', requiresReport: false },
  },
  {
    id: 'TASK-QUERY-BREAKDOWN',
    category: '分组问数',
    question: '上个月各业务类型的销售额是多少',
    expect: { taskKind: 'QUERY', requiresReport: false },
  },
  {
    id: 'TASK-QUERY-COMPARISON',
    category: '直接对比',
    question: '本月销售额同比是多少',
    expect: { taskKind: 'QUERY', purposes: ['COMPARE'], requiresReport: false },
  },
  {
    id: 'TASK-ANALYSIS-DIAGNOSIS',
    category: '诊断分析',
    question: '与去年同期对比，哪些客户下降比较多？',
    expect: { taskKind: 'ANALYSIS', purposes: ['COMPARE', 'DIAGNOSE'], requiresReport: true },
  },
  {
    id: 'TASK-ANALYSIS-OPPORTUNITY',
    category: '机会分析',
    question: '与去年同期对比，哪些客户下降比较多？有什么机会点',
    expect: {
      taskKind: 'ANALYSIS',
      purposes: ['COMPARE', 'DIAGNOSE', 'OPPORTUNITY'],
      requiresReport: true,
    },
  },
  {
    id: 'TASK-ANALYSIS-DECISION',
    category: '决策分析',
    question: '哪些区域应该优先投入资源，给出分析报告',
    expect: { taskKind: 'ANALYSIS', purposes: ['DECISION'], requiresReport: true },
  },
  {
    id: 'TASK-RESULT-OPERATION',
    category: '结果操作',
    question: '把这个结果导出成 Excel',
    context: { contextReason: 'result_operation' },
    expect: { taskKind: 'RESULT_OPERATION', requiresReport: false },
  },
  {
    id: 'TASK-FOLLOW-UP-ANALYSIS',
    category: '追问分析',
    question: '这些客户为什么下降？有什么机会点',
    context: { contextReason: 'result_reference' },
    expect: {
      taskKind: 'ANALYSIS',
      purposes: ['DIAGNOSE', 'EXPLAIN', 'OPPORTUNITY'],
      requiresReport: true,
    },
  },
  {
    id: 'TASK-CALIBER-CLARIFICATION',
    category: '口径澄清',
    question: '按含税口径',
    context: { turnType: 'CLARIFICATION_ANSWER', contextReason: 'clarification_answer' },
    expect: { taskKind: 'QUERY', interactionKind: 'CLARIFICATION', requiresReport: false },
  },
];
