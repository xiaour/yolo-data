import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSystemPrompt } from '../src/agent.js';

test('attribution system prompt renders the analysis result file contract', () => {
  const prompt = buildSystemPrompt({
    user: { displayName: 'Tester', username: 'tester' },
    theme: {
      name: 'Test theme',
      systemPrompt: '',
      description: '',
      examples: [],
      semanticPolicy: {},
    },
    scope: { rowPolicies: [] },
    indicators: [],
    skills: [],
    analysisMode: { mode: 'ATTRIBUTION' },
    clarificationPolicy: { allowed: false },
    taskState: null,
    question: '分析变化原因',
  });

  assert.match(prompt, /output\/analysis\.json/);
  assert.doesNotMatch(prompt, /undefined/);
});

test('session directives are injected into the execution prompt', () => {
  const prompt = buildSystemPrompt({
    user: { displayName: 'Tester', username: 'tester' },
    theme: {
      name: 'Test theme',
      systemPrompt: '',
      description: '',
      examples: [],
      semanticPolicy: {},
    },
    scope: { rowPolicies: [] },
    indicators: [],
    skills: [],
    analysisMode: { mode: 'METRIC_QUERY' },
    clarificationPolicy: { allowed: true },
    taskState: null,
    question: '查询本月销售额',
    conversationDirectives: [{
      kind: 'DISPLAY_UNIT',
      unit: '万元',
      displayScale: 0.0001,
    }],
  });

  assert.match(prompt, /会话级输出指令/);
  assert.match(prompt, /本会话金额默认按万元展示/);
});

test('dataset semantic confirmation does not block unfiltered metric aggregation', () => {
  const prompt = buildSystemPrompt({
    user: { displayName: 'Tester', username: 'tester' },
    theme: {
      name: 'Test theme',
      systemPrompt: '',
      description: '',
      examples: [],
      semanticPolicy: {},
    },
    scope: { rowPolicies: [] },
    indicators: [],
    skills: [],
    analysisMode: { mode: 'METRIC_QUERY' },
    clarificationPolicy: { allowed: true },
    taskState: null,
    question: '上个月的销售额是多少',
  });

  assert.match(prompt, /数值指标的默认值域\/枚举与无筛选的汇总查询无关/);
  assert.match(prompt, /“上个月\/上月”表示上一完整自然月/);
  assert.match(prompt, /本地指标已确认后，若所选数据集存在同名\/同义的 METRIC 字段/);
});

test('analysis report prompt requires code execution after the evidence snapshot', () => {
  const prompt = buildSystemPrompt({
    user: { displayName: 'Tester', username: 'tester' },
    theme: {
      name: 'Test theme', systemPrompt: '', description: '', examples: [], semanticPolicy: {},
    },
    scope: { rowPolicies: [] },
    indicators: [],
    skills: [],
    analysisMode: { mode: 'METRIC_QUERY' },
    analysisRequest: {
      taskKind: 'ANALYSIS',
      purposes: ['COMPARE', 'DIAGNOSE', 'OPPORTUNITY'],
      requiresReport: true,
      stages: ['VALIDATE_SCOPE', 'LOCK_EVIDENCE', 'PERIOD_COMPARISON', 'REPORT'],
    },
    clarificationPolicy: { allowed: true },
    taskState: null,
    question: '与去年同期对比，哪些客户下降比较多？有什么机会点',
  });
  assert.match(prompt, /本轮任务类型：ANALYSIS/);
  assert.match(prompt, /查询只负责形成可复现的证据快照，不是本轮终点/);
  assert.match(prompt, /execute_analysis_code/);
  assert.match(prompt, /HYPOTHESIS/);
});
