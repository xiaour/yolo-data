import { extractTimeGrainExpression } from './queryIntent.js';
import { extractTemporalMentions } from './timeSemantics.js';

export const ANALYSIS_CONDITION_CATEGORIES = [
  {
    code: 'TIME_WINDOW',
    label: '时间范围',
    conditionKind: 'TIME',
    owner: 'PLATFORM',
    autoComplete: true,
    description: '本月、月至今、近7天、明确日期区间等时间范围。',
  },
  {
    code: 'TIME_GRAIN',
    label: '时间粒度',
    conditionKind: 'DIMENSION',
    owner: 'PLATFORM',
    autoComplete: true,
    description: '按天、周、月、季度、年分组或趋势展示。',
  },
  {
    code: 'METRIC',
    label: '指标口径',
    conditionKind: 'METRIC',
    owner: 'MODEL',
    autoComplete: false,
    description: '业绩、销售额、毛利、数量等度量口径。',
  },
  {
    code: 'DIMENSION',
    label: '拆解维度',
    conditionKind: 'DIMENSION',
    owner: 'MODEL',
    autoComplete: false,
    description: '按业务类型、区域、行业、客户等字段分组或拆分。',
  },
  {
    code: 'FILTER',
    label: '过滤条件',
    conditionKind: 'FILTER',
    owner: 'MODEL',
    autoComplete: false,
    description: '只看、仅包含、排除、阈值过滤等业务条件。',
  },
  {
    code: 'SCOPE',
    label: '数据范围',
    conditionKind: 'SCOPE',
    owner: 'MODEL',
    autoComplete: false,
    description: '全国、全部、整体、不限制或排除特定范围。',
  },
  {
    code: 'RANKING',
    label: '排名与上限',
    conditionKind: 'LIMIT',
    owner: 'PLATFORM',
    autoComplete: true,
    description: '前N、TOP N、最高、最低、最大、最小。',
  },
  {
    code: 'COMPARISON',
    label: '周期对比',
    conditionKind: 'COMPARISON',
    owner: 'MODEL',
    autoComplete: false,
    description: '同比、环比、对比、相比、同期。',
  },
  {
    code: 'CALCULATION',
    label: '派生计算',
    conditionKind: 'CALCULATION',
    owner: 'MODEL',
    autoComplete: false,
    description: '占比、比率、增长率、差额、百分点变化。',
  },
  {
    code: 'ANALYSIS_STAGE',
    label: '多阶段分析',
    conditionKind: 'ANALYSIS_STAGE',
    owner: 'MODEL',
    autoComplete: false,
    description: '连续资格筛选、满足次数、派生排序、分阶段聚合与最终 TOP-N 等通用管线计算。',
  },
  {
    code: 'TREND',
    label: '趋势分析',
    conditionKind: 'RESULT_ACTION',
    owner: 'PLATFORM',
    autoComplete: true,
    description: '趋势、走势、变化曲线。',
  },
  {
    code: 'ATTRIBUTION',
    label: '归因分析',
    conditionKind: 'RESULT_ACTION',
    owner: 'PLATFORM',
    autoComplete: true,
    description: '原因、归因、为什么、驱动因素。',
  },
  {
    code: 'RESULT_ACTION',
    label: '结果输出',
    conditionKind: 'RESULT_ACTION',
    owner: 'PLATFORM',
    autoComplete: true,
    description: '排序、筛选、格式化、图表、Excel 或文件输出。',
  },
];

const CATEGORY_BY_CODE = new Map(
  ANALYSIS_CONDITION_CATEGORIES.map((category) => [category.code, category]),
);

const TEXT_RULES = [
  {
    code: 'DIMENSION',
    pattern: /按[^，,。；;]{1,24}(?:拆分|分组|统计|展示|分析)|分别|各自|分开|分组|每个[^，,。；;]{1,20}/,
  },
  {
    code: 'FILTER',
    pattern: /只看|仅看|仅包含|限定|排除|剔除|不含|不包含|不属于|属于|大于|小于|高于|低于|不低于|不超过|超过|至少|至多|等于/,
  },
  {
    code: 'SCOPE',
    pattern: /全国|全部|全量|所有|整体|不限|无限制|不添加过滤/,
  },
  {
    code: 'RANKING',
    pattern: /(?:排名前|前|top|末)\s*(?:\d+|[一二两三四五六七八九十]+)|最高|最低|最大|最小/i,
  },
  {
    code: 'COMPARISON',
    pattern: /同比|环比|对比|相比|同期|较[^，,。；;]{0,12}(?:增长|下降|上升|下滑)|vs/i,
  },
  {
    code: 'CALCULATION',
    pattern: /增长率|增速|增幅|降幅|差额|差值|占比|比例|比率|百分点|贡献率|拉动|拖累/,
  },
  {
    code: 'TREND',
    pattern: /趋势|走势|变化曲线|变化情况/,
  },
  {
    code: 'ATTRIBUTION',
    pattern: /原因|归因|为什么|为何|导致|驱动|贡献分析|原因拆解/,
  },
  {
    code: 'RESULT_ACTION',
    pattern: /排序|筛选|格式化|图表|可视化|导出|下载|生成[^，,。；;]{0,20}(?:excel|csv|报表|报告|文件)/i,
  },
];

function matchTextRule(question, rule) {
  const match = String(question ?? '').match(rule.pattern);
  return match ? match[0].trim() : '';
}

export function classifyAnalysisSemantics(question, now = new Date()) {
  const text = String(question ?? '').trim();
  const categories = [];
  const push = (code, sourceText, details = {}) => {
    const definition = CATEGORY_BY_CODE.get(code);
    if (!definition || !sourceText) {
      return;
    }
    if (categories.some((item) => item.code === code && item.sourceText === sourceText)) {
      return;
    }
    categories.push({
      ...definition,
      sourceText,
      ...details,
    });
  };

  for (const mention of extractTemporalMentions(text, now)) {
    push('TIME_WINDOW', mention.expression, {
      startDate: mention.dateInfo?.startDate ?? null,
      endDate: mention.dateInfo?.endDate ?? null,
    });
  }

  const timeGrain = extractTimeGrainExpression(text);
  if (timeGrain) {
    push('TIME_GRAIN', timeGrain.sourceText, {
      timeGrain: timeGrain.grain,
    });
  }

  for (const rule of TEXT_RULES) {
    push(rule.code, matchTextRule(text, rule));
  }

  return {
    question: text,
    categories,
  };
}

export function buildSemanticTaxonomyPrompt() {
  return ANALYSIS_CONDITION_CATEGORIES.map((category) => (
    `- ${category.label}（${category.code}，绑定到 ${category.conditionKind}，${category.owner === 'PLATFORM' ? '平台可自动补全' : '必须由模型确认'}）：${category.description}`
  )).join('\n');
}

export function categoryDefinition(code) {
  return CATEGORY_BY_CODE.get(code) ?? null;
}
