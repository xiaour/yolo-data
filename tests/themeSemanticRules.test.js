import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isPromptSemanticRule,
  mergeThemeSemanticPolicy,
  parseFormula,
  parseSemanticBlock,
} from '../src/themeSemanticRules.js';

const PROMPT = `业务口径：
\`\`\`semantics
指标: 毛利额, 毛利 = 含税销售额 - 含税成本额
指标: 客户数 = 客户编码:COUNT_DISTINCT
指标: 占比 = 含税销售额 / (含税销售额 + 未税销售额)
维度: 大区, 区域 -> 销售大区名称
过滤: 日配业务 -> 业务类型名称 = 日配业务
过滤: 双业务 -> 业务类型名称 = 日配业务, 福利业务
枚举组: 大福利 -> 业务类型名称 = 福利业务, 福利小店, BBC
# 注释会被忽略
\`\`\`
`;

test('prompt semantics block compiles into a semantic policy', () => {
  const { policy, issues } = parseSemanticBlock(PROMPT);
  assert.deepEqual(issues, []);
  assert.equal(policy.metrics.length, 3);
  assert.deepEqual(policy.metrics[0].aliases, ['毛利额', '毛利']);
  assert.equal(policy.metrics[0].target.type, 'FORMULA');
  assert.deepEqual(policy.metrics[0].target.expression, {
    op: 'SUBTRACT',
    left: { op: 'FIELD', field: '含税销售额', aggregator: 'SUM' },
    right: { op: 'FIELD', field: '含税成本额', aggregator: 'SUM' },
  });
  // 单字段写法带聚合方式，除法公式按优先级生成算术树。
  assert.deepEqual(policy.metrics[1].target, {
    type: 'FIELD',
    field: '客户编码',
    aggregator: 'COUNT_DISTINCT',
  });
  assert.equal(policy.metrics[2].target.expression.op, 'DIVIDE');
  assert.equal(policy.metrics[2].target.expression.right.op, 'ADD');

  assert.deepEqual(policy.dimensions[0].aliases, ['大区', '区域']);
  assert.equal(policy.dimensions[0].field, '销售大区名称');
  assert.equal(policy.filters[0].operator, 'EQ');
  assert.deepEqual(policy.filters[1].value, ['日配业务', '福利业务']);
  assert.equal(policy.filters[1].operator, 'IN');
  assert.deepEqual(policy.enumGroups[0].values, ['福利业务', '福利小店', 'BBC']);
  assert.ok(policy.metrics.every((rule) => isPromptSemanticRule(rule)));
});

test('prompt semantics rules win over stored rules with the same concept', () => {
  const merged = mergeThemeSemanticPolicy(PROMPT, {
    metrics: [
      { concept: '毛利额', aliases: ['旧毛利额'], target: { type: 'FIELD', field: 'stale_field' } },
      { concept: '保留指标', aliases: ['保留'], target: { type: 'FIELD', field: 'keep_field' } },
    ],
  });
  const 毛利额 = merged.metrics.find((rule) => rule.concept === '毛利额');
  assert.equal(毛利额.target.type, 'FORMULA');
  assert.equal(毛利额.priority, 100);
  assert.ok(merged.metrics.some((rule) => rule.concept === '保留指标'));
});

test('malformed lines are reported instead of silently dropped', () => {
  const { policy, issues } = parseSemanticBlock([
    '```semantics',
    '指标: 毛利额 含税销售额',
    '维度: 大区',
    '过滤: 日配业务 -> 业务类型名称',
    '未知类型: 随便写',
    '```',
  ].join('\n'));
  assert.equal(policy, null);
  assert.equal(issues.length, 4);
  assert.match(issues[0], /缺少 "="/);
  assert.match(issues[3], /无法识别的规则行/);
});

test('a prompt without the block keeps the stored policy', () => {
  const stored = { metrics: [{ concept: '旧', aliases: ['旧'], target: { type: 'FIELD', field: 'f' } }] };
  const merged = mergeThemeSemanticPolicy('没有声明块的提示词', stored);
  assert.equal(merged, stored);
  assert.equal(merged.metrics.length, 1);
  assert.deepEqual(mergeThemeSemanticPolicy('没有声明块', {}), {});
});

test('parseFormula rejects unknown aggregators', () => {
  assert.throws(() => parseFormula('字段:SUMX'), /不支持的聚合方式/);
});
