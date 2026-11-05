import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyResultPresentation,
  buildPresentationEvidence,
  formatPresentationCell,
  presentationValueForColumn,
  PresentationPlanner,
} from '../src/resultPresentation.js';
import {
  applyConversationDirectivesToPresentationContract,
  parseConversationDirective,
} from '../src/conversationDirectives.js';
import { responsesText } from './fixtures/responsesApi.js';

test('presentation evidence preserves raw data and only carries online evidence', () => {
  const columns = [
    {
      name: '销售额',
      bizName: 'sale_amt',
      showType: 'NUMBER',
      type: 'DECIMAL',
      dataFormatType: 'decimal',
      dataFormat: { decimalPlaces: 1 },
    },
  ];
  const rows = [{ sale_amt: 470_000 }];
  const evidence = buildPresentationEvidence({
    columns,
    resultList: rows,
    formattedResultList: [{ sale_amt: '47.0万' }],
    formatTemplates: {
      sale_amt: {
        type: 'amount',
        unit: '万元',
        displayScale: 0.0001,
        xlsxScale: 0.0001,
        decimals: 1,
      },
    },
  });

  assert.equal(evidence.columns, columns);
  assert.equal(evidence.rows, rows);
  assert.deepEqual(evidence.onlineFormattedRows, [{ sale_amt: '47.0万' }]);
  assert.equal(evidence.onlineTemplates.sale_amt.unit, '万元');
  assert.equal('formattedRows' in evidence, false);
  assert.equal(evidence.rows[0].sale_amt, 470_000);
});

test('presentation planner always asks the model and validates the returned contract', async () => {
  let capturedMessages = null;
  let capturedTools = null;
  let capturedMetadata = null;
  const harness = {
    provider: 'deepseek',
    model: 'deepseek-chat',
    async chat(messages, tools, metadata) {
      capturedMessages = messages;
      capturedTools = tools;
      capturedMetadata = metadata;
      return responsesText(JSON.stringify({
              fields: {
                sale_amt: {
                  type: 'amount',
                  unit: '万元',
                  displayScale: 0.0001,
                  xlsxScale: 0.0001,
                  decimals: 1,
                  prefix: '',
                  suffix: '',
                  basis: 'ONLINE_METADATA',
                  formatted: '47.0万',
                },
                unknown_field: {
                  type: 'amount',
                  unit: '元',
                  displayScale: 1,
                  xlsxScale: 1,
                },
                invalid_amount: {
                  type: 'amount',
                  unit: '万元',
                  displayScale: 0.0001,
                  xlsxScale: 0.0001,
                  prefix: '47万',
                },
              },
      }));
    },
  };
  const contract = await new PresentationPlanner().plan({
    harness,
    prompt: '输出保持简洁。',
    question: '销售额是多少',
    columns: [
      { name: '销售额', bizName: 'sale_amt', showType: 'NUMBER' },
    ],
    rows: [{ sale_amt: 470_000 }],
    presentationEvidence: {
      onlineTemplates: {
        sale_amt: {
          type: 'amount',
          unit: '万元',
          displayScale: 0.0001,
          xlsxScale: 0.0001,
          decimals: 1,
        },
      },
      onlineFormattedRows: [{ sale_amt: '47.0万' }],
    },
    metadata: {
      userId: 7,
      sessionId: 11,
      themeId: 3,
    },
  });

  assert.ok(Array.isArray(capturedMessages));
  assert.deepEqual(capturedTools, []);
  assert.equal(capturedMetadata.callType, 'PRESENTATION_CONTRACT');
  assert.equal(capturedMetadata.userId, 7);
  assert.equal(contract.source, 'MODEL_PRESENTATION_CONTRACT');
  assert.equal(contract.meta.generatedByModel, true);
  assert.equal(contract.meta.provider, 'deepseek');
  assert.equal(contract.meta.model, 'deepseek-chat');
  assert.equal(contract.fields.sale_amt.unit, '万元');
  assert.equal(contract.fields.sale_amt.displayScale, 0.0001);
  assert.equal(contract.fields.sale_amt.numberFormat, '#,##0.0');
  assert.equal(contract.fields.sale_amt.formatted, undefined);
  assert.equal(contract.fields.unknown_field, undefined);
  assert.equal(contract.fields.invalid_amount, undefined);
  assert.deepEqual(
    contract.meta.rejectedFields.map((item) => item.field).sort(),
    ['invalid_amount', 'unknown_field'],
  );
});

test('presentation planner keeps online formatting when the model response is invalid', async () => {
  const contract = await new PresentationPlanner().plan({
    harness: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      chat: async () => responsesText('47万'),
    },
    prompt: '金额使用万元。',
    question: '销售额是多少',
    columns: [
      { name: '销售额', bizName: 'sale_amt', showType: 'NUMBER' },
    ],
    rows: [{ sale_amt: 470_000 }],
    presentationEvidence: {
      onlineTemplates: {
        sale_amt: {
          type: 'amount',
          unit: '万元',
          displayScale: 0.0001,
          xlsxScale: 0.0001,
          decimals: 0,
        },
      },
      onlineFormattedRows: [{ sale_amt: '47万' }],
    },
  });

  assert.equal(contract.source, 'RAW');
  assert.equal(contract.meta.generatedByModel, false);
  // 模型没给出可用契约时，在线格式模板仍要生效（在线元数据优先级最高）。
  assert.equal(contract.fields.sale_amt.unit, '万元');
  assert.equal(contract.fields.sale_amt.displayScale, 0.0001);
  assert.equal(contract.fields.sale_amt.basis, 'ONLINE_METADATA');
  assert.deepEqual(contract.meta.fallbackFields, [{ field: 'sale_amt', basis: 'ONLINE_METADATA' }]);
});

test('presentation planner falls back to the theme prompt without online metadata', async () => {
  const contract = await new PresentationPlanner().plan({
    harness: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      chat: async () => responsesText('金额按万元展示。'),
    },
    prompt: [
      '展示规范：金额按万元、0 位小数展示，表头标明 (万元)。',
      '```presentation',
      '{"amount":{"unit":"万元","decimals":0,"match":["金额","销售额"]}}',
      '```',
    ].join('\n'),
    question: '销售额是多少',
    columns: [
      { name: '销售额', bizName: 'sale_amt', showType: 'NUMBER', unit: '' },
      { name: '订单量', bizName: 'order_count', showType: 'NUMBER', unit: '单' },
    ],
    rows: [{ sale_amt: 470_000, order_count: 1_200 }],
  });

  // 模型没给出可用契约时，主题提示词里的金额单位必须仍然生效，且不再回退成原始元值。
  assert.equal(contract.fields.sale_amt.unit, '万元');
  assert.equal(contract.fields.sale_amt.displayScale, 0.0001);
  assert.equal(contract.fields.sale_amt.decimals, 0);
  assert.equal(contract.fields.sale_amt.basis, 'THEME_PROMPT');
  assert.equal(contract.fields.order_count, undefined);

  const rendered = applyResultPresentation({
    columns: [
      { name: '销售额', bizName: 'sale_amt', showType: 'NUMBER' },
      { name: '订单量', bizName: 'order_count', showType: 'NUMBER' },
    ],
    rows: [{ sale_amt: 470_000, order_count: 1_200 }],
    contract,
  });
  const amount = rendered.columns.find((column) => column.bizName === 'sale_amt');
  assert.equal(amount.name, '销售额（万元）');
  assert.equal(formatPresentationCell(470_000, amount), '47');
  assert.equal(contract.meta.warnings[0].code, 'PRESENTATION_CONTRACT_INVALID');
});

test('theme presentation rules override conflicting model metadata', async () => {
  const contract = await new PresentationPlanner().plan({
    harness: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      chat: async () => responsesText(JSON.stringify({
              fields: {
                sale_amt: {
                  type: 'amount',
                  unit: '万元',
                  displayScale: 0.0001,
                  xlsxScale: 0.0001,
                  decimals: 0,
                  basis: 'ONLINE_METADATA',
                },
              },
      })),
    },
    prompt: [
      '展示规范：金额按万元、2 位小数展示。',
      '```presentation',
      '{"amount":{"unit":"万元","decimals":2,"match":["金额","销售额"]}}',
      '```',
    ].join('\n'),
    question: '销售额是多少',
    columns: [
      { name: '销售额', bizName: 'sale_amt', showType: 'NUMBER' },
    ],
    rows: [{ sale_amt: 470_000 }],
  });

  assert.equal(contract.fields.sale_amt.decimals, 2);
  assert.equal(contract.fields.sale_amt.numberFormat, '#,##0.00');
  assert.equal(contract.fields.sale_amt.basis, 'THEME_PROMPT');
  assert.deepEqual(contract.meta.fallbackFields, [{ field: 'sale_amt', basis: 'THEME_PROMPT' }]);
});

test('session decimal directives survive final result normalization', () => {
  const directive = parseConversationDirective('保留两位小数');
  const contract = applyConversationDirectivesToPresentationContract({
    version: 1,
    source: 'RAW',
    fields: {
      sale_amt: {
        type: 'amount',
        unit: '万元',
        displayScale: 0.0001,
        xlsxScale: 0.0001,
        decimals: 0,
        basis: 'THEME_PROMPT',
      },
    },
    meta: {},
  }, [directive]);
  const rendered = applyResultPresentation({
    columns: [{ name: '销售额', bizName: 'sale_amt', showType: 'NUMBER' }],
    rows: [{ sale_amt: 470_000 }],
    contract,
  });

  const amount = rendered.columns.find((column) => column.bizName === 'sale_amt');
  assert.equal(amount.displayDecimals, 2);
  assert.equal(amount.presentationBasis, 'SESSION_DIRECTIVE');
  assert.equal(formatPresentationCell(470_000, amount), '47.00');
  assert.equal(rendered.contract.meta.conversationDirective.decimals, 2);
});

test('presentation planner reuses a valid model contract for identical evidence', async () => {
  let chatCount = 0;
  const harness = {
    provider: 'deepseek',
    model: 'deepseek-chat',
    async chat() {
      chatCount += 1;
      return responsesText(JSON.stringify({
              fields: {
                sale_amt: {
                  type: 'amount',
                  unit: '万元',
                  displayScale: 0.0001,
                  xlsxScale: 0.0001,
                  decimals: 1,
                  basis: 'ONLINE_METADATA',
                },
              },
      }));
    },
  };
  const planner = new PresentationPlanner();
  const input = {
    harness,
    prompt: '金额使用万元。',
    question: '8月销售额是多少',
    columns: [
      { name: '销售额', bizName: 'sale_amt', showType: 'NUMBER' },
    ],
    rows: [{ sale_amt: 470_000 }],
    presentationEvidence: {
      onlineTemplates: {
        sale_amt: {
          type: 'amount',
          unit: '万元',
          displayScale: 0.0001,
          xlsxScale: 0.0001,
          decimals: 1,
        },
      },
      onlineFormattedRows: [{ sale_amt: '47.0万' }],
    },
  };

  const first = await planner.plan(input);
  const second = await planner.plan(input);

  assert.equal(chatCount, 1);
  assert.deepEqual(first.fields, second.fields);
  assert.equal(second.meta.generatedByModel, true);
});

test('deterministic renderer projects amount and percentage values', () => {
  const result = applyResultPresentation({
    columns: [
      { name: '销售额', bizName: 'sale_amt', showType: 'NUMBER' },
      { name: '毛利率', bizName: 'gross_margin_rate', showType: 'NUMBER' },
    ],
    rows: [
      { sale_amt: 470_000, gross_margin_rate: 0.084 },
    ],
    contract: {
      source: 'MODEL_PRESENTATION_CONTRACT',
      meta: {
        generatedByModel: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
      fields: {
        sale_amt: {
          type: 'amount',
          unit: '万元',
          displayScale: 0.0001,
          xlsxScale: 0.0001,
          decimals: 1,
          basis: 'THEME_PROMPT',
        },
        gross_margin_rate: {
          type: 'percent',
          unit: '%',
          displayScale: 100,
          xlsxScale: 1,
          decimals: 1,
          basis: 'RESULT_EVIDENCE',
        },
      },
    },
  });

  const amount = result.columns.find((column) => column.bizName === 'sale_amt');
  const rate = result.columns.find((column) => column.bizName === 'gross_margin_rate');
  assert.equal(amount.name, '销售额（万元）');
  assert.equal(formatPresentationCell(470_000, amount), '47.0');
  assert.equal(presentationValueForColumn(470_000, amount), 47);
  assert.equal(amount.numberFormat, '#,##0.0');
  assert.equal(rate.name, '毛利率（%）');
  assert.equal(formatPresentationCell(0.084, rate), '8.4%');
  assert.equal(presentationValueForColumn(0.084, rate), 0.084);
  assert.equal(rate.numberFormat, '0.0%');
});

test('aggregated metric aliases inherit presentation rules from their source field', () => {
  const result = applyResultPresentation({
    columns: [{
      name: '销售额',
      bizName: 'sale_amt_total',
      sourceField: 'sale_amt',
      sourceLabel: '销售额',
      showType: 'NUMBER',
    }],
    rows: [{ sale_amt_total: 470_000 }],
    contract: {
      source: 'MODEL_PRESENTATION_CONTRACT',
      meta: {
        generatedByModel: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
      fields: {
        sale_amt: {
          type: 'amount',
          unit: '万元',
          displayScale: 0.0001,
          xlsxScale: 0.0001,
          decimals: 0,
          basis: 'THEME_PROMPT',
        },
      },
    },
  });
  const column = result.columns[0];
  assert.equal(column.name, '销售额（万元）');
  assert.equal(column.displayScale, 0.0001);
  assert.equal(formatPresentationCell(470_000, column), '47');
});

test('presentation planner reads percentage rules declared in the theme prompt', async () => {
  const contract = await new PresentationPlanner().plan({
    harness: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      chat: async () => responsesText('不是 JSON'),
    },
    prompt: [
      '```presentation',
      JSON.stringify({
        percent: { decimals: 2, match: ['率', '占比'] },
        fields: {
          gross_margin_rate: { type: 'percent', decimals: 1, inputScale: 'points' },
        },
      }),
      '```',
    ].join('\n'),
    question: '毛利率和退货率分别是多少',
    columns: [
      { name: '毛利率', bizName: 'gross_margin_rate', showType: 'NUMBER' },
      { name: '退货率', bizName: 'return_rate', showType: 'NUMBER' },
    ],
    rows: [{ gross_margin_rate: 8.4, return_rate: 0.052 }],
  });

  // fields 的字段级声明优先于 match：points 表示原始值已经是百分点，不再乘 100。
  assert.equal(contract.fields.gross_margin_rate.displayScale, 1);
  assert.equal(contract.fields.gross_margin_rate.xlsxScale, 0.01);
  assert.equal(contract.fields.gross_margin_rate.decimals, 1);
  // match 命中的字段走声明里的默认口径：0.052 这类小数比率投影成 5.20%。
  assert.equal(contract.fields.return_rate.displayScale, 100);
  assert.equal(contract.fields.return_rate.decimals, 2);

  const rendered = applyResultPresentation({
    columns: [{ name: '毛利率', bizName: 'gross_margin_rate', showType: 'NUMBER' }],
    rows: [{ gross_margin_rate: 8.4 }],
    contract,
  });
  assert.equal(rendered.columns[0].name, '毛利率（%）');
});

test('presentation planner ignores a malformed theme presentation block', async () => {
  const contract = await new PresentationPlanner().plan({
    harness: null,
    prompt: '展示规范：金额按万元、0 位小数展示。\n```presentation\n{ 不是 JSON }\n```',
    question: '销售额是多少',
    columns: [{ name: '销售额', bizName: 'sale_amt', showType: 'NUMBER', unit: '' }],
    rows: [{ sale_amt: 470_000 }],
  });

  // 声明块不可解析时不做任何猜测，保持原始单位展示。
  assert.deepEqual(contract.fields, {});
});

test('presentation planner leaves fields untouched when the theme declares nothing', async () => {
  const contract = await new PresentationPlanner().plan({
    harness: null,
    prompt: '展示规范：金额按万元、0 位小数展示。',
    question: '销售额是多少',
    columns: [{ name: '销售额', bizName: 'sale_amt', showType: 'NUMBER', unit: '' }],
    rows: [{ sale_amt: 470_000 }],
  });

  // 自然语言描述不再被代码当规则解析，规则只能来自声明块或在线元数据。
  assert.deepEqual(contract.fields, {});
});


test('xlsx projection respects column types and preserves missing values', () => {
  const text = { showType: 'STRING', type: 'STRING' };
  for (const value of ['00123', '9007199254740993', 'A-1']) {
    assert.equal(presentationValueForColumn(value, text), value);
  }
  for (const value of ['', null, undefined]) {
    assert.equal(presentationValueForColumn(value, { showType: 'NUMBER', xlsxScale: 0.01 }), value);
  }
  assert.equal(presentationValueForColumn('25', { showType: 'NUMBER' }), 25);
  assert.equal(presentationValueForColumn('470000', { type: 'DECIMAL', xlsxScale: 0.0001 }), 47);
  assert.equal(presentationValueForColumn('8.4', { presentationType: 'percent', xlsxScale: 0.01 }), 0.084);
});
