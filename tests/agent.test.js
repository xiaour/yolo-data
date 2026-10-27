import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApplication } from '../src/application.js';
import { createAgentApplication } from './fixtures/agentDataset.js';

function testConfig() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-agent-'));
  return {
    projectRoot: process.cwd(),
    port: 0,
    dbPath: path.join(directory, 'test.db'),
    deepseek: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      timeoutMs: 5_000,
      maxToolRounds: 3,
    },
  };
}

test('agent answer enforces user row policy during business dataset execution', async () => {
  const application = await createAgentApplication(testConfig());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  const answer = await application.agent.answer({
    userId: user.id,
    themeId: theme.id,
    question: '近7天华东销售额趋势',
  });

  assert.equal(answer.dataset.name, '销售经营分析');
  assert.ok(answer.data.rows.every(row => row.sales_amount < 1000));
  assert.ok(answer.data.rows.length > 0);
  assert.equal(answer.chart.type, 'line');
  assert.ok(answer.skills.some((skill) => skill.code === 'trend_analysis'));
  assert.ok(answer.processSteps.some((step) => step.skillCode === 'business_dataset_query'));
  assert.ok(answer.processSteps.at(-1).title === '生成业务回答');
  assert.equal(answer.semanticParse.status, 'VALIDATED');
  assert.equal(answer.workflow.status, 'COMPLETED');
  assert.equal(answer.workflow.progress.total, 14);
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
    (item) => item.type === 'tool_call' && item.name === 'query_business_dataset',
  );
  assert.ok(queryTrace);
  assert.ok(application.testStatements.at(-1).values.flat().includes('华东'));
  assert.match(application.testStatements.at(-1).sql, /region.*IN/);
});

test('configured model is seeded, available to initialized themes, and resolved for chat', async () => {
  const config = testConfig();
  config.deepseek = {
    baseUrl: 'https://models.example/v1',
    apiKey: 'test-secret',
    model: 'example-chat',
    temperature: 0.2,
    maxTokens: 2048,
    timeoutMs: 12_000,
    maxToolRounds: 5,
  };
  const application = await createAgentApplication(config);
  const [model] = application.database.listModels();
  assert.equal(model.modelName, 'example-chat');
  assert.equal(model.baseUrl, 'https://models.example/v1');
  assert.equal(model.apiKeyEnv, 'API_KEY');
  assert.equal(model.hasApiKey, false);

  const [theme] = application.database.listThemes();
  assert.deepEqual(theme.modelIds, [model.id]);
  assert.equal(theme.defaultModelId, model.id);
  assert.deepEqual(await application.agent.resolveThemeModel(theme), {
    provider: 'openai-compatible',
    model: 'example-chat',
    baseUrl: 'https://models.example/v1',
    apiKeyEnv: 'API_KEY',
    apiKeyEncrypted: '',
    temperature: 0.2,
    maxTokens: 2048,
    timeoutMs: 12_000,
    maxToolRounds: 5,
  });
});

test('theme permission blocks users without a query grant', async () => {
  const application = await createAgentApplication(testConfig());
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
  const application = await createAgentApplication(testConfig());
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
  const application = await createAgentApplication(testConfig());
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

  assert.equal(followUp.contextMode, 'FOLLOW_UP');
  assert.match(followUp.resolvedQuestion, /销售额/);
  const queryTrace = [...followUp.trace].reverse().find(
    (item) => item.type === 'tool_call' && item.name === 'query_business_dataset',
  );
  assert.ok(queryTrace.args.dimensions.includes('channel'));
  assert.ok(queryTrace);
  assert.ok(application.testStatements.at(-1).values.flat().includes('华东'));
  assert.match(application.testStatements.at(-1).sql, /region.*IN/);
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
  const application = await createAgentApplication(testConfig());
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
  const application = await createAgentApplication(testConfig());
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
  const application = await createAgentApplication(testConfig());
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

test('dataset query is rejected until semantic definition confirmation completes', async () => {
  const application = await createAgentApplication(testConfig());
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
          await executeTool('query_business_dataset', {
            datasetId: application.testDataset.id, metrics: [{ field: 'sales_amount', aggregator: 'SUM' }],
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
  assert.match(answer.message, /必须确认业务数据集字段口径/);
  assert.deepEqual(answer.executionResults, []);
  assert.equal(application.testStatements.length, 0);
  assert.equal(
    answer.workflow.stages.find((stage) => stage.code === 'SEMANTIC_CONFIRM').status,
    'FAILED',
  );
});

test('agent emits auditable runtime events while answering', async () => {
  const application = await createAgentApplication(testConfig());
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
  const search = events.find((event) => (
    event.type === 'tool_result' && event.step?.stageCode === 'SEMANTIC_DISCOVERY'
  ));
  assert.equal(search.step.stageCode, 'SEMANTIC_DISCOVERY');
  assert.match(search.step.title, /检索主题指标|检索业务数据集/);
  assert.equal(search.summary, search.step.detail);
  assert.ok(search.step.review.facts.length > 0);
  assert.ok(search.step.review.facts.every((fact) => typeof fact.label === 'string' && typeof fact.value === 'string'));
  assert.equal(search.step.review.details, null);
  const executed = events.find((event) => (
    event.type === 'tool_result' && event.step?.stageCode === 'EXECUTE'
  ));
  assert.equal(executed.step.stageCode, 'EXECUTE');
  assert.match(executed.step.title, /执行指标查询|执行业务数据集查询|执行查询契约/);
  assert.equal(executed.step.review.details.rowCount, answer.data.rows.length);
  assert.deepEqual(
    executed.step.review.details.columns,
    answer.data.columns.map((column) => column.name ?? column.bizName),
  );
  assert.equal(executed.step.review.details.queryFingerprint, answer.queryFingerprint);
  assert.equal(executed.step.review.code, '');
  assert.equal(executed.step.review.stdout, '');
  assert.equal(executed.step.review.stderr, '');
  assert.equal(
    events.find((event) => event.type === 'done').messageId,
    answer.messageId,
  );
});

test('local catalog health and agent execution agree without remote configuration', async () => {
  const config = testConfig();
  const application = await createApplication(config);
  try {
    await application.init();
    assert.equal(application.indicatorService.mode, 'local');
    assert.equal((await application.currentHealth()).source.mode, 'local');
    const user = application.database.getUserByUsername('east_manager');
    const theme = application.database.listThemes().find((item) => item.name === '经营总览');
    const events = [];
    const answer = await application.agent.answer({
      userId: user.id, themeId: theme.id, question: '近7天销售额趋势',
      onEvent: (event) => events.push(event),
    });
    assert.equal(answer.runtime.executionAdapter, 'local-indicator-catalog');
    assert.equal(events.find((event) => event.type === 'runtime_selected').source.mode, 'local');
    assert.ok(!events.some((event) => event.code === '本地指标目录_NOT_CONFIGURED'));
    assert.equal(application.database.getPlatformSetting('本地指标目录.enabled', null), null);
  } finally {
    await application.database.closeAsync();
    fs.rmSync(path.dirname(config.dbPath), { recursive: true, force: true });
  }
});

test('obsolete remote enablement cannot turn the local catalog into a query source', async () => {
  const config = testConfig();
  const application = await createApplication(config);
  application.database.savePlatformSetting('本地指标目录.enabled', true);
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');

  const answer = await application.agent.answer({
    userId: user.id,
    themeId: theme.id,
    question: '近7天销售额趋势',
  });
  assert.match(answer.message, /业务数据集/);
  assert.equal(answer.runtime.executionAdapter, 'local-indicator-catalog');
  assert.deepEqual(answer.executionResults, []);
  assert.equal((await application.currentHealth()).source.mode, 'local');
});

test('agent reuses identical snapshots but preserves distinct query results', async () => {
  const application = await createAgentApplication(testConfig());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  const originalQuery = application.businessDatasets.executeQuery.bind(
    application.businessDatasets,
  );
  let queryCount = 0;
  application.businessDatasets.executeQuery = async (args) => {
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
        const datasetId = application.testDataset.id;
        await executeTool('get_business_dataset_definition', { datasetId });
        const compile = async (aggregator) => {
          const contract = await executeTool('compile_query_contract', {
            sourceType: 'BUSINESS_DATASET', datasetId,
            conditions: [{ id: 'sales', sourceText: '销售额', kind: 'METRIC', status: 'RESOLVED' },
              { id: 'orders', sourceText: '订单量', kind: 'METRIC', status: 'RESOLVED' }],
            metricFields: [
              { field: 'sales_amount', sourceText: '销售额', aggregator, conditionIds: ['sales'] },
              { field: 'order_count', sourceText: '订单量', aggregator: 'SUM', conditionIds: ['orders'] },
            ],
            dimensionFields: [{ field: 'date', sourceText: '日期' }], limit: 200,
          });
          assert.equal(contract.valid, true, JSON.stringify(contract.issues));
          return { contractId: contract.contractId };
        };
        const request = await compile('SUM');
        firstResult = await executeTool('execute_query_contract', request);
        const retry = await executeTool('execute_query_contract', request);
        assert.equal(retry.queryFingerprint, firstResult.queryFingerprint);
        secondResult = await executeTool('execute_query_contract', await compile('AVG'));
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
    question: '日期 销售额 订单量',
  });

  assert.equal(queryCount, 2);
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

test('agent executes business dataset queries only through a compiled query contract', async () => {
  const application = await createAgentApplication(testConfig());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  application.agent.harnessFactory = {
    forTheme: () => ({
      mode: 'test-contract-agent',
      model: 'test-model',
      capabilities: {},
      run: async ({ executeTool }) => {
        const datasetId = application.testDataset.id;
        await executeTool('get_business_dataset_definition', { datasetId });
        const compiled = await executeTool('compile_query_contract', {
          sourceType: 'BUSINESS_DATASET', datasetId,
          conditions: [{
            id: 'metric',
            sourceText: '本月含税销售金额',
            kind: 'METRIC',
            status: 'RESOLVED',
          }],
          metricFields: [{
            field: 'sales_amount',
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
  assert.doesNotMatch(answer.message, /查询范围/);
  assert.ok(answer.processSteps.some(
    (step) => step.name === 'query_scope_summary' && /销售经营分析/.test(step.detail),
  ));
  assert.equal(answer.provenance.mode, 'DATASET_EXACT');
  assert.equal(answer.provenance.label, '数据集字段精确匹配');
  assert.ok(answer.queryFingerprint);
  assert.ok(
    answer.processSteps.some((item) => item.name === 'compile_query_contract'),
  );
  assert.ok(
    answer.processSteps.some((item) => item.name === 'execute_query_contract'),
  );
});

test('execution messages use the structured contract instead of raw session history', async () => {
  const application = await createAgentApplication(testConfig());
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
  assert.ok(independent.taskState?.taskId);
  const secondMessages = capturedMessages.at(-1);
  assert.ok(secondMessages.some(
    (message) => message.role === 'system' && /本轮执行契约/.test(message.content),
  ));
  assert.equal(secondMessages.some(
    (message) => message.role === 'user' && message.content === '查询本月含税销售金额',
  ), false);
  assert.equal(secondMessages.at(-1).content, '查询销售数量');
});

test('artifact follow-up keeps controlled dataset requery tools', async () => {
  const application = await createAgentApplication(testConfig());
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
      dataset: { id: application.testDataset.id, name: '销售经营分析' },
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
    source: { type: 'BUSINESS_DATASET', id: application.testDataset.id, name: '销售经营分析' },
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
  const application = await createAgentApplication(testConfig());
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
  const application = await createAgentApplication(testConfig());
  await application.init();
  let capturedMessages = [];
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  // 值解析只在「主题为该字段开启值域 + 值域已治理完成」时生效，这里直接种一份完成态值域。
  application.database.saveSemanticValueSnapshot({
    themeId: theme.id,
    sourceType: 'DATASET',
    sourceId: String(application.testDataset.id),
    fieldName: 'channel',
    displayName: 'channel',
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
      fields: { [`DATASET:${application.testDataset.id}:channel`]: {
        enabled: true, refreshMode: 'MANUAL', sources: ['MANUAL_VERIFIED'],
      } },
    },
  }, theme.id);
  application.agent.harnessFactory = {
    forTheme: () => ({
      mode: 'test-value-clarify',
      model: 'test-model',
      capabilities: {},
      run: async ({ executeTool, messages }) => {
        capturedMessages = messages;
        const definition = await executeTool('get_business_dataset_definition', { datasetId: application.testDataset.id });
        assert.deepEqual(definition.fields.find(field => field.name === 'channel').values,
          ['T7-ALPHA', 'T7-BETA', 'T7-GAMMA', 'Z9-UNRELATED']);
        await executeTool('compile_query_contract', {
          sourceType: 'BUSINESS_DATASET',
          datasetId: application.testDataset.id,
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
            field: 'channel',
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
      'filter-value:channel=T7-ALPHA',
      'filter-value:channel=T7-BETA',
      'filter-value:channel=T7-GAMMA',
      'cancel',
    ],
  );

  // 用户点选候选值后，平台把该选项展开成已确认的过滤条件注入下一轮提示词。
  await application.agent.answer({
    userId: user.id,
    themeId: theme.id,
    question: 'T7 最近7天销售额',
    clarificationOptionId: 'filter-value:channel=T7-BETA',
  });
  const prompt = capturedMessages.map((message) => String(message.content ?? '')).join('\n');
  assert.match(prompt, /本轮澄清选项已解析为过滤条件/);
  assert.match(prompt, /channel/);
  assert.match(prompt, /T7-BETA/);
});

test('model clarification tool renders the model question into pickable business options', async () => {
  const application = await createAgentApplication(testConfig());
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
  const application = await createAgentApplication(testConfig());
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

test('chart type follow-ups reuse the locked result and render natively', async () => {
  const application = await createAgentApplication(testConfig());
  await application.init();
  const user = application.database.getUserByUsername('east_manager');
  const theme = application.database.listThemes().find((item) => item.name === '经营总览');
  const session = application.agent.createSession({
    userId: user.id,
    themeId: theme.id,
  });

  const first = await application.agent.answer({
    userId: user.id,
    sessionId: session.id,
    themeId: theme.id,
    question: '近7天华东销售额趋势',
  });
  assert.equal(first.chart.type, 'line');
  assert.ok(first.data.rows.length > 0);

  const restyle = await application.agent.answer({
    userId: user.id,
    sessionId: session.id,
    themeId: theme.id,
    question: '换成柱状图展示',
  });
  assert.equal(restyle.chart.type, 'bar');
  assert.equal(restyle.chart.xField, first.chart.xField);
  assert.deepEqual(restyle.chart.yFields, first.chart.yFields);
  assert.deepEqual(restyle.data.rows, first.data.rows);
  assert.deepEqual(restyle.data.columns, first.data.columns);
  // 展示层复用：不重新取数、不产生新的查询产物、模型未被调用。
  assert.equal(restyle.artifactId, first.artifactId);
  assert.equal(restyle.runtime.toolCalls, 0);
  assert.equal(restyle.executionResults.length, 1);
  assert.equal(restyle.executionResults[0].kind, 'chart_restyle');
  assert.ok(restyle.processSteps.some((step) => step.skillCode === 'chart_restyle'));
  assert.ok(!/!\[.*\]\(.*\.(png|svg)\)/.test(restyle.message));
});
