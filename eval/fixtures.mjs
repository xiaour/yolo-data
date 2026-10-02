// Shared fixtures for the semantic eval set. L1 is contract-level and needs no
// model or datasource, so it can run in CI on every PR.
import { QueryContractCompiler } from '../src/queryContractCompiler.js';

export const EVAL_NOW = '2026-09-22T03:00:00Z';

export const EVAL_INDICATOR = {
  id: 'sales',
  name: '含税销售金额',
  businessCaliber: '重点客户组子板块=企业客户+零售客户+大客户',
  metrics: [
    { metricBizName: 'sale_amt', metricName: '含税销售金额' },
  ],
  dimensions: [
    { dimensionBizName: 'sdt', dimensionName: '销售日期' },
    { dimensionBizName: 'business_type_name', dimensionName: 'segment_name' },
    { dimensionBizName: 'customer_name', dimensionName: 'customer_name' },
    { dimensionBizName: 'customer_code', dimensionName: 'customer_code' },
  ],
};

const THEME = {
  systemPrompt: [
    '重点客户组子板块=企业客户+零售客户+大客户',
    '用户说“全国 / 整体 / 全国整体”时表示全量整体口径，不添加过滤。',
  ].join('\n'),
};

export function compileEvalCase(evalCase) {
  const compiler = new QueryContractCompiler();
  return compiler.compile({
    question: evalCase.question,
    sourceType: evalCase.sourceType ?? 'INDICATOR',
    indicator: EVAL_INDICATOR,
    availableMetrics: EVAL_INDICATOR.metrics,
    availableDimensions: EVAL_INDICATOR.dimensions,
    theme: THEME,
    draft: evalCase.draft,
    now: new Date(evalCase.now ?? EVAL_NOW),
  });
}
