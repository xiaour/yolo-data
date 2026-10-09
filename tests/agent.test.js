import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApplication } from '../src/application.js';
import { FakeIndicatorClient } from './fixtures/fakeIndicatorClient.js';

function testConfig() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-agent-'));
  return {
    projectRoot: process.cwd(),
    port: 0,
    dbPath: path.join(directory, 'test.db'),
    supersonic: {
      baseUrl: '',
      token: '',
      timeoutMs: 5_000,
    },
    deepseek: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      timeoutMs: 5_000,
      maxToolRounds: 3,
    },
  };
}

test('agent answer enforces user row policy during indicator execution', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  const answer = await application.agent.answer({
    userId: user.id,
    themeId: theme.id,
    question: '近7天华东销售额趋势',
  });

  assert.equal(answer.indicator.name, '销售额');
  assert.ok(answer.data.rows.length > 0);
  assert.equal(answer.chart.type, 'line');
  assert.ok(answer.skills.some((skill) => skill.code === 'trend_analysis'));
  assert.ok(answer.processSteps.some((step) => step.skillCode === 'indicator_query'));
  assert.ok(answer.processSteps.at(-1).title === '生成业务回答');
  assert.equal(answer.semanticParse.status, 'VALIDATED');
  assert.equal(answer.workflow.status, 'COMPLETED');
  assert.equal(answer.workflow.progress.total, 12);
  for (const stage of answer.workflow.stages.filter((item) => item.status === 'SUCCESS')) {
    assert.ok(stage.startedAt);
    assert.ok(stage.finishedAt);
    assert.equal(typeof stage.durationMs, 'number');
  }
  assert.equal(
    answer.workflow.stages.find((stage) => stage.code === 'SEMANTIC_CONFIRM').status,
    'SUCCESS',
  );
  assert.ok(answer.semanticParse.planId);
  assert.ok(application.database.getQueryPlan(answer.semanticParse.planId, user.id));
  assert.ok(application.database.listLlmLogs(10).length >= 1);
  const queryTrace = answer.trace.find(
    (item) => item.type === 'tool_call' && item.name === 'query_indicator',
  );
  assert.deepEqual(queryTrace.args.filters, [
    { bizName: 'region', operator: 'IN', value: ['华东'] },
  ]);
});

test('theme permission blocks users without a query grant', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  await application.init();
  const user = application.database.getUserByUsername('channel_analyst');
  const theme = application.database.listThemes().find((item) => item.name === '履约运营');
  await assert.rejects(
    application.agent.answer({
      userId: user.id,
      themeId: theme.id,
      question: '近7天履约及时率',
    }),
    /no query grant/,
  );
});

test('chat session model is locked after the first conversation message', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  const firstModel = application.database.saveModel({
    name: '测试模型 A',
    provider: 'deepseek',
    modelName: 'model-a',
    isDefault: true,
  });
  const secondModel = application.database.saveModel({
    name: '测试模型 B',
    provider: 'deepseek',
    modelName: 'model-b',
  });
  application.database.saveTheme({
    ...theme,
    modelIds: [firstModel.id, secondModel.id],
    defaultModelId: firstModel.id,
  }, theme.id);
  const session = application.agent.createSession({
    userId: user.id,
    themeId: theme.id,
    modelId: firstModel.id,
  });
  application.database.appendChatMessage({
    sessionId: session.id,
    userId: user.id,
    role: 'user',
    content: '已经开始的会话',
  });

  await assert.rejects(
    application.agent.answer({
      userId: user.id,
      sessionId: session.id,
      themeId: theme.id,
      modelId: secondModel.id,
      question: '近7天销售额',
    }),
    /模型已锁定/,
  );
});

test('multi-turn questions reuse session memory and inherit prior context', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  const session = application.agent.createSession({
    userId: user.id,
    themeId: theme.id,
  });

  await application.agent.answer({
    userId: user.id,
    sessionId: session.id,
    themeId: theme.id,
    question: '近7天华东销售额趋势',
  });
  const followUp = await application.agent.answer({
    userId: user.id,
    sessionId: session.id,
    themeId: theme.id,
    question: '那按渠道拆开呢',
  });

  const queryTrace = [...followUp.trace].reverse().find(
    (item) => item.type === 'tool_call' && item.name === 'query_indicator',
  );
  assert.ok(queryTrace.args.dimensions.includes('channel'));
  assert.deepEqual(queryTrace.args.filters, [
    { bizName: 'region', operator: 'IN', value: ['华东'] },
  ]);
  const messages = application.agent.listMessages(session.id, user.id);
  assert.deepEqual(messages.map((message) => message.role), [
    'user',
    'assistant',
    'user',
    'assistant',
  ]);
  assert.ok(messages[1].result.processSteps.length >= 4);
  assert.equal(messages[1].result.processSteps.at(-1).title, '生成业务回答');
});

test('chat sessions are isolated per user and prompt changes are agent-scoped', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  await application.init();
  const owner = application.database.getUserByUsername('east_manager');
  const otherUser = application.database.getUserByUsername('channel_analyst');
  const themes = application.database.listThemes();
  const overview = themes.find((item) => item.name === '经营总览');
  const finance = themes.find((item) => item.name === '财务分析');
  const session = application.agent.createSession({
    userId: owner.id,
    themeId: overview.id,
  });

  assert.throws(
    () => application.agent.listMessages(session.id, otherUser.id),
    /chat session not found/,
  );

  const originalFinancePrompt = finance.systemPrompt;
  const updated = application.database.updateThemePrompt(
    overview.id,
    '经营总览独立提示词',
  );
  assert.equal(updated.systemPrompt, '经营总览独立提示词');
  assert.equal(
    application.database.getTheme(finance.id).systemPrompt,
    originalFinancePrompt,
  );
});

test('revoked theme permission also hides its stored session memory', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  const session = application.agent.createSession({
    userId: user.id,
    themeId: theme.id,
  });
  const profile = application.database.getPermissionProfile(user.id);
  application.database.replacePermissionProfile(user.id, {
    ...profile,
    themeGrants: profile.themeGrants.map((grant) => (
      Number(grant.themeId) === Number(theme.id)
        ? { ...grant, canQuery: false }
        : grant
    )),
  });

  assert.equal(application.agent.listSessions(user.id).length, 0);
  assert.throws(
    () => application.agent.listMessages(session.id, user.id),
    /no query grant/,
  );
});

test('theme configuration is persisted without storing the indicator catalog', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  const updated = application.database.saveTheme({
    ...theme,
    datasetIds: ['not-existing-dataset'],
  }, theme.id);
  const context = application.agent.resolveContext(user.id, updated.id);
  assert.equal(context.theme.datasetIds[0], 'not-existing-dataset');
  assert.equal(context.allIndicators, undefined);
  assert.equal(application.database.countRows('indicator_cache'), 0);
});

test('indicator query is rejected until semantic definition confirmation completes', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  application.agent.harnessFactory = {
    forTheme: () => ({
      mode: 'test-gate',
      model: 'test-model',
      capabilities: {},
      run: async ({ executeTool }) => {
        try {
          await executeTool('query_indicator', {
            indicatorId: 'sales_amount',
            metricNames: ['sales_amount'],
          });
          return { content: 'unexpected success', trace: [] };
        } catch (error) {
          return { content: error.message, trace: [] };
        }
      },
    }),
  };
  const answer = await application.agent.answer({
    userId: user.id,
    themeId: theme.id,
    question: '直接查询销售额',
  });
  assert.match(answer.message, /必须完成指标搜索/);
  assert.equal(answer.workflow.status, 'FAILED');
  assert.equal(
    answer.workflow.stages.find((stage) => stage.code === 'SEMANTIC_DISCOVERY').status,
    'FAILED',
  );
});

test('agent emits auditable runtime events while answering', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  const events = [];
  const answer = await application.agent.answer({
    userId: user.id,
    themeId: theme.id,
    question: '近7天华东销售额趋势',
    onEvent: (event) => events.push(event),
  });

  const types = events.map((event) => event.type);
  assert.ok(types.includes('run_started'));
  assert.ok(types.includes('runtime_selected'));
  assert.ok(types.includes('workflow_stage'));
  assert.ok(types.includes('process_step'));
  assert.ok(types.includes('tool_call'));
  assert.ok(types.includes('tool_result'));
  assert.ok(types.includes('result'));
  assert.ok(types.includes('done'));
  assert.ok(types.includes('warning'));
  assert.equal(
    events.find((event) => event.type === 'done').messageId,
    answer.messageId,
  );
});

test('production runtime requires a configured Supersonic indicator source', async () => {
  const config = testConfig();
  const application = await createApplication(config);
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');

  const answer = await application.agent.answer({
    userId: user.id,
    themeId: theme.id,
    question: '近7天销售额趋势',
  });
  assert.match(answer.message, /指标平台尚未配置/);
  assert.equal(answer.runtime.executionAdapter, 'unconfigured-indicator');
  assert.equal(application.currentHealth().source.mode, 'unconfigured');
});

test('agent reuses identical snapshots but preserves distinct query results', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  const originalQuery = application.indicatorClient.queryIndicator.bind(
    application.indicatorClient,
  );
  let queryCount = 0;
  application.indicatorClient.queryIndicator = async (args) => {
    queryCount += 1;
    return originalQuery(args);
  };
  let firstResult = null;
  let secondResult = null;
  application.agent.harnessFactory = {
    forTheme: () => ({
      mode: 'test-agent',
      model: 'test-model',
      provider: 'test-provider',
      capabilities: {},
      chat: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              fields: {
                sales_amount: {
                  type: 'amount',
                  unit: '万元',
                  displayScale: 0.0001,
                  xlsxScale: 0.0001,
                  decimals: 0,
                  basis: 'THEME_PROMPT',
                },
                order_count: {
                  type: 'quantity',
                  unit: '万元',
                  displayScale: 0.0001,
                  xlsxScale: 0.0001,
                  decimals: 0,
                  basis: 'THEME_PROMPT',
                },
              },
            }),
          },
        }],
      }),
      run: async ({ executeTool }) => {
        const search = await executeTool('search_indicators', {
          keyword: '近7天华东销售额趋势',
          limit: 8,
        });
        const indicatorId = 'sales_amount';
        await executeTool('get_indicator', { indicatorId });
        firstResult = await executeTool('query_indicator', {
          indicatorId,
          dimensions: ['date'],
          filters: [{ bizName: 'region', operator: 'IN', value: ['华东'] }],
          limit: 200,
        });
        const retry = await executeTool('query_indicator', {
          indicatorId,
          dimensions: ['date'],
          filters: [{ bizName: 'region', operator: 'IN', value: ['华东'] }],
          limit: 200,
        });
        assert.equal(retry.queryFingerprint, firstResult.queryFingerprint);
        const secondIndicatorId = 'order_count';
        await executeTool('get_indicator', { indicatorId: secondIndicatorId });
        secondResult = await executeTool('query_indicator', {
          indicatorId: secondIndicatorId,
          dimensions: ['date'],
          filters: [{ bizName: 'region', operator: 'IN', value: ['华东'] }],
          limit: 200,
        });
        assert.notEqual(secondResult.queryFingerprint, firstResult.queryFingerprint);
        return {
          content: '模型自由生成的、可能不稳定的回答',
          trace: [],
        };
      },
    }),
  };

  const answer = await application.agent.answer({
    userId: user.id,
    themeId: theme.id,
    question: '近7天华东销售额趋势',
  });

  assert.equal(queryCount, 4);
  assert.equal(answer.deterministic, true);
  assert.match(answer.message, /销售额（万元）合计|订单量（万元）合计/);
  assert.equal(answer.dataHash, secondResult.dataHash);
  assert.equal(answer.queryFingerprint, secondResult.queryFingerprint);
  assert.equal(answer.semanticParse.presentation.meta.generatedByModel, true);
  assert.ok(answer.processSteps.some(
    (step) => step.name === 'compile_presentation_contract',
  ));
  assert.equal(answer.executionResults.length, 2);
  assert.equal(answer.executionResults[0].dataHash, firstResult.dataHash);
  assert.equal(answer.executionResults[1].dataHash, secondResult.dataHash);
  assert.ok(answer.processSteps.some((step) => step.type === 'reuse'));
  assert.ok(answer.executionResults.every((item) => item.artifactId));
});

test('agent executes indicator queries only through a compiled query contract', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  application.agent.harnessFactory = {
    forTheme: () => ({
      mode: 'test-contract-agent',
      model: 'test-model',
      capabilities: {},
      run: async ({ executeTool }) => {
        const search = await executeTool('search_indicators', {
          keyword: '本月含税销售金额',
          limit: 8,
        });
        const indicatorId = 'sales_amount';
        const detail = await executeTool('get_indicator', { indicatorId });
        const metric = detail.metrics[0];
        const compiled = await executeTool('compile_query_contract', {
          sourceType: 'INDICATOR',
          indicatorId,
          conditions: [{
            id: 'metric',
            sourceText: '本月含税销售金额',
            kind: 'METRIC',
            status: 'RESOLVED',
          }],
          metricFields: [{
            field: metric.bizName,
            sourceText: '含税销售金额',
            aggregator: 'SUM',
            conditionIds: ['metric'],
          }],
          dimensionFields: [],
          filterFields: [],
          timeWindows: [{
            sourceText: '本月',
            dateMode: 'BETWEEN',
            conditionIds: ['metric'],
          }],
          limit: 200,
        });
        assert.equal(
          compiled.valid,
          true,
          (compiled.issues ?? []).map((issue) => issue.message).join('\n'),
        );
        const result = await executeTool('execute_query_contract', {
          contractId: compiled.contractId,
        });
        assert.ok(result.rowCount > 0);
        return {
          content: result.summary,
          trace: [],
        };
      },
    }),
  };

  const answer = await application.agent.answer({
    userId: user.id,
    themeId: theme.id,
    question: '本月含税销售金额',
  });

  assert.equal(answer.deterministic, true);
  assert.match(answer.message, /查询范围/);
  assert.equal(answer.provenance.mode, 'INDICATOR_LIBRARY');
  assert.equal(answer.provenance.label, '指标库口径');
  assert.ok(answer.queryFingerprint);
  assert.ok(
    answer.processSteps.some((item) => item.name === 'compile_query_contract'),
  );
  assert.ok(
    answer.processSteps.some((item) => item.name === 'execute_query_contract'),
  );
});

test('independent questions keep session history without inheriting query context', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  const session = application.agent.createSession({
    userId: user.id,
    themeId: theme.id,
  });
  const capturedMessages = [];
  application.agent.harnessFactory = {
    forTheme: () => ({
      mode: 'test-context-agent',
      model: 'test-model',
      capabilities: {},
      run: async ({ messages }) => {
        capturedMessages.push(messages);
        return {
          content: '本轮已记录',
          trace: [],
        };
      },
    }),
  };

  await application.agent.answer({
    userId: user.id,
    sessionId: session.id,
    themeId: theme.id,
    question: '查询本月含税销售金额',
  });
  const independent = await application.agent.answer({
    userId: user.id,
    sessionId: session.id,
    themeId: theme.id,
    question: '查询销售数量',
  });

  assert.equal(independent.contextMode, 'INDEPENDENT');
  assert.equal(independent.inheritQueryContext, false);
  assert.equal(independent.resolvedQuestion, '查询销售数量');
  const secondMessages = capturedMessages.at(-1);
  assert.ok(secondMessages.some(
    (message) => message.role === 'user' && message.content === '查询本月含税销售金额',
  ));
  assert.equal(secondMessages.at(-1).content, '查询销售数量');
});

test('artifact follow-up keeps controlled dataset requery tools', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  const session = application.agent.createSession({
    userId: user.id,
    themeId: theme.id,
    title: '产物追问测试',
  });
  const workspace = application.workspace.ensureForSession({
    userId: user.id,
    themeId: theme.id,
    sessionId: session.id,
    name: '产物追问测试',
  });
  const artifact = application.workspace.createResultArtifact({
    workspaceId: workspace.id,
    userId: user.id,
    sessionId: session.id,
    messageId: null,
    conversationId: null,
    answer: {
      question: '本月销售额',
      resolvedQuestion: '本月销售额',
      indicator: { id: '2', name: '销售额' },
      data: {
        columns: [
          { name: '大区', bizName: 'region', showType: 'CATEGORY' },
          { name: '销售额', bizName: 'sale_amt', showType: 'NUMBER' },
        ],
        rows: [{ region: '华东', sale_amt: 30 }],
      },
      chart: { type: 'bar' },
      queryFingerprint: 'snapshot-fingerprint',
      dataHash: 'snapshot-hash',
    },
    artifactType: 'QUERY_RESULT',
    source: { type: 'INDICATOR', id: '2', name: '销售额' },
  });
  application.memory.appendUserMessage(session.id, user.id, '本月销售额是多少');
  application.memory.appendAssistantMessage(session.id, user.id, '本月销售额为 30', {
    data: { columns: [], rows: [] },
  });

  let capturedTools = [];
  application.agent.harnessFactory = {
    forTheme: () => ({
      mode: 'test-agent',
      model: 'test-model',
      capabilities: {},
      run: async ({ tools }) => {
        capturedTools = tools.map((tool) => tool.function.name);
        return { content: '已基于工作区快照继续处理。', trace: [] };
      },
    }),
  };
  const answer = await application.agent.answer({
    userId: user.id,
    themeId: theme.id,
    sessionId: session.id,
    question: '把结果转换成 Excel',
  });

  assert.equal(answer.contextMode, 'FOLLOW_UP');
  assert.equal(answer.contextReason, 'result_operation');
  assert.equal(capturedTools.includes('execute_analysis_code'), true);
  assert.equal(capturedTools.includes('transform_workspace_artifact'), true);
  assert.equal(capturedTools.includes('search_indicators'), false);
  assert.equal(capturedTools.includes('query_indicator'), false);
  assert.equal(capturedTools.includes('compile_query_contract'), true);
  assert.equal(capturedTools.includes('execute_query_contract'), true);
  const stored = application.database.getWorkspaceArtifact(artifact.id, user.id);
  assert.deepEqual(stored.metadata.capabilities.metrics, ['sale_amt']);
  assert.deepEqual(stored.metadata.capabilities.dimensions, ['region']);
});

test('agent returns structured clarification options with a recommended path', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  application.agent.harnessFactory = {
    forTheme: () => ({
      mode: 'test-agent',
      model: 'test-model',
      capabilities: {},
      run: async () => ({
        content: '请确认统计口径和时间范围。',
        trace: [],
      }),
    }),
  };

  const answer = await application.agent.answer({
    userId: user.id,
    themeId: theme.id,
    question: '看一下业务表现',
  });

  assert.equal(answer.clarification.type, 'NEEDS_CONFIRMATION');
  assert.equal(answer.clarification.recommendedOptionId, 'use-recommended');
  assert.deepEqual(
    answer.clarification.options.map((option) => option.id),
    ['use-recommended', 'cancel'],
  );
});

test('ambiguous filter value is asked as a value choice instead of a caliber questionnaire', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  await application.init();
  let capturedMessages = [];
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  // 值解析只在「主题为该字段开启值域 + 值域已治理完成」时生效，这里直接种一份完成态值域。
  application.database.saveSemanticValueSnapshot({
    themeId: theme.id,
    sourceType: 'INDICATOR',
    sourceId: 'sales_amount',
    fieldName: 'region',
    displayName: 'region',
    status: 'COMPLETE',
    origins: ['MANUAL_VERIFIED'],
    items: ['T7-ALPHA', 'T7-BETA', 'T7-GAMMA', 'Z9-UNRELATED'].map((value) => ({
      value,
      aliases: [],
      origin: 'MANUAL_VERIFIED',
      originRef: 'test',
      confidence: 1,
      firstSeenAt: new Date().toISOString(),
    })),
    sampleSize: 4,
  });
  application.database.saveTheme({
    ...theme,
    semanticValueConfig: {
      enabled: true,
      autoDiscover: true,
      fields: { 'INDICATOR:sales_amount:region': { enabled: true, refreshMode: 'MANUAL' } },
    },
  }, theme.id);
  application.agent.harnessFactory = {
    forTheme: () => ({
      mode: 'test-value-clarify',
      model: 'test-model',
      capabilities: {},
      run: async ({ executeTool, messages }) => {
        capturedMessages = messages;
        await executeTool('get_indicator', { indicatorId: 'sales_amount' });
        await executeTool('compile_query_contract', {
          sourceType: 'INDICATOR',
          indicatorId: 'sales_amount',
          conditions: [
            { id: 'metric', sourceText: '销售额', kind: 'METRIC', status: 'RESOLVED' },
            { id: 'filter', sourceText: 'T7', kind: 'FILTER', status: 'RESOLVED' },
          ],
          metricFields: [{
            field: 'sales_amount',
            sourceText: '销售额',
            conditionIds: ['metric'],
          }],
          filterFields: [{
            field: 'region',
            operator: '=',
            value: 'T7',
            sourceText: 'T7',
            conditionIds: ['filter'],
          }],
        });
        // 模型想把同一处歧义展开成一串口径反问；平台必须用「选哪个值」覆盖它。
        return { content: '请确认以下口径：时间范围、数据版本、分组方式和计算方式。', trace: [] };
      },
    }),
  };

  const answer = await application.agent.answer({
    userId: user.id,
    themeId: theme.id,
    question: 'T7 最近7天销售额',
  });

  assert.doesNotMatch(answer.message, /请确认以下口径/);
  assert.match(answer.message, /T7-ALPHA/);
  // 与请求词无关的枚举不得出现在候选里。
  assert.doesNotMatch(answer.message, /Z9-UNRELATED/);
  assert.equal(answer.clarification.type, 'NEEDS_CONFIRMATION');
  assert.deepEqual(
    answer.clarification.options.map((option) => option.id),
    [
      'filter-value:region=T7-ALPHA',
      'filter-value:region=T7-BETA',
      'filter-value:region=T7-GAMMA',
      'cancel',
    ],
  );

  // 用户点选候选值后，平台把该选项展开成已确认的过滤条件注入下一轮提示词。
  await application.agent.answer({
    userId: user.id,
    themeId: theme.id,
    question: 'T7 最近7天销售额',
    clarificationOptionId: 'filter-value:region=T7-BETA',
  });
  const prompt = capturedMessages.map((message) => String(message.content ?? '')).join('\n');
  assert.match(prompt, /本轮澄清选项已解析为过滤条件/);
  assert.match(prompt, /region/);
  assert.match(prompt, /T7-BETA/);
});

test('model clarification tool renders the model question into pickable business options', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  let toolResult = null;
  let offeredTools = [];
  application.agent.harnessFactory = {
    forTheme: () => ({
      mode: 'test-model-clarify',
      model: 'test-model',
      capabilities: {},
      run: async ({ executeTool, tools }) => {
        offeredTools = (tools ?? []).map((tool) => tool.function?.name ?? tool.name);
        toolResult = await executeTool('request_clarification', {
          question: '你说的「T7」是指哪一个？',
          options: [
            { label: 'T7-A', field: 'region', value: 'T7-ALPHA' },
            { label: '整个 T7 合并看' },
          ],
        });
        // 模型即便仍在正文里写内部术语，也会被平台的结构化澄清覆盖。
        return { content: '唯一阻塞项：口径来源约束与映射方式。', trace: [] };
      },
    }),
  };

  const answer = await application.agent.answer({
    userId: user.id,
    themeId: theme.id,
    question: 'T7 最近7天销售额',
  });

  assert.equal(offeredTools.includes('request_clarification'), true);
  assert.equal(toolResult?.accepted, true);
  assert.equal(answer.message, '你说的「T7」是指哪一个？');
  assert.doesNotMatch(answer.message, /阻塞项|口径来源|映射方式/);
  assert.equal(answer.clarification.type, 'NEEDS_CONFIRMATION');
  assert.deepEqual(
    answer.clarification.options.map((option) => option.id),
    ['filter-value:region=T7-ALPHA', 'choice:整个 T7 合并看', 'cancel'],
  );
});

test('agent wires the long-term memory tool into the tool loop', async () => {
  const application = await createApplication(testConfig(), new FakeIndicatorClient());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  const document = application.userMemories.ensureDocument(user.id, theme.id);
  application.userMemories.saveConsolidated(document.id, {
    summary: '默认按含税口径看销售额',
    content: '## 口径偏好\n- 默认按含税口径看销售额',
  });

  let capturedTools = [];
  let memoryLookup = null;
  application.agent.harnessFactory = {
    forTheme: () => ({
      mode: 'test-memory-agent',
      model: 'test-model',
      capabilities: {},
      run: async ({ tools, executeTool }) => {
        capturedTools = tools.map((tool) => tool.function?.name ?? tool.name);
        memoryLookup = await executeTool('search_user_memory', { query: '含税' })
          .catch((error) => ({ error: error.message }));
        return { content: '已按你的历史偏好核对口径。', trace: [] };
      },
    }),
  };

  await application.agent.answer({
    userId: user.id,
    themeId: theme.id,
    question: '近7天华东销售额趋势',
  });

  assert.equal(capturedTools.includes('search_user_memory'), true);
  assert.equal(memoryLookup?.available, true);
  assert.equal(memoryLookup.results.length, 1);
  assert.match(memoryLookup.results[0].excerpt, /含税口径/);
});
