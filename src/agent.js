import { suggestChart } from './chart.js';
import { createAgentToolExecutor } from './agentToolExecutor.js';
import { createAgentDatasetToolHandlers } from './agentDatasetToolHandlers.js';
import { createAgentWorkspaceToolHandlers } from './agentWorkspaceToolHandlers.js';
import { composeAnswerMessage } from './answerComposer.js';
import { createAgentRecoveryCoordinator } from './agentRecoveryCoordinator.js';
import {
  buildChartRestyleOutcome,
  detectChartRestyle,
  resolveChartPreference,
  selectReusableSnapshot,
} from './chartIntent.js';
import { validateAnalysisOutputsAsync } from './analysisArtifact.js';
import { ANALYSIS_RESULT_FILE, buildAnalysisContractPrompt } from './analysisContract.js';
import { buildSystemPrompt } from './agentPlanner.js';
import { buildArtifactTitle, buildSessionFileName } from './fileName.js';
import { rankIndicators, sortIndicators } from './indicatorSearch.js';
import { resolveBusinessLexicon } from './businessLexicon.js';
import {
  buildDeterministicSummary,
  buildQueryContract,
  buildQueryScopeSummary,
  queryFingerprint,
  selectPublicResult,
  stabilizeQueryResult,
} from './queryContract.js';
import {
  inferAnalysisMode,
  inferDatasetQuerySpec,
  inferIndicatorQuerySpec,
  isClarificationText,
  mergeSemanticFilters,
  resolveClarificationPolicy,
  resolveArtifactReusePolicy,
} from './queryIntent.js';
import { DataAgentWorkflow } from './workflow.js';
import { reflectOnAnswer, createHarnessJudge, REFLECTION_VERSION } from './reflection.js';
import {
  createTraceId,
  currentTraceId,
  normalizeTraceId,
  runWithTrace,
} from './trace.js';
import { QueryContractCompiler } from './queryContractCompiler.js';
import { describeIndicatorSource } from './indicatorSource.js';
import { aggregateRowsByTimeGrain } from './timeAggregation.js';
import {
  buildModelClarification,
  buildSemanticSpanClarification,
  buildValueClarification,
  collectValueCandidates,
  collectSemanticSpanGroups,
} from './valueClarification.js';
import { resolveQueryLimit } from './queryLimit.js';
import { createProgressiveAnswerEmitter } from './answerStream.js';
import { createProcessArtifactRecorderAsync } from './processArtifacts.js';
import { appendUserQuestionWithAttachmentsAsync } from './chatAttachments.js';
import { tokenBudgetError } from './tokenBudget.js';
import { USER_MEMORY_TOOLS, createUserMemoryToolHandler } from './userMemoryTools.js';
import { resolveConversationRuntime } from './conversationRuntime.js';
import {
  applyConversationDirectivesToPresentationContract,
  describeConversationDirective,
  mergeSessionDirectives,
  parseConversationDirective,
} from './conversationDirectives.js';
import { resolveMemoryPreInject } from './memoryRetrieval.js';
import {
  TURN_TYPES,
  completeTaskState,
  publicContextDecision,
} from './turnContext.js';
import { analyzeWithPlugins, resolveWithPlugins } from './analysisPluginRegistry.js';
import {
  buildSemanticFastPathDraft,
} from './fastQueryPath.js';
import {
  AgentRuntimeCache,
  buildCacheKey,
} from './runtimeCache.js';
import {
  isPotentialEnumField,
  normalizeSemanticValueConfig,
  semanticValueFieldKey,
} from './semanticValues.js';
import { applyResultPostProcessing } from './resultProcessing.js';
import { applyAnalysisPipeline } from './analysisPipeline.js';
import {
  applyDerivedMetricFilters,
  applyDerivedMetrics,
} from './derivedMetrics.js';
import {
  buildArtifactCapabilities,
  decideArtifactStrategy,
} from './artifactCapabilities.js';
import {
  applyResultPresentation,
  buildPresentationEvidence,
  PresentationPlanner,
} from './resultPresentation.js';
import { datasetExecution } from './datasetExecution.js';
import { buildResultAnalysisText } from './resultAnalyst.js';
import { prepareBoundDatasetExecution } from './scopedMetrics.js';
import { callPlatformDatabase } from './platformDatabaseAccess.js';
import { resolveThemeBusinessDatasets, resolveThemeBusinessDatasetsAsync } from './themeDatasets.js';
import {
  buildAnswerEvidence,
  looksLikeDataClaim,
  requiresGroundedAnswer,
  UNGROUNDED_ANSWER_MESSAGE,
} from './answerEvidence.js';
import { buildReplanCarryForward } from './executionRecovery.js';
import {
  buildContractSourceContext as buildContextFromModule,
  buildStructuredClarification as buildClarificationFromModule,
  resolveBoundDatasetDimensions as resolveBoundDimensionsFromModule,
} from './contractContext.js';
export {
  buildContractSourceContext,
  buildStructuredClarification,
  resolveBoundDatasetDimensions,
} from './contractContext.js';
import {
  applyColumnPolicies,
  assertAllowedDimensions,
  canAccessIndicator,
  enforceRowPolicies,
  filterDimensionsByScope,
  filterIndicatorsByScope,
  resolveAccessScope,
} from './permissions.js';

const TOOL_DEFINITIONS = [
  ...USER_MEMORY_TOOLS,
  {
    type: 'function',
    function: {
      name: 'search_indicators',
      description: 'Search indicators that the current user is allowed to access in this theme.',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'Business keywords from the question.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 6 },
        },
        required: ['keyword'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_indicator',
      description: 'Get the metric and dimension definitions of one allowed indicator.',
      parameters: {
        type: 'object',
        properties: {
          indicatorId: { type: 'string', description: 'Indicator source id.' },
        },
        required: ['indicatorId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compile_query_contract',
      description: [
        'Compile a traceable query contract before any data query.',
        'The contract must cover every clause in the user question with an explicit condition ledger.',
        'Classify every effective phrase into the analysis taxonomy before compiling: time window, time grain, metric, dimension, filter, scope, ranking, comparison, calculation, trend, attribution and result action.',
        'Platform-owned structural categories are completed deterministically, while business fields and enum mappings must be model-confirmed.',
        'Trend intent is a RESULT_ACTION and must bind a time dimension; monthly, weekly, quarterly, yearly and daily grouping phrases must set the matching timeGrain.',
        'Attribution questions must use two equal-length time windows, PERIOD_COMPARISON and at least one business breakdown dimension; do not ask the user for these defaults when the theme prompt defines them.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          sourceType: {
            type: 'string',
            enum: ['INDICATOR', 'BUSINESS_DATASET'],
          },
          indicatorId: { type: 'string' },
          datasetId: { type: 'integer' },
          conditions: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                sourceText: {
                  type: 'string',
                  description: 'Exact contiguous text from the user question.',
                },
                kind: {
                  type: 'string',
                  enum: [
                    'METRIC',
                    'DIMENSION',
                    'FILTER',
                    'SCOPE',
                    'TIME',
                    'LIMIT',
                    'COMPARISON',
                    'CALCULATION',
                    'ANALYSIS_STAGE',
                    'RESULT_ACTION',
                    'OTHER',
                  ],
                },
                status: {
                  type: 'string',
                  enum: ['RESOLVED', 'UNRESOLVED', 'NOT_APPLICABLE'],
                },
                reason: { type: 'string' },
                ruleSource: { type: 'string' },
              },
              required: ['id', 'sourceText', 'kind', 'status'],
              additionalProperties: false,
            },
          },
          metricFields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                outputField: {
                  type: 'string',
                  description: [
                    'Unique result-column name for this metric variant.',
                    'Required when the same base field and aggregator appear under different filter or scope conditions.',
                    'Use stable ASCII identifiers such as oem_sale_amt or total_sku_count.',
                  ].join(' '),
                },
                sourceText: {
                  type: 'string',
                  description: [
                    'Exact metric phrase from the user question.',
                    'For a COUNT metric choose ONE IDENTIFIER field and use COUNT_DISTINCT when the question asks for a distinct entity count; do not submit several identifier fields for the same count.',
                  ].join(' '),
                },
                aggregator: {
                  type: 'string',
                  enum: ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNT_DISTINCT'],
                },
                internal: {
                  type: 'boolean',
                  description: 'Set true for an intermediate denominator or base column that should not be shown directly.',
                },
                conditionIds: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
              required: ['field', 'sourceText'],
              additionalProperties: false,
            },
          },
          derivedMetrics: {
            type: 'array',
            description: [
              'Optional structured derived metrics compiled by the platform.',
              'Use RATIO for numerator/denominator, GROWTH_RATE for period growth, DIFFERENCE for amount change, PERCENTAGE_POINT for percentage-point change, SUM for additive aggregation, AVERAGE for averages and EXPRESSION for a generic arithmetic tree.',
              'EXPRESSION uses op/left/right/value nodes with FIELD, ADD, SUBTRACT, MULTIPLY, DIVIDE, ABS and NEGATE. FIELD nodes reference confirmed metric fields or earlier derived outputField values.',
              'For a ratio, define both numerator and denominator as metricFields with unique outputField values. The numerator metric includes the applicable FILTER conditionIds; the denominator metric includes the SCOPE conditionIds but excludes the numerator FILTER conditionIds. The platform will calculate each scope separately within the same time window and then apply the derived ratio.',
              'RATIO numerator/denominator must reference metricFields outputField values or exact confirmed field names; do not provide SQL or rendered values.',
            ].join(' '),
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: {
                  type: 'string',
                  enum: [
                    'RATIO',
                    'DIFFERENCE',
                    'GROWTH_RATE',
                    'PERCENTAGE_POINT',
                    'SUM',
                    'AVERAGE',
                    'EXPRESSION',
                  ],
                },
                expression: {
                  type: 'object',
                  description: 'Generic arithmetic expression tree for type=EXPRESSION.',
                },
                left: {
                  type: 'object',
                  properties: {
                    field: { type: 'string' },
                    aggregator: {
                      type: 'string',
                      enum: ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNT_DISTINCT'],
                    },
                  },
                  required: ['field'],
                  additionalProperties: false,
                },
                right: {
                  type: 'object',
                  properties: {
                    field: { type: 'string' },
                    aggregator: {
                      type: 'string',
                      enum: ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNT_DISTINCT'],
                    },
                  },
                  required: ['field'],
                  additionalProperties: false,
                },
                numerator: {
                  type: 'string',
                  description: 'metricFields outputField for the ratio numerator.',
                },
                denominator: {
                  type: 'string',
                  description: 'metricFields outputField for the ratio denominator.',
                },
                metric: {
                  type: 'string',
                  description: 'metricFields outputField or exact confirmed field name.',
                },
                secondMetric: {
                  type: 'string',
                  description: 'metricFields outputField or exact confirmed field name.',
                },
                outputField: { type: 'string' },
                outputFormat: {
                  type: 'string',
                  enum: ['NUMBER', 'PERCENT', 'CURRENCY', 'QUANTITY'],
                },
                precision: { type: 'integer', minimum: 0, maximum: 12 },
                conditionIds: {
                  type: 'array',
                  items: { type: 'string' },
                },
                ruleSource: { type: 'string' },
              },
              required: ['name', 'type', 'outputField'],
              additionalProperties: false,
            },
          },
          dimensionFields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                sourceText: {
                  type: 'string',
                  description: 'Exact dimension or grouping phrase from the user question.',
                },
                timeGrain: {
                  type: 'string',
                  enum: ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'],
                },
                ruleSource: {
                  type: 'string',
                  description: 'Theme prompt rule used to derive the dimension, especially for attribution breakdowns.',
                },
                conditionIds: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
              required: ['field', 'sourceText'],
              additionalProperties: false,
            },
          },
          filterFields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                operator: {
                  type: 'string',
                  enum: [
                    'IN',
                    'NOT_IN',
                    '=',
                    '!=',
                    '>',
                    '>=',
                    '<',
                    '<=',
                    'LIKE',
                    'BETWEEN',
                  ],
                },
                value: {},
                sourceText: { type: 'string' },
                ruleSource: {
                  type: 'string',
                  description: 'Exact rule text from the theme prompt when the value is mapped.',
                },
                conditionIds: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
              required: ['field', 'operator', 'value', 'sourceText'],
              additionalProperties: false,
            },
          },
          scopeModifiers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sourceText: {
                  type: 'string',
                  description: 'Exact scope phrase from the user question.',
                },
                action: {
                  type: 'string',
                  enum: ['NO_FILTER', 'ALL_SCOPE'],
                },
                ruleSource: { type: 'string' },
                conditionIds: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
              required: ['sourceText', 'action'],
              additionalProperties: false,
            },
          },
          timeWindows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sourceText: {
                  type: 'string',
                  description: 'Exact time expression from the user question.',
                },
                label: { type: 'string' },
                dateMode: { type: 'string', enum: ['RECENT', 'BETWEEN', 'ALL'] },
                unit: { type: 'integer', minimum: 1, maximum: 365 },
                period: {
                  type: 'string',
                  enum: ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'],
                },
                startDate: { type: 'string' },
                endDate: { type: 'string' },
                ruleSource: { type: 'string' },
                conditionIds: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
              required: ['sourceText', 'dateMode'],
              additionalProperties: false,
            },
          },
          timeGrain: {
            type: 'string',
            enum: ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'],
          },
          limit: { type: 'integer', minimum: 1, maximum: 2000, default: 200 },
          order: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                direction: { type: 'string', enum: ['ASC', 'DESC'] },
              },
              required: ['field'],
              additionalProperties: false,
            },
          },
          calculation: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['NONE', 'PERIOD_COMPARISON'],
              },
              baseWindowIndex: { type: 'integer', minimum: 0 },
              compareWindowIndex: { type: 'integer', minimum: 0 },
              description: { type: 'string' },
            },
            required: ['type'],
            additionalProperties: false,
          },
          postProcessing: {
            type: 'object',
            description: [
              'Optional dataset-only pipeline for value grouping, period comparison and pivot output.',
              'Use this when a question requires merging category values, calculating a derived comparison such as YoY, or producing a two-level-category pivot table.',
            ].join(' '),
            properties: {
              groupValues: {
                type: 'object',
                properties: {
                  field: { type: 'string' },
                  outputField: { type: 'string' },
                  displayName: { type: 'string' },
                  defaultValue: { type: 'string' },
                  groups: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        values: {
                          type: 'array',
                          items: { type: 'string' },
                        },
                      },
                      required: ['name', 'values'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['field', 'outputField', 'groups'],
                additionalProperties: false,
              },
              periodComparison: {
                type: 'object',
                properties: {
                  metric: { type: 'string' },
                  outputField: { type: 'string' },
                  displayName: { type: 'string' },
                  type: { type: 'string', enum: ['RATE', 'DELTA'] },
                  periodField: { type: 'string', default: '__period' },
                  basePeriod: { type: 'string' },
                  comparePeriod: { type: 'string' },
                  rowFields: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
                required: ['metric', 'outputField', 'type'],
                additionalProperties: false,
              },
              pivot: {
                type: 'object',
                properties: {
                  rowFields: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  columnField: { type: 'string' },
                  valueFields: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        field: { type: 'string' },
                        label: { type: 'string' },
                      },
                      required: ['field'],
                      additionalProperties: false,
                    },
                  },
                  includeTotal: { type: 'boolean', default: true },
                  totalLabel: { type: 'string', default: '合计' },
                },
                required: ['rowFields', 'columnField', 'valueFields'],
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
          analysisPipeline: {
            type: 'object',
            description: [
              'Optional generic post-query analysis pipeline for BUSINESS_DATASET.',
              'Use it only for multi-pass relationships that a single GROUP BY cannot express, for example intermediate per-row derived calculations, ALL/ANY row qualification, qualification-count rollups, derived sort keys and a final TOP-N limit.',
              'Never use it to hardcode business values. Stage fields must reference fields returned by the dataset definition or outputField values from earlier stages.',
              'The source query must first return the finest required rows and raw fields. The pipeline then applies stages in order and is deterministically executed by the platform.',
            ].join(' '),
            properties: {
              version: { type: 'integer', enum: [1], default: 1 },
              stages: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    type: {
                      type: 'string',
                      enum: [
                        'BUCKET_FIELD',
                        'DERIVE',
                        'FILTER',
                        'ROLLUP',
                        'SORT',
                        'LIMIT',
                        'SELECT_COLUMNS',
                      ],
                    },
                    sourceField: { type: 'string' },
                    outputField: { type: 'string' },
                    period: {
                      type: 'string',
                      enum: ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'],
                    },
                    definitions: {
                      type: 'array',
                      minItems: 1,
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          type: {
                            type: 'string',
                            enum: [
                              'RATIO',
                              'DIFFERENCE',
                              'GROWTH_RATE',
                              'PERCENTAGE_POINT',
                              'SUM',
                              'AVERAGE',
                              'EXPRESSION',
                            ],
                          },
                          expression: { type: 'object' },
                          left: { type: 'object' },
                          right: { type: 'object' },
                          outputField: { type: 'string' },
                          outputFormat: {
                            type: 'string',
                            enum: ['NUMBER', 'PERCENT', 'CURRENCY', 'QUANTITY'],
                          },
                          precision: { type: 'integer', minimum: 0, maximum: 12 },
                        },
                        required: ['name', 'type', 'outputField'],
                        additionalProperties: false,
                      },
                    },
                    predicate: {
                      type: 'object',
                      properties: {
                        mode: { type: 'string', enum: ['ALL', 'ANY'] },
                        conditions: {
                          type: 'array',
                          minItems: 1,
                          items: {
                            type: 'object',
                            properties: {
                              field: { type: 'string' },
                              operator: {
                                type: 'string',
                                enum: [
                                  '=',
                                  '!=',
                                  '>',
                                  '>=',
                                  '<',
                                  '<=',
                                  'IN',
                                  'NOT_IN',
                                  'BETWEEN',
                                  'IS_NULL',
                                  'IS_NOT_NULL',
                                ],
                              },
                              value: {},
                            },
                            required: ['field', 'operator'],
                            additionalProperties: false,
                          },
                        },
                      },
                      required: ['mode', 'conditions'],
                      additionalProperties: false,
                    },
                    groupBy: {
                      type: 'array',
                      minItems: 1,
                      items: { type: 'string' },
                    },
                    outputs: {
                      type: 'array',
                      minItems: 1,
                      items: {
                        type: 'object',
                        properties: {
                          type: {
                            type: 'string',
                            enum: [
                              'AGGREGATE',
                              'CONDITIONAL_AGGREGATE',
                              'COUNT_IF',
                            ],
                          },
                          outputField: { type: 'string' },
                          metric: { type: 'string' },
                          aggregator: {
                            type: 'string',
                            enum: [
                              'SUM',
                              'AVG',
                              'MIN',
                              'MAX',
                              'COUNT',
                              'COUNT_DISTINCT',
                            ],
                          },
                          predicate: {
                            type: 'object',
                            properties: {
                              mode: { type: 'string', enum: ['ALL', 'ANY'] },
                              conditions: {
                                type: 'array',
                                minItems: 1,
                                items: {
                                  type: 'object',
                                  properties: {
                                    field: { type: 'string' },
                                    operator: { type: 'string' },
                                    value: {},
                                  },
                                  required: ['field', 'operator'],
                                  additionalProperties: false,
                                },
                              },
                            },
                            required: ['mode', 'conditions'],
                            additionalProperties: false,
                          },
                        },
                        required: ['type', 'outputField'],
                        additionalProperties: false,
                      },
                    },
                    order: {
                      type: 'array',
                      minItems: 1,
                      items: {
                        type: 'object',
                        properties: {
                          field: { type: 'string' },
                          direction: { type: 'string', enum: ['ASC', 'DESC'] },
                        },
                        required: ['field', 'direction'],
                        additionalProperties: false,
                      },
                    },
                    value: { type: 'integer', minimum: 1, maximum: 10000 },
                    fields: {
                      type: 'array',
                      minItems: 1,
                      items: { type: 'string' },
                    },
                  },
                  required: ['type'],
                  additionalProperties: false,
                },
              },
            },
            required: ['stages'],
            additionalProperties: false,
          },
        },
        required: ['sourceType', 'conditions', 'metricFields'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_query_contract',
      description: 'Execute a query contract only after compile_query_contract returned valid=true.',
      parameters: {
        type: 'object',
        properties: {
          contractId: { type: 'string' },
        },
        required: ['contractId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_business_datasets',
      description: 'List business datasets available to the current user and theme.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_business_dataset_definition',
      description: 'Read and confirm the semantic fields of a business dataset before querying it.',
      parameters: {
        type: 'object',
        properties: {
          datasetId: { type: 'integer' },
        },
        required: ['datasetId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_workspace_artifacts',
      description: 'List structured table artifacts in the current session workspace.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'transform_workspace_artifact',
      description: 'Apply a deterministic transformation to a workspace table artifact.',
      parameters: {
        type: 'object',
        properties: {
          artifactId: { type: 'string' },
          operation: {
            type: 'string',
            enum: [
              'add_summary_row',
              'sort',
              'rename_column',
              'format_column',
              'add_ratio_column',
              'filter_rows',
              'limit_rows',
            ],
          },
          params: { type: 'object' },
        },
        required: ['artifactId', 'operation'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_analysis_code',
      description: [
        'Generate and execute local Python analysis code for complex, custom or multi-step data processing.',
        'Use this for arbitrary value mapping, cross-file comparison, reconciliation, advanced calculations, or producing Excel/CSV/JSON files.',
        'Do not use it to render charts for the answer: the platform renders charts natively from the query result.',
        'Referenced workspace artifacts are copied into input/ and described in input/manifest.json.',
        'The script must use relative paths and write final deliverables into output/.',
        'Network access and process execution are blocked; runtime is isolated per session with a timeout.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          purpose: {
            type: 'string',
            description: 'Short description of the generated analysis code.',
          },
          language: {
            type: 'string',
            enum: ['python'],
            default: 'python',
          },
          code: {
            type: 'string',
            description: 'Complete Python script. Read inputs under input/ and write outputs under output/.',
          },
          inputArtifactIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Workspace artifact IDs to materialize as input files.',
          },
          outputFiles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Expected output filenames, for auditing.',
          },
          timeoutSeconds: {
            type: 'integer',
            minimum: 1,
            maximum: 120,
            default: 60,
          },
        },
        required: ['purpose', 'language', 'code', 'inputArtifactIds'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_clarification',
      description: [
        'Ask the business user ONE confirmation question when the question truly cannot be answered with the confirmed rules.',
        'Use it instead of writing a clarification in plain text.',
        'Never use it for defaults the theme prompt already defines, nor to restate internal rules, calibers or validations.',
        'Write the question in plain business language in 1-2 sentences, and provide the 2-6 candidate options the user can pick.',
        'An option may carry the field and value it maps to; only do that when the option really is a filter value the platform can execute.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The single question to confirm, in plain business language.',
          },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Option text shown to the user.' },
                field: { type: 'string', description: 'Field the option maps to, when it is a filter value.' },
                value: { type: 'string', description: 'Filter value the option maps to.' },
              },
              required: ['label'],
              additionalProperties: false,
            },
          },
        },
        required: ['question', 'options'],
        additionalProperties: false,
      },
    },
  },
];

function normalizeDetail(cached, detail) {
  const indicator = detail?.indicator ?? detail ?? {};
  return {
    ...cached,
    ...indicator,
    id: indicator.id ?? cached.id,
    metrics: detail?.metrics ?? indicator.metrics ?? cached.metrics ?? [],
    dimensions: detail?.dimensions ?? indicator.dimensions ?? cached.dimensions ?? [],
    models: detail?.models ?? indicator.models ?? cached.models ?? [],
    sources: detail?.sources ?? [],
  };
}

function normalizeIndicatorSummary(indicator) {
  const source = indicator?.indicator ?? indicator ?? {};
  return {
    ...source,
    id: String(source.id ?? source.source_id ?? ''),
    metrics: indicator.metrics ?? [],
    dimensions: indicator.dimensions ?? [],
    models: indicator.models ?? [],
  };
}

function defaultMappingProvenance({ indicator = null, dataset = null } = {}) {
  if (indicator) {
    return {
      mode: 'INDICATOR_LIBRARY',
      label: '指标库口径',
      confidence: 1,
      requiresAttention: false,
      reason: '结果来自指标库已确认的指标定义与字段。',
      fieldMappings: [],
    };
  }
  if (dataset) {
    return {
      mode: 'DATASET_EXACT',
      label: '数据集字段精确匹配',
      confidence: 1,
      requiresAttention: false,
      reason: '结果直接使用业务数据集中精确匹配的指标和维度字段。',
      fieldMappings: [],
    };
  }
  return null;
}

function metricVariables(metrics) {
  return {
    bizNames: metrics.map((metric) => metric.metricBizName ?? metric.bizName).filter(Boolean),
    labels: metrics.map((metric) => metric.metricName ?? metric.name).filter(Boolean),
  };
}

function dimensionVariables(dimensions) {
  return {
    bizNames: dimensions.map(
      (dimension) => dimension.dimensionBizName ?? dimension.bizName,
    ).filter(Boolean),
    labels: dimensions.map(
      (dimension) => dimension.dimensionName ?? dimension.name,
    ).filter(Boolean),
  };
}

function mapRequestedDimensions(requested, available) {
  const result = [];
  for (const value of requested ?? []) {
    const normalized = String(value);
    const match = (available ?? []).find((dimension) => [
      dimension.dimensionBizName,
      dimension.bizName,
      dimension.dimensionName,
      dimension.name,
    ].includes(normalized));
    if (match) {
      result.push(match.dimensionBizName ?? match.bizName);
    }
  }
  return [...new Set(result)];
}

function mapRequestedMetrics(requested, available) {
  const result = [];
  for (const value of requested ?? []) {
    const normalized = String(value);
    const match = (available ?? []).find((metric2) => [
      metric2.metricBizName,
      metric2.bizName,
      metric2.metricName,
      metric2.name,
    ].includes(normalized));
    if (match) {
      result.push(match.metricBizName ?? match.bizName);
    }
  }
  return [...new Set(result)];
}

function normalizeDateInfo(requested) {
  if (!requested) {
    return {
      dateMode: 'RECENT',
      unit: 7,
      period: 'DAY',
      startDate: null,
      endDate: null,
      dateList: [],
      detectWord: '近7天',
    };
  }
  const dateMode = String(requested.dateMode ?? 'RECENT').toUpperCase();
  const period = String(requested.period ?? 'DAY').toUpperCase();
  return {
    dateMode,
    unit: Math.max(1, Math.min(Number(requested.unit) || 7, 365)),
    period: ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'].includes(period) ? period : 'DAY',
    startDate: requested.startDate ?? null,
    endDate: requested.endDate ?? null,
    dateList: [],
    dateField: requested.dateField,
    detectWord: requested.detectWord ?? requested.expression ?? requested.label ?? '',
    expression: requested.expression ?? requested.detectWord ?? requested.label ?? '',
    label: requested.label ?? requested.detectWord ?? requested.expression ?? '',
  };
}

function selectDateField(dimensions) {
  let selected = null;
  let bestScore = -1;
  for (const dimension of dimensions ?? []) {
    const candidates = [
      dimension.dimensionBizName,
      dimension.bizName,
      dimension.dimensionName,
      dimension.name,
    ].filter(Boolean);
    for (const value of candidates) {
      const text = String(value).toLowerCase();
      let score = -1;
      if (/^(sdt|ds|dt|date|stat_date|partition_date)$/.test(text)) {
        score = 100;
      } else if (/日期|账期/.test(text)) {
        score = 80;
      } else if (/date/.test(text)) {
        score = 60;
      } else if (/time|时间/.test(text)) {
        score = 20;
      }
      if (score > bestScore) {
        bestScore = score;
        selected = String(
          dimension.dimensionBizName
          ?? dimension.bizName
          ?? value,
        );
      }
    }
  }
  return selected;
}

function selectDatasetTimeField(fields) {
  return (fields ?? []).find((field) => field.fieldName === 'sales_date')
    ?? (fields ?? []).find((field) => field.role === 'TIME')
    ?? null;
}

function buildDatasetDateRange(question, fields, requested, temporalResolver = null) {
  const parsed = temporalResolver?.({ question }) ?? null;
  if (!parsed || parsed.dateMode === 'ALL') {
    return requested;
  }
  const dateField = selectDatasetTimeField(fields);
  if (!dateField) {
    return requested;
  }
  return {
    field: dateField.fieldName,
    startDate: parsed.startDate ?? null,
    endDate: parsed.endDate ?? null,
  };
}

function isDateDimensionName(value) {
  return /(^|_)(date|time|day|week|month|year)($|_)|sdt|日期|时间|账期/i.test(
    String(value ?? ''),
  );
}

function selectRows(queryResult) {
  return queryResult?.resultList
    ?? queryResult?.rows
    ?? queryResult?.data
    ?? [];
}

function selectColumns(queryResult) {
  return queryResult?.columns ?? [];
}

function toolStageCode(name) {
  switch (name) {
    case 'search_indicators':
    case 'list_business_datasets':
      return 'SEMANTIC_DISCOVERY';
    case 'get_indicator':
    case 'get_business_dataset_definition':
      return 'SEMANTIC_CONFIRM';
    case 'compile_query_contract':
      return 'PLAN';
    case 'query_indicator':
    case 'query_business_dataset':
    case 'execute_query_contract':
      return 'EXECUTE';
    case 'execute_analysis_code':
      return 'CODE';
    case 'list_workspace_artifacts':
    case 'transform_workspace_artifact':
      return 'ANALYZE';
    default:
      return 'EXECUTE';
  }
}

function compactReviewValue(value, limit = 800) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const text = typeof value === 'string'
    ? value
    : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function formatReviewDuration(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) {
    return '';
  }
  if (milliseconds < 1000) {
    return `${Math.max(0, Math.round(milliseconds))} ms`;
  }
  return `${(milliseconds / 1000).toFixed(2)} 秒`;
}

function buildToolReview(name, args = {}, result = {}) {
  const facts = [];
  const addFact = (label, value) => {
    const text = compactReviewValue(value);
    if (text) {
      facts.push({ label, value: text });
    }
  };
  if (name === 'search_indicators') {
    addFact('检索词', args.keyword);
    addFact('命中', `${result.indicators?.length ?? 0} 个指标`);
  } else if (name === 'get_indicator') {
    addFact('指标', result.name);
    addFact('业务口径', result.businessCaliber);
    addFact('字段', `${result.metrics?.length ?? 0} 个指标 / ${result.dimensions?.length ?? 0} 个维度`);
    addFact(
      '默认值域',
      `${(result.dimensions ?? []).filter((item) => (item.values ?? []).length > 0).length} 个字段已初始化`,
    );
  } else if (name === 'list_business_datasets') {
    addFact('数据集', `${result.datasets?.length ?? 0} 个`);
    addFact('名称', (result.datasets ?? []).map((item) => item.name).join('、'));
  } else if (name === 'get_business_dataset_definition') {
    addFact('数据集', result.dataset?.name);
    addFact('字段', `${result.fields?.length ?? 0} 个`);
    addFact(
      '默认值域',
      `${(result.fields ?? []).filter((item) => (item.values ?? []).length > 0).length} 个字段已初始化`,
    );
  } else if (name === 'compile_query_contract') {
    addFact('契约', result.contractId ?? args.contractId);
    addFact('条件', `${args.conditions?.length ?? 0} 条`);
    addFact('指标', (args.metricFields ?? []).map((item) => item.field).join('、'));
    addFact('维度', (args.dimensionFields ?? []).map((item) => item.field).join('、'));
    addFact('过滤', `${args.filterFields?.length ?? 0} 条`);
    addFact('时间窗口', `${args.timeWindows?.length ?? 0} 个`);
    addFact('计算', args.calculation?.type ?? 'NONE');
    if (args.postProcessing) {
      const parts = [];
      if (args.postProcessing.groupValues) {
        parts.push(`值归并 ${args.postProcessing.groupValues.groups?.length ?? 0} 组`);
      }
      if (args.postProcessing.periodComparison) {
        parts.push(`同期计算 ${args.postProcessing.periodComparison.type}`);
      }
      if (args.postProcessing.pivot) {
        parts.push('透视输出');
      }
      addFact('后处理', parts.join(' / '));
    }
    if (args.analysisPipeline?.stages?.length) {
      addFact(
        '分析管线',
        `${args.analysisPipeline.stages.length} 个通用阶段：${
          args.analysisPipeline.stages.map((stage) => stage.type).join(' > ')
        }`,
      );
    }
  } else if (
    name === 'query_indicator'
    || name === 'query_business_dataset'
    || name === 'execute_query_contract'
  ) {
    addFact('数据源', result.dataset?.name ?? result.indicator?.name ?? args.indicatorId ?? args.datasetId);
    addFact('结果', `${result.rowCount ?? 0} 行 / ${result.columns?.length ?? 0} 列`);
    addFact('查询指纹', result.queryFingerprint);
  } else if (name === 'list_workspace_artifacts') {
    addFact('产物', `${result.artifacts?.length ?? 0} 个`);
    addFact('文件', (result.artifacts ?? []).map((item) => item.title).join('、'));
  } else if (name === 'transform_workspace_artifact') {
    addFact('操作', args.operation);
    addFact('结果', `${result.rowCount ?? 0} 行 / v${result.version ?? '-'}`);
  } else if (name === 'execute_analysis_code') {
    addFact('目的', args.purpose);
    addFact('运行', result.success ? '成功' : '失败');
    addFact('耗时', formatReviewDuration(result.durationMs));
    addFact('输入产物', `${result.inputArtifacts?.length ?? 0} 个`);
    addFact('输出文件', (result.outputs ?? []).map((item) => item.fileName).join('、'));
  }

  const details = {};
  if (name === 'compile_query_contract') {
    details.conditions = args.conditions ?? [];
    details.calculation = args.calculation ?? null;
    details.postProcessing = args.postProcessing ?? null;
    details.analysisPipeline = args.analysisPipeline ?? null;
  } else if (
    name === 'query_indicator'
    || name === 'query_business_dataset'
    || name === 'execute_query_contract'
  ) {
    details.contractId = args.contractId ?? null;
    details.columns = (result.columns ?? []).map((column) => column.name ?? column.bizName);
    details.rowCount = result.rowCount ?? 0;
    details.queryFingerprint = result.queryFingerprint ?? null;
  } else if (name === 'list_workspace_artifacts') {
    details.artifacts = (result.artifacts ?? []).map((item) => ({
      id: item.id,
      title: item.title,
      type: item.artifactType,
      columns: (item.columns ?? []).map((column) => column.name),
    }));
  } else if (name === 'execute_analysis_code') {
    details.runId = result.runId;
    details.inputArtifacts = result.inputArtifacts ?? [];
    details.outputs = result.outputs ?? [];
  }
  return {
    facts,
    details: Object.keys(details).length > 0 ? details : null,
    code: name === 'execute_analysis_code' ? String(args.code ?? '') : '',
    stdout: name === 'execute_analysis_code' ? String(result.stdout ?? '') : '',
    stderr: name === 'execute_analysis_code' ? String(result.stderr ?? '') : '',
  };
}

function describeToolStep(name, args, result) {
  if (name === 'search_indicators') {
    const count = result?.indicators?.length ?? 0;
    return {
      title: '检索主题指标',
      detail: `关键词：${args.keyword || '当前问题'}，命中 ${count} 个可用指标`,
    };
  }
  if (name === 'get_indicator') {
    const valueDomainCount = (result?.dimensions ?? [])
      .filter((dimension) => (dimension.values ?? []).length > 0).length;
    return {
      title: '确认指标口径与默认值域',
      detail: `${result?.name ?? args.indicatorId}，${
        result?.metrics?.length ?? 0
      } 个指标字段，${result?.dimensions?.length ?? 0} 个可用维度，${
        valueDomainCount
      } 个字段完成默认值域初始化`,
    };
  }
  if (name === 'compile_query_contract') {
    return {
      title: result?.valid ? '编译查询契约' : '查询契约待修正',
      detail: result?.valid
        ? `契约 ${result.contractId.slice(0, 12)} 已通过，覆盖 ${
          result.coverage?.length ?? 0
        } 个问题片段`
        : (result?.issues ?? []).map((issue) => issue.message).join('；')
          || '契约未通过',
    };
  }
  if (name === 'execute_query_contract') {
    return {
      title: '执行查询契约',
      detail: `${result?.indicator?.name ?? result?.dataset?.name ?? args.contractId}，返回 ${
        result?.rowCount ?? 0
      } 行`,
    };
  }
  if (name === 'list_business_datasets') {
    return {
      title: '检索业务数据集',
      detail: `发现 ${result?.datasets?.length ?? 0} 个可访问业务数据集`,
    };
  }
  if (name === 'get_business_dataset_definition') {
    const valueDomainCount = (result?.fields ?? [])
      .filter((field) => (field.values ?? []).length > 0).length;
    return {
      title: '确认业务字段与默认值域',
      detail: `${result?.dataset?.name ?? args.datasetId}，确认 ${
        result?.fields?.length ?? 0
      } 个字段，${valueDomainCount} 个字段完成默认值域初始化`,
    };
  }
  if (name === 'query_business_dataset') {
    return {
      title: '执行业务数据集查询',
      detail: `${result?.dataset?.name ?? args.datasetId}，按 ${
        result?.dimensions?.join('、') || '汇总'
      } 分析，返回 ${result?.rowCount ?? 0} 行`,
    };
  }
  if (name === 'query_indicator') {
    const dimensions = result?.dimensions?.length
      ? result.dimensions.join('、')
      : '汇总';
    const filters = result?.filters?.length
      ? `，过滤 ${result.filters.map((filter) => (
        `${filter.bizName} ${filter.operator} ${JSON.stringify(filter.value)}`
      )).join('；')}`
      : '';
    return {
      title: '执行指标查询',
      detail: `${result?.indicator?.name ?? args.indicatorId}，按${dimensions}分析${filters}，返回 ${
        result?.rowCount ?? 0
      } 行`,
    };
  }
  if (name === 'execute_analysis_code') {
    return {
      title: '生成并执行分析代码',
      detail: `${args.purpose || '复杂数据处理'}，${
        result?.success ? '执行成功' : '执行失败'
      }，生成 ${result?.outputs?.length ?? 0} 个文件产物`,
    };
  }
  return {
    title: name,
    detail: JSON.stringify(args),
  };
}

export { buildSystemPrompt } from './agentPlanner.js';

export class MetricAgentService {
  constructor({
    database,
    harness,
    harnessFactory,
    memory,
    skillRegistry,
    semanticCompiler,
    queryContractCompiler,
    feedback,
    growth,
    businessDatasets,
    workspace,
    codeExecution,
    semanticValues,
    userMemories,
    tokenBudget,
    config,
    indicatorService,
  }) {
    this.database = database;
    this.config = config;
    this.indicatorService = indicatorService;
    this.tokenBudget = tokenBudget ?? null;
    this.harness = harness;
    this.harnessFactory = harnessFactory;
    this.memory = memory;
    this.userMemories = userMemories;
    this.skillRegistry = skillRegistry;
    this.semanticCompiler = semanticCompiler;
    this.queryContractCompiler = queryContractCompiler ?? new QueryContractCompiler();
    this.feedback = feedback;
    this.growth = growth;
    this.businessDatasets = businessDatasets;
    this.workspace = workspace;
    this.codeExecution = codeExecution;
    this.semanticValues = semanticValues;
    this.presentationPlanner = new PresentationPlanner();
    this.runtimeCache = new AgentRuntimeCache();
  }

  async resolveThemeModel(theme, modelIdOverride = null) {
    const configuredModel = String(this.config?.deepseek?.model ?? '').trim();
    const configuredBaseUrl = String(this.config?.deepseek?.baseUrl ?? '').replace(/\/+$/, '');
    const isDefaultConfModel = (model) => Boolean(
      configuredModel
      && String(model?.modelName ?? model?.model ?? '').trim() === configuredModel
      && (!configuredBaseUrl || String(model?.baseUrl ?? '').replace(/\/+$/, '') === configuredBaseUrl),
    );
    const modelIds = (theme?.modelIds ?? []).map(Number).filter(Number.isFinite);
    const requestedModelId = modelIdOverride
      ? Number(modelIdOverride)
      : Number(theme?.defaultModelId)
        ? Number(theme.defaultModelId)
        : modelIds[0];
    if (
      modelIds.length > 0
      && requestedModelId
      && !modelIds.includes(requestedModelId)
    ) {
      throw new Error('所选模型不在当前智能体的可用模型列表中');
    }
    const modelId = requestedModelId;
    const model = modelId
      ? (this.database?.isAsyncPlatformStore
        ? await this.database.getModelAsync?.(modelId)
        : this.database?.getModel?.(modelId))
      : null;
    if (!model) {
      const fallback = theme?.llmConfig ?? {};
      return {
        ...fallback,
        isDefaultConfModel: isDefaultConfModel(fallback)
          || (!String(fallback.model ?? '').trim() && !String(fallback.baseUrl ?? '').trim()),
      };
    }
    return {
      provider: model.provider || 'deepseek',
      model: model.modelName,
      baseUrl: model.baseUrl || '',
      apiKeyEnv: model.apiKeyEnv || '',
      apiKeyEncrypted: model.apiKeyEncrypted || '',
      temperature: model.temperature ?? 0,
      maxTokens: model.maxTokens ?? 0,
      timeoutMs: model.timeoutMs ?? 60_000,
      maxToolRounds: model.maxToolRounds ?? 12,
      isDefaultConfModel: isDefaultConfModel(model),
    };
  }

  createSession({ userId, themeId, title, modelId = null }) {
    this.resolveContext(userId, themeId);
    return this.memory.createSession({ userId, themeId, title, modelId });
  }

  async createSessionAsync({ userId, themeId, title, modelId = null }) {
    await this.resolveContextAsync(userId, themeId);
    return this.memory.createSessionAsync({ userId, themeId, title, modelId });
  }

  listSessions(userId) {
    const allowedThemeIds = new Set(
      this.getThemesForUser(userId).map((theme) => Number(theme.id)),
    );
    return this.memory.listSessions(userId).filter(
      (session) => allowedThemeIds.has(Number(session.themeId)),
    );
  }

  async listSessionsAsync(userId) {
    const [themes, sessions] = await Promise.all([
      this.getThemesForUserAsync(userId),
      this.memory.listSessionsAsync(userId),
    ]);
    const allowedThemeIds = new Set(themes.map((theme) => Number(theme.id)));
    return sessions.filter((session) => allowedThemeIds.has(Number(session.themeId)));
  }

  listMessages(sessionId, userId) {
    const session = this.memory.getSession(sessionId, userId);
    this.resolveContext(userId, session.themeId);
    return this.memory.listMessages(session.id, userId, 200);
  }

  async listMessagesAsync(sessionId, userId) {
    const session = await this.memory.getSessionAsync(sessionId, userId);
    await this.resolveContextAsync(userId, session.themeId);
    return this.memory.listMessagesAsync(session.id, userId, 200);
  }

  deleteSession(sessionId, userId) {
    this.memory.getSession(sessionId, userId);
    return this.memory.deleteSession(sessionId, userId);
  }

  async deleteSessionAsync(sessionId, userId) {
    await this.memory.getSessionAsync(sessionId, userId);
    return this.memory.deleteSessionAsync(sessionId, userId);
  }

  getThemesForUser(userId) {
    const user = this.database.getUser(userId);
    if (!user) {
      return [];
    }
    const profile = this.database.getPermissionProfile(user.id);
    return this.database.listThemes()
      .filter((theme) => theme.status === 1)
      .map((theme) => {
        const scope = resolveAccessScope({ user, theme, permissionProfile: profile });
        const skills = this.skillRegistry.listForTheme(theme);
        return scope.allowed ? {
          ...theme,
          skills: skills.map((skill) => ({
            code: skill.code,
            name: skill.name,
            kind: skill.kind,
          })),
          canManage: scope.canManage,
        } : null;
      })
      .filter(Boolean);
  }

  async getThemesForUserAsync(userId) {
    const user = this.database.userRepository?.getUserAsync
      ? await this.database.userRepository.getUserAsync(userId)
      : this.database.getUser?.(userId);
    if (!user) return [];
    const [profile, themes] = await Promise.all([
      this.database.permissionRepository?.getProfile
        ? this.database.permissionRepository.getProfile(user.id)
        : this.database.getPermissionProfile?.(user.id),
      this.database.themeRepository?.listThemesAsync
        ? this.database.themeRepository.listThemesAsync()
        : this.database.listThemes?.() ?? [],
    ]);
    const result = [];
    for (const theme of themes) {
      if (Number(theme.status) !== 1) continue;
      const scope = resolveAccessScope({ user, theme, permissionProfile: profile });
      if (!scope.allowed) continue;
      const skills = this.skillRegistry.listForThemeAsync
        ? await this.skillRegistry.listForThemeAsync(theme)
        : this.skillRegistry.listForTheme(theme);
      result.push({
        ...theme,
        skills: skills.map(({ code, name, kind }) => ({ code, name, kind })),
        canManage: scope.canManage,
      });
    }
    return result;
  }

  async resolveContextAsync(userId, themeId) {
    const user = this.database.userRepository?.getUserAsync
      ? await this.database.userRepository.getUserAsync(userId)
      : this.database.getUser?.(userId);
    if (!user) throw new Error('user not found');
    const theme = this.database.themeRepository?.getThemeAsync
      ? await this.database.themeRepository.getThemeAsync(themeId)
      : this.database.getTheme?.(themeId);
    if (!theme) throw new Error('theme not found');
    const profile = this.database.permissionRepository?.getProfile
      ? await this.database.permissionRepository.getProfile(user.id)
      : this.database.getPermissionProfile?.(user.id);
    const scope = resolveAccessScope({ user, theme, permissionProfile: profile });
    if (!scope.allowed) {
      throw Object.assign(new Error(scope.reason || 'theme permission denied'), { statusCode: 403 });
    }
    const skills = this.skillRegistry.listForThemeAsync
      ? await this.skillRegistry.listForThemeAsync(theme)
      : this.skillRegistry.listForTheme(theme);
    const { businessDatasets, primaryBusinessDatasetId } = await resolveThemeBusinessDatasetsAsync({
      database: this.database, businessDatasets: this.businessDatasets, user, theme, scope,
    });
    return { user, theme, scope, skills, businessDatasets, primaryBusinessDatasetId };
  }

  async getIndicatorsForUser(userId, themeId, filters = {}) {
    const { user, theme, scope } = await this.resolveContextAsync(userId, themeId);
    const keyword = filters.keyword ?? '';
    const typeId = filters.typeId ?? '';
    const limit = Math.max(1, Math.min(Number(filters.limit) || 500, 500));
    const indicatorsInStore = await this.database.localIndicators?.listAsync({ keyword, typeId, limit, enabledOnly: true }) ?? [];
    const indicators = filterIndicatorsByScope(
      indicatorsInStore,
      scope,
    );
    return {
      user,
      theme,
      scope,
      indicators,
      total: indicators.length,
      source: 'LOCAL',
      freshAt: null,
    };
  }

  async listSemanticValueFields(themeId, overrides = null) {
    const normalizedThemeId = Number(themeId);
    const storedTheme = Number.isFinite(normalizedThemeId) && normalizedThemeId > 0
      ? await (this.database.getThemeAsync
        ? this.database.getThemeAsync(normalizedThemeId)
        : this.database.getTheme(normalizedThemeId))
      : null;
    if (normalizedThemeId > 0 && !storedTheme) {
      throw new Error('theme not found');
    }
    if (!storedTheme && !overrides) {
      throw new Error('theme not found');
    }
    const theme = {
      ...(storedTheme ?? {}),
      ...(overrides ?? {}),
      id: storedTheme?.id ?? null,
      indicatorIds: overrides?.indicatorIds
        ?? storedTheme?.indicatorIds
        ?? [],
      businessDatasetIds: overrides?.businessDatasetIds
        ?? storedTheme?.businessDatasetIds
        ?? [],
      semanticValueConfig: overrides?.semanticValueConfig
        ?? storedTheme?.semanticValueConfig
        ?? {},
      systemPrompt: overrides?.systemPrompt
        ?? storedTheme?.systemPrompt
        ?? '',
    };
    const config = normalizeSemanticValueConfig(theme.semanticValueConfig);
    const records = new Map();
    const warnings = [];
    const addDomains = async (record) => {
      const domains = theme.id
        ? await (this.database.listSemanticValueDomainsAsync
          ? this.database.listSemanticValueDomainsAsync({ themeId: theme.id, sourceType: record.sourceType, sourceId: record.sourceId, fieldName: record.fieldName })
          : this.database.listSemanticValueDomains({ themeId: theme.id, sourceType: record.sourceType, sourceId: record.sourceId, fieldName: record.fieldName }))
        : [];
      const snapshot = theme.id
        ? await (this.database.getActiveSemanticValueSnapshotAsync
          ? this.database.getActiveSemanticValueSnapshotAsync({ themeId: theme.id, sourceType: record.sourceType, sourceId: record.sourceId, fieldName: record.fieldName })
          : this.database.getActiveSemanticValueSnapshot({ themeId: theme.id, sourceType: record.sourceType, sourceId: record.sourceId, fieldName: record.fieldName }))
        : null;
      const key = semanticValueFieldKey(
        record.sourceType,
        record.sourceId,
        record.fieldName,
      );
      const configured = Object.prototype.hasOwnProperty.call(config.fields, key);
      records.set(key, {
        ...record,
        key,
        potential: isPotentialEnumField(record),
        configured,
        enabled: config.enabled
          && configured
          && config.fields[key]?.enabled !== false,
        policy: config.fields[key] ?? null,
        initialized: (snapshot?.valueCount ?? domains.length) > 0,
        valueCount: snapshot?.valueCount ?? domains.length,
        sampleSize: snapshot?.sampleSize ?? null,
        sampleValues: (snapshot?.items ?? domains)
          .slice(0, 12)
          .map((item) => item.value),
        status: snapshot?.status ?? null,
        origins: snapshot?.origins ?? [],
        refreshedAt: snapshot?.refreshedAt ?? null,
        expiresAt: snapshot?.expiresAt ?? null,
        errorMessage: snapshot?.errorMessage ?? '',
      });
    };

    for (const datasetId of theme.businessDatasetIds ?? []) {
      const dataset = await this.database.getBusinessDatasetAsync(Number(datasetId));
      if (!dataset) {
        continue;
      }
      for (const field of await this.database.listDatasetFieldsAsync(dataset.id, { enabledOnly: true })) {
        await addDomains({
          sourceType: 'DATASET',
          sourceId: String(dataset.id),
          sourceName: dataset.name,
          fieldName: field.fieldName,
          displayName: field.displayName ?? field.fieldName,
          description: field.description ?? '',
        });
      }
    }

    for (const key of Object.keys(config.fields)) {
      if (records.has(key)) {
        continue;
      }
      const [sourceType, sourceId, ...fieldParts] = key.split(':');
      const fieldName = fieldParts.join(':');
      if (!sourceType || !sourceId || !fieldName) {
        continue;
      }
      await addDomains({
        sourceType,
        sourceId,
        sourceName: sourceId,
        fieldName,
        displayName: fieldName,
        description: '',
      });
    }

    return {
      config,
      fields: [...records.values()]
        .filter((field) => field.potential || field.configured || field.initialized)
        .sort((left, right) => (
          Number(right.enabled) - Number(left.enabled)
          || Number(right.potential) - Number(left.potential)
          || left.displayName.localeCompare(right.displayName, 'zh-CN')
        )),
      warnings,
    };
  }

  async refreshSemanticValueFields(themeId) {
    const theme = await (this.database.getThemeAsync
      ? this.database.getThemeAsync(Number(themeId))
      : this.database.getTheme(Number(themeId)));
    if (!theme) {
      throw new Error('theme not found');
    }
    const warnings = [];
    for (const datasetId of theme.businessDatasetIds ?? []) {
      const dataset = await this.database.getBusinessDatasetAsync(Number(datasetId));
      if (!dataset) {
        continue;
      }
      try {
        await this.semanticValues?.initializeDataset(
          dataset,
          this.businessDatasets.getDatasetFieldsAsync(dataset.id, true),
          theme.systemPrompt,
          (field) => this.businessDatasets.listDistinctFieldValues(
            dataset.id,
            field.fieldName,
            { limit: 200 },
          ),
          theme.semanticValueConfig,
          theme.id,
          false,
          theme.semanticPolicy,
          {},
        );
      } catch (error) {
        warnings.push(`数据集 ${dataset.name} 值域刷新失败：${error.message}`);
      }
    }

    const result = await this.listSemanticValueFields(themeId);
    return {
      ...result,
      warnings: [...new Set([...warnings, ...(result.warnings ?? [])])],
    };
  }

  async refreshSemanticValueDomain({
    themeId,
    sourceType,
    sourceId,
    fieldName,
  }) {
    const theme = await (this.database.getThemeAsync
      ? this.database.getThemeAsync(Number(themeId))
      : this.database.getTheme(Number(themeId)));
    if (!theme) {
      throw new Error('theme not found');
    }
    const normalizedSourceType = String(sourceType ?? '').toUpperCase();
    if (normalizedSourceType !== 'DATASET') {
      throw new Error('当前值域治理只支持业务数据集字段');
    }
    const dataset = await this.database.getBusinessDatasetAsync(Number(sourceId));
    if (!dataset || !(theme.businessDatasetIds ?? []).map(Number).includes(Number(sourceId))) {
      throw new Error('business dataset permission denied');
    }
    const field = (await this.businessDatasets.getDatasetFieldsAsync(dataset.id, true))
      .find((item) => item.fieldName === fieldName);
    if (!field) {
      throw new Error('dataset field not found');
    }
    const jobInput = {
      themeId: theme.id,
      sourceType: normalizedSourceType,
      sourceId: String(sourceId),
      fieldName: String(fieldName),
      trigger: 'MANUAL',
    };
    const jobId = this.database.createSemanticValueRefreshJobAsync
      ? await this.database.createSemanticValueRefreshJobAsync(jobInput)
      : this.database.createSemanticValueRefreshJob(jobInput);
    const updateJob = (update) => this.database.updateSemanticValueRefreshJobAsync
      ? this.database.updateSemanticValueRefreshJobAsync(jobId, update)
      : Promise.resolve(this.database.updateSemanticValueRefreshJob(jobId, update));
    await updateJob({
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });
    try {
      await this.semanticValues?.initializeDataset(
        dataset,
        [field],
        theme.systemPrompt,
        (currentField) => this.businessDatasets.listDistinctFieldValues(
          dataset.id,
          currentField.fieldName,
          { limit: 200 },
        ),
        theme.semanticValueConfig,
        theme.id,
        false,
        theme.semanticPolicy,
        {},
      );
      const snapshotInput = {
        themeId: theme.id,
        sourceType: normalizedSourceType,
        sourceId: String(sourceId),
        fieldName: String(fieldName),
      };
      const snapshot = this.database.getActiveSemanticValueSnapshotAsync
        ? await this.database.getActiveSemanticValueSnapshotAsync(snapshotInput)
        : this.database.getActiveSemanticValueSnapshot(snapshotInput);
      await updateJob({
        status: 'SUCCESS',
        scannedCount: snapshot?.sampleSize ?? snapshot?.valueCount ?? 0,
        changedCount: snapshot?.valueCount ?? 0,
        finishedAt: new Date().toISOString(),
      });
      this.runtimeCache?.semanticContexts?.invalidate('semantic-context');
      return snapshot;
    } catch (error) {
      await updateJob({
        status: 'FAILED',
        error: { message: error.message },
        finishedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  async saveSemanticValueOverride(payload = {}) {
    const theme = await (this.database.getThemeAsync
      ? this.database.getThemeAsync(Number(payload.themeId))
      : this.database.getTheme(Number(payload.themeId)));
    if (!theme) {
      throw new Error('theme not found');
    }
    const normalizedSourceType = String(payload.sourceType ?? '').toUpperCase();
    if (normalizedSourceType !== 'DATASET') {
      throw new Error('当前值域治理只支持业务数据集字段');
    }
    const dataset = await this.database.getBusinessDatasetAsync(Number(payload.sourceId));
    if (!dataset || !(theme.businessDatasetIds ?? []).map(Number).includes(Number(payload.sourceId))) {
      throw new Error('business dataset permission denied');
    }
    const field = (await this.businessDatasets.getDatasetFieldsAsync(dataset.id, true))
      .find((item) => item.fieldName === payload.fieldName);
    if (!field) {
      throw new Error('dataset field not found');
    }
    const overrideInput = {
      themeId: theme.id,
      sourceType: normalizedSourceType,
      sourceId: String(payload.sourceId),
      fieldName: String(payload.fieldName),
      concept: String(payload.concept ?? ''),
      aliases: payload.aliases ?? [],
      operator: payload.operator ?? 'IN',
      configuredValues: payload.configuredValues ?? [],
      ruleSource: payload.ruleSource ?? '',
      action: payload.action ?? 'ENUM_MAPPING',
      allowUnverified: payload.allowUnverified === true,
      enabled: payload.enabled !== false,
      updatedBy: payload.updatedBy ?? null,
    };
    const result = this.database.saveSemanticValueOverrideAsync
      ? await this.database.saveSemanticValueOverrideAsync(overrideInput)
      : this.database.saveSemanticValueOverride(overrideInput);
    this.runtimeCache?.semanticContexts?.invalidate('semantic-context');
    return result;
  }

  // 停用主题必须真正退出问数链路：列表已隐藏，客户端直接带 themeId 也要拒绝。
  requireEnabledTheme(theme) {
    if (Number(theme?.status ?? 1) === 0) {
      throw Object.assign(
        new Error(`主题「${theme.name ?? theme.id}」已停用，暂不可发起问数`),
        { statusCode: 409 },
      );
    }
  }

  async getSessionDirectives(sessionId) {
    const record = await callPlatformDatabase(this.database, 'getPlatformSettingAsync', 'getPlatformSetting', `chat_session_directives:${Number(sessionId)}`, null);
    return Array.isArray(record?.value?.directives) ? record.value.directives : [];
  }

  async saveSessionDirective(sessionId, userId, directive) {
    if (!directive) {
      return this.getSessionDirectives(sessionId);
    }
    const key = `chat_session_directives:${Number(sessionId)}`;
    const setting = await callPlatformDatabase(this.database, 'getPlatformSettingAsync', 'getPlatformSetting', key, null);
    const current = setting?.value ?? {};
    const directives = mergeSessionDirectives(current.directives ?? [], directive);
    const value = {
      sessionId: Number(sessionId),
      userId: Number(userId),
      directives,
      updatedAt: new Date().toISOString(),
    };
    await callPlatformDatabase(this.database, 'savePlatformSettingAsync', 'savePlatformSetting', key, value);
    return directives;
  }

  resolveContext(userId, themeId) {
    const user = this.database.getUser(userId);
    if (!user) {
      throw new Error('user not found');
    }
    const theme = this.database.getTheme(themeId);
    if (!theme) {
      throw new Error('theme not found');
    }
    const profile = this.database.getPermissionProfile(user.id);
    const scope = resolveAccessScope({ user, theme, permissionProfile: profile });
    if (!scope.allowed) {
      throw Object.assign(new Error(scope.reason || 'theme permission denied'), { statusCode: 403 });
    }
    const skills = this.skillRegistry.listForTheme(theme);
    const { businessDatasets, primaryBusinessDatasetId } = resolveThemeBusinessDatasets({
      database: this.database,
      businessDatasets: this.businessDatasets,
      user,
      theme,
      scope,
    });
    return {
      user,
      theme,
      scope,
      skills,
      businessDatasets,
      primaryBusinessDatasetId,
    };
  }

  async setSessionDirectiveAsync(sessionId, userId, directive) {
    const key = `chat_session_directives:${Number(sessionId)}`;
    const setting = await callPlatformDatabase(this.database, 'getPlatformSettingAsync', 'getPlatformSetting', key, null);
    const directives = mergeSessionDirectives(setting?.value?.directives ?? [], directive);
    const value = { sessionId: Number(sessionId), userId: Number(userId), directives, updatedAt: new Date().toISOString() };
    await callPlatformDatabase(this.database, 'savePlatformSettingAsync', 'savePlatformSetting', key, value);
    return directives;
  }

  async answer(options = {}) {
    const runTraceId = normalizeTraceId(options?.traceId)
      ?? currentTraceId()
      ?? createTraceId();
    if (currentTraceId() === runTraceId) {
      return this.answerWithTrace(options, runTraceId);
    }
    return runWithTrace(
      runTraceId,
      () => this.answerWithTrace(options, runTraceId),
    );
  }

  async _runOnce({
    userId,
    themeId,
    sessionId,
    question,
    preferredChart = 'auto',
    clarificationOptionId = '',
    clarificationOptionLabel = '',
    modelId = null,
    attachmentArtifactIds = [],
    forceNewTask = false,
    signal = null,
    onEvent = null,
    replanDepth = 0,
    replanHint = '',
    carryForward = null,
    suppressUserMessage = false,
    recoveryMode = false,
  }, runTraceId = currentTraceId()) {
    const normalizedQuestion = String(question ?? '').trim();
    if (normalizedQuestion.length < 2) {
      throw new Error('question is required');
    }
    let eventSequence = 0;
    const emit = (event) => {
      if (typeof onEvent !== 'function') {
        return;
      }
      try {
        onEvent({
          seq: eventSequence += 1,
          timestamp: new Date().toISOString(),
          traceId: runTraceId,
          ...event,
        });
      } catch {
        // A disconnected stream must not interrupt the query.
      }
    };
    const progressiveAnswer = createProgressiveAnswerEmitter(emit);
    if (replanDepth === 0) {
      emit({
        type: 'run_started',
        question: normalizedQuestion,
        userId,
        themeId: themeId ?? null,
      });
    }
    let session = null;
    if (sessionId) {
      session = await this.memory.getSessionAsync(sessionId, userId);
    } else {
      const requestedThemeId = Number(themeId);
      if (!Number.isFinite(requestedThemeId) || requestedThemeId <= 0) {
        throw new Error('themeId is required when creating a chat session');
      }
      const preflight = await this.resolveContextAsync(userId, requestedThemeId);
      this.requireEnabledTheme(preflight.theme);
      const requestedModelId = modelId
        ? Number(modelId)
        : preflight.theme.defaultModelId
          ? Number(preflight.theme.defaultModelId)
          : null;
      if (
        requestedModelId
        && (preflight.theme.modelIds ?? []).length > 0
        && !(preflight.theme.modelIds ?? []).map(Number).includes(requestedModelId)
      ) {
        throw new Error('所选模型不在当前智能体的可用模型列表中');
      }
      session = await this.createSessionAsync({
        userId,
        themeId: requestedThemeId,
        modelId: requestedModelId,
      });
    }
    if (themeId && Number(session.themeId) !== Number(themeId)) {
      throw new Error('chat session does not belong to the selected theme');
    }
    if (
      modelId
      && session.messageCount > 0
      && Number(session.modelId) !== Number(modelId)
    ) {
      throw new Error('会话已经产生对话，模型已锁定，请新建会话后再切换模型');
    }
    if (
      modelId
      && session.messageCount === 0
      && Number(session.modelId) !== Number(modelId)
    ) {
      session = await callPlatformDatabase(this.database, 'updateChatSessionAsync', 'updateChatSession', session.id, {
        modelId: Number(modelId),
      }) ?? session;
    }
    const titledSession = await this.memory.maybeSetInitialTitleAsync(
      session.id,
      normalizedQuestion,
    ) ?? session;
    const workspace = await this.workspace?.ensureForSessionAsync({
      userId,
      themeId: session.themeId,
      sessionId: session.id,
      name: buildSessionFileName(
        titledSession.title === '新会话'
          ? normalizedQuestion
          : titledSession.title,
      ),
    }) ?? null;
    const {
      user,
      theme,
      scope,
      skills,
      businessDatasets,
      primaryBusinessDatasetId,
    } = await this.resolveContextAsync(userId, session.themeId);
    // P0-4：问数入口的 Token 成本预算闸门。未配置预算（limit=0）时自动放行。
    if (this.tokenBudget) {
      const budgetResult = await (this.tokenBudget.checkAsync
        ? this.tokenBudget.checkAsync({
        userId: user.id,
        themeId: theme.id,
        themeLimit: Number(theme.budgetTokens ?? theme.llmConfig?.budgetTokens ?? 0) || 0,
        })
        : this.tokenBudget.check({
          userId: user.id,
          themeId: theme.id,
          themeLimit: Number(theme.budgetTokens ?? theme.llmConfig?.budgetTokens ?? 0) || 0,
        }));
      if (budgetResult.enforced && !budgetResult.ok) {
        throw tokenBudgetError(budgetResult.used, budgetResult.limit);
      }
    }
    this.requireEnabledTheme(theme);
    const activeHarness = this.harnessFactory
      ? this.harnessFactory.forTheme(
        await this.resolveThemeModel(
          theme,
          session.modelId ?? modelId,
        ),
      )
      : this.harness;
    const memoryPreInject = await resolveMemoryPreInject({
      config: this.config,
      userMemories: this.userMemories,
      userId: user.id,
      themeId: theme.id,
      question: normalizedQuestion,
    });
    const {
      history,
      conversationContext,
      executionContext,
    } = await resolveConversationRuntime({
      memory: this.memory,
      sessionId: session.id,
      userId,
      question: normalizedQuestion,
      forceNewTask,
      harness: activeHarness,
      theme,
      user,
      signal,
      memoryTexts: [memoryPreInject],
    });
    const resolvedQuestion = conversationContext.question;
    const existingSessionDirectives = await this.getSessionDirectives(session.id);
    const conversationDirective = conversationContext.conversationDirective
      ?? (conversationContext.turnType === TURN_TYPES.INSTRUCTION
        ? parseConversationDirective(conversationContext.originalQuestion)
        : null);
    const sessionDirectives = conversationDirective
      ? mergeSessionDirectives(existingSessionDirectives, conversationDirective)
      : existingSessionDirectives;
    const analysisMode = inferAnalysisMode(resolvedQuestion);
    const localIndicatorMode = true;
    const clarificationPolicy = resolveClarificationPolicy(
      conversationContext.mode === 'FOLLOW_UP' ? history : [],
      analysisMode.mode,
    );
    emit({ type: 'context_resolved', context: publicContextDecision(conversationContext) });
    emit({
      type: 'runtime_selected',
      runtime: {
        mode: activeHarness.mode ?? 'unknown',
        model: activeHarness.model ?? null,
        provider: activeHarness.provider ?? activeHarness.mode ?? 'unknown',
        configured: activeHarness.mode !== 'local-rule',
      },
      source: {
        mode: 'local',
        configured: false,
      },
    });
    if (localIndicatorMode) {
      emit({
        type: 'warning',
        code: 'LOCAL_INDICATOR_QUERY_UNSUPPORTED',
        message: '未检测到对应的指标，本轮采用大模型直连业务数据模式。',
      });
    } else if (false) {
      emit({
        type: 'warning',
        code: 'LOCAL_INDICATOR_QUERY_UNSUPPORTED',
        message: '本轮优先使用已接入的真实业务数据集。',
      });
    }
    if (activeHarness.mode === 'local-rule') {
      emit({
        type: 'warning',
        code: 'LLM_NOT_CONFIGURED',
        message: 'LLM API Key 未配置，本轮使用本地规则引擎执行。',
      });
    }
    let allowedIndicators = [];
    let indicatorSourceState;
    try {
      const localPage = await this.runtimeCache.catalog.getOrSet(
        'catalog',
        'page-500',
        async () => this.indicatorService.listCatalog({
          current: 1,
          pageSize: 500,
        }),
        { ttlMs: 60_000 },
      );
      allowedIndicators = sortIndicators(
        filterIndicatorsByScope(
          (localPage.list ?? []).map(normalizeIndicatorSummary),
          scope,
        ),
      );
      indicatorSourceState = describeIndicatorSource({ local: true });
    } catch (error) {
      indicatorSourceState = describeIndicatorSource();
      emit({
        type: 'warning',
        code: 'INDICATOR_SOURCE_UNAVAILABLE',
        message: `读取本地指标目录失败：${error.message}`,
      });
    }
    emit({
      type: 'indicator_source',
      source: indicatorSourceState.source,
      freshAt: indicatorSourceState.freshAt,
      snapshotCount: indicatorSourceState.snapshotCount,
    });
    const feedbackHints = this.feedback
      ? await (this.feedback.promptHintsAsync?.(theme.id, 8) ?? this.feedback.promptHints(theme.id, 8))
      : [];
    const workflow = new DataAgentWorkflow({
      question: normalizedQuestion,
      user,
      theme,
      onEvent: emit,
    });
    if (!suppressUserMessage) {
      await appendUserQuestionWithAttachmentsAsync({
        memory: this.memory,
        workspace: this.workspace,
        session,
        user,
        question: normalizedQuestion,
        displayQuestion: clarificationOptionLabel,
        artifactIds: attachmentArtifactIds,
      });
    }
    const answerStartedAt = Date.now();
    const carriedExecutions = Array.isArray(carryForward?.executions)
      ? carryForward.executions
      : [];
    const carriedExecutionCount = carriedExecutions.length;
    let lastQueryResult = carryForward?.data ?? null;
    let lastChart = carryForward?.chart ?? null;
    let lastIndicator = carryForward?.indicator ?? null;
    let lastBusinessDataset = carryForward?.dataset ?? null;
    let lastSemanticParse = carryForward?.semanticParse ?? null;
    let skillAudit = null;
    let resultValidation = null;
    let resultAnalysis = null;
    const lockedExecutions = new Map();
    const queryExecutions = [...carriedExecutions];
    let lastLockedExecution = carryForward?.lockedExecution ?? null;
    const toolTrace = [];
    const processSteps = [];
    const generatedCodeArtifacts = [];
    const generatedWorkspaceArtifactIds = [];
    const saveQueryPlan = (input) => callPlatformDatabase(this.database, 'saveQueryPlanAsync', 'saveQueryPlan', input);
    // 每个产生数据的工具环节都会落一份过程文件，便于用户按步骤追踪核查。
    const recordProcessArtifact = createProcessArtifactRecorderAsync({
      service: this.workspace,
      workspaceId: workspace?.id ?? null,
      userId: user.id,
      sessionId: session.id,
      emit,
      artifactIds: generatedWorkspaceArtifactIds,
    });
    const appendProcessStep = (step) => {
      processSteps.push(step);
      emit({
        type: 'process_step',
        step: { ...step },
      });
      return step;
    };
    const startWorkflowStage = (code, summary = '') => {
      const stage = workflow.stageMap.get(code);
      if (!stage || stage.status === 'RUNNING' || stage.status === 'SUCCESS') {
        return stage;
      }
      return workflow.start(code, summary);
    };
    const completeWorkflowStage = (code, options = {}) => {
      const stage = workflow.stageMap.get(code);
      if (!stage || stage.status === 'SUCCESS') {
        return stage;
      }
      if (stage.status !== 'RUNNING') {
        workflow.start(code, options.summary ?? '');
      }
      return workflow.complete(code, options);
    };
    const failWorkflowStage = (code, error) => {
      const stage = workflow.stageMap.get(code);
      if (!stage || stage.status === 'SUCCESS') {
        return stage;
      }
      if (stage.status !== 'RUNNING') {
        workflow.start(code);
      }
      return workflow.fail(code, error);
    };
    const persistQueryArtifact = async ({
      sourceType,
      source,
      indicator = null,
      dataset = null,
      data,
      chart,
      semanticParse,
      question,
      resolvedQuestion,
      queryFingerprint,
      dataHash,
      inputArtifactIds = [],
    }) => {
      if (!workspace || !this.workspace) {
        return null;
      }
      const artifact = this.workspace.createResultArtifactAsync
        ? await this.workspace.createResultArtifactAsync({
        workspaceId: workspace.id,
        userId: user.id,
        sessionId: session.id,
        messageId: null,
        conversationId: null,
        artifactType: 'QUERY_RESULT',
        inputArtifactIds,
        source: {
          type: sourceType,
          ...source,
        },
        answer: {
          indicator,
          dataset,
          data,
          chart,
          semanticParse,
          question,
          resolvedQuestion,
          queryFingerprint,
          dataHash,
        },
        })
        : this.workspace.createResultArtifact({
          workspaceId: workspace.id,
          userId: user.id,
          sessionId: session.id,
          messageId: null,
          conversationId: null,
          artifactType: 'QUERY_RESULT',
          inputArtifactIds,
          source: { type: sourceType, ...source },
          answer: { indicator, dataset, data, chart, semanticParse, question, resolvedQuestion, queryFingerprint, dataHash },
        });
      generatedWorkspaceArtifactIds.push(artifact.id);
      return artifact;
    };
    completeWorkflowStage('INTENT', {
      summary: analysisMode.mode === 'ATTRIBUTION'
        ? '识别为归因分析问题'
        : businessDatasets.length > 0
          ? '识别为业务数据集分析问题'
          : '识别为指标分析问题',
      detail: resolvedQuestion === normalizedQuestion
        ? `主题：${theme.name}；分析模式：${analysisMode.mode}；澄清剩余：${clarificationPolicy.remaining}`
        : `主题：${theme.name}；分析模式：${analysisMode.mode}；上下文模式：${conversationContext.mode}；澄清剩余：${clarificationPolicy.remaining}；已补齐问题：${resolvedQuestion}`,
    });
    startWorkflowStage('SEMANTIC_RESOLVE', '解析指标与业务语义候选');
    const initialSemanticResolutions = (theme.semanticPolicy?.metrics ?? [])
      .filter((rule) => [...(rule.aliases ?? []), rule.concept].some((alias) => (
        alias && resolvedQuestion.includes(alias)
      )))
      .map((rule) => resolveWithPlugins({
        concept: rule.concept,
        candidates: allowedIndicators,
        policy: theme.semanticPolicy,
      }));
    completeWorkflowStage('SEMANTIC_RESOLVE', {
      summary: `${initialSemanticResolutions.length} 个语义概念进入候选裁决`,
      detail: initialSemanticResolutions.map((resolution) => (
        `${resolution.concept}: ${resolution.adjudication.status}`
      )).join('；') || '当前问题未命中主题指标语义包',
      evidence: initialSemanticResolutions.map((resolution) => ({
        type: 'SEMANTIC_RESOLUTION',
        concept: resolution.concept,
        adjudication: resolution.adjudication,
        candidateCount: resolution.candidates.length,
      })),
    });
    const confirmationState = {
      indicatorSearchCompleted: false,
      confirmedIndicatorIds: new Set(),
      confirmedDatasetIds: new Set(),
      indicatorDetails: new Map(),
      datasetDefinitions: new Map(),
    };
    const compiledContracts = new Map();
    let invalidContractAttempts = 0;
    // 本轮契约编译里出现的「过滤值未唯一命中」候选值：它比其它阻塞项优先，
    // 因为用户必须先选定具体值，后面的口径问题才有可能问对。
    let pendingValueCandidates = [];
    let pendingSemanticSpans = [];
    // 模型通过 request_clarification 提出的确认问题：由平台渲染成可点选选项，
    // 避免它自己写一大段内部术语。
    let pendingModelClarification = null;

    const searchIndicators = (keyword, limit = 6) => {
      startWorkflowStage('SEMANTIC_DISCOVERY', '检索主题指标');
      confirmationState.indicatorSearchCompleted = true;
      const ranked = rankIndicators(
        allowedIndicators,
        keyword,
        limit,
        resolveBusinessLexicon(theme),
        theme.systemPrompt,
      );

      const list = (
        ranked.length > 0
          ? ranked.map((item) => item.indicator)
          : sortIndicators(allowedIndicators)
      )
        .slice(0, Math.max(1, Math.min(Number(limit) || 6, 20)));
      completeWorkflowStage('SEMANTIC_DISCOVERY', {
        summary: ranked.length > 0
          ? `检索到 ${ranked.length} 个相关指标`
          : '未精确命中指标，使用主题指标候选集',
        detail: list.map((indicator) => indicator.name).join('、'),
      });
      if (ranked.length === 0) {
        this.growth?.record({
          term: keyword,
          kind: 'QUESTION',
          source: 'AGENT_SEARCH',
          context: { themeId: theme.id, userId: user.id, sessionId: session.id },
        });
      }
      return {
        indicators: list.map((indicator) => ({
          id: String(indicator.id),
          name: indicator.name,
          bizName: indicator.bizName,
          typeName: indicator.typeName,
          description: indicator.description,
          businessCaliber: indicator.businessCaliber,
          metrics: (indicator.metrics ?? []).map((metric2) => ({
            name: metric2.metricName ?? metric2.name,
            bizName: metric2.metricBizName ?? metric2.bizName,
          })),
          dimensions: (indicator.dimensions ?? []).map((dimension) => ({
            name: dimension.dimensionName ?? dimension.name,
            bizName: dimension.dimensionBizName ?? dimension.bizName,
          })),
        })),
      };
    };

    const getIndicator = async (indicatorId) => {
      startWorkflowStage('SEMANTIC_CONFIRM', '读取指标口径');
      if (!canAccessIndicator(scope, indicatorId)) {
        throw new Error('indicator permission denied');
      }
      const detail = await this.runtimeCache.indicatorDetails.getOrSet(
        'indicator-detail',
        String(indicatorId),
        async () => this.indicatorService.getIndicator(indicatorId),
        { ttlMs: 120_000 },
      );
      const normalized = normalizeDetail({ id: String(indicatorId) }, detail);
      const semanticKey = buildCacheKey({
        themeId: theme.id,
        indicatorId: String(indicatorId),
        prompt: theme.systemPrompt,
        config: theme.semanticValueConfig,
        semanticPolicy: theme.semanticPolicy,
        scope,
      });
      const initialized = this.semanticValues
        ? await this.runtimeCache.semanticContexts.getOrSet(
          'semantic-context',
          `indicator:${semanticKey}`,
          async () => this.semanticValues.initializeIndicator(
            normalized,
            theme.systemPrompt,
            null,
            theme.semanticValueConfig,
            theme.id,
            true,
            theme.semanticPolicy,
            scope,
          ),
          { ttlMs: 300_000 },
        )
        : normalized;
      const dimensions = filterDimensionsByScope(initialized.dimensions, scope);
      confirmationState.confirmedIndicatorIds.add(String(indicatorId));
      confirmationState.indicatorDetails.set(String(indicatorId), {
        ...initialized,
        dimensions,
      });
      completeWorkflowStage('SEMANTIC_CONFIRM', {
        summary: `确认指标「${initialized.name}」口径`,
        detail: `${initialized.metrics?.length ?? 0} 个指标字段，${dimensions.length} 个可用维度，${
          dimensions.filter((dimension) => (dimension.values ?? []).length > 0).length
        } 个字段完成默认值域初始化`,
        evidence: [
          {
            type: 'INDICATOR',
            id: String(initialized.id),
            name: initialized.name,
            businessCaliber: initialized.businessCaliber ?? '',
          },
        ],
      });
      return {
        id: String(initialized.id),
        name: initialized.name,
        bizName: initialized.bizName,
        businessCaliber: initialized.businessCaliber,
        description: initialized.description,
        metrics: (initialized.metrics ?? []).map((metric2) => ({
          name: metric2.metricName ?? metric2.name,
          bizName: metric2.metricBizName ?? metric2.bizName,
          description: metric2.description,
        })),
        dimensions: dimensions.map((dimension) => ({
          name: dimension.dimensionName ?? dimension.name,
          bizName: dimension.dimensionBizName ?? dimension.bizName,
          description: dimension.description,
          values: dimension.values ?? [],
          valueAliases: dimension.valueAliases ?? {},
          valueSource: dimension.valueDomain?.source ?? [],
        })),
      };
    };

    const runQuery = async (args) => {
      if (!canAccessIndicator(scope, args.indicatorId)) {
        throw new Error('indicator permission denied');
      }
      if (!confirmationState.indicatorSearchCompleted) {
        const error = new Error('必须完成指标搜索后才能执行指标查询');
        failWorkflowStage('SEMANTIC_DISCOVERY', error);
        throw error;
      }
      if (!confirmationState.confirmedIndicatorIds.has(String(args.indicatorId))) {
        const error = new Error('必须确认指标口径和可用维度后才能执行指标查询');
        failWorkflowStage('SEMANTIC_CONFIRM', error);
        throw error;
      }
      const executionKey = args.__contract?.id ?? null;
      const reusedExecution = executionKey
        ? lockedExecutions.get(executionKey)
        : null;
      if (reusedExecution) {
        appendProcessStep({
        id: `step-${processSteps.length + 1}`,
        type: 'reuse',
        stageCode: 'EXECUTE',
          status: 'success',
          name: 'reuse_locked_result',
          skillCode: 'indicator_query',
          skillName: '结果锁定',
          title: '复用首个有效结果',
          detail: `已复用查询 ${reusedExecution.queryFingerprint.slice(0, 12)} 的数据快照`,
          durationMs: 0,
        });
        return reusedExecution.toolResult;
      }
      const confirmedIndicator = confirmationState.indicatorDetails.get(
        String(args.indicatorId),
      );
      const indicator = confirmedIndicator
        ?? normalizeDetail(
          { id: String(args.indicatorId) },
          await this.runtimeCache.indicatorDetails.getOrSet(
            'indicator-detail',
            String(args.indicatorId),
            async () => this.indicatorService.getIndicator(args.indicatorId),
            { ttlMs: 120_000 },
          ),
        );
      const allowedDetailDimensions = filterDimensionsByScope(indicator.dimensions ?? [], scope);
      const boundContract = args.__contract ?? null;
      const requestedMetrics = boundContract
        ? boundContract.metricFields.map((metric) => metric.field)
        : mapRequestedMetrics(args.metricNames ?? [], indicator.metrics ?? []);
      const requestedDimensions = boundContract
        ? boundContract.dimensionFields.map((dimension) => dimension.field)
        : mapRequestedDimensions(
          args.dimensions ?? [],
          allowedDetailDimensions,
        );
      const inferredDateField = selectDateField(allowedDetailDimensions);
      const inferred = boundContract
        ? {
          metrics: requestedMetrics,
          dimensions: requestedDimensions,
          limit: boundContract.limit,
          timeGrain: boundContract.timeGrain,
          order: boundContract.order ?? [],
          aggregationIntent: requestedDimensions.length > 0 ? 'GROUP' : 'SUMMARY',
        }
        : inferIndicatorQuerySpec({
          question: resolvedQuestion,
          metrics: indicator.metrics ?? [],
          dimensions: allowedDetailDimensions,
          fallbackMetrics: requestedMetrics.length > 0
            ? requestedMetrics
            : metricVariables(indicator.metrics ?? []).bizNames.slice(0, 4),
          fallbackDimensions: requestedDimensions,
          dateField: inferredDateField,
          lexicon: resolveBusinessLexicon(theme),
          vocabularyResolver: ({ question: source }) => this.skillRegistry.resolveCoreSkill(
            'business_vocabulary',
            { question: source },
            skills,
          ),
        });
      const metricNames = inferred.metrics;
      let dimensions = assertAllowedDimensions(
        inferred.dimensions,
        allowedDetailDimensions,
        scope,
      );
      if (metricNames.length === 0) {
        throw new Error('indicator has no queryable metric');
      }
      const vocabulary = this.skillRegistry.resolveCoreSkill(
        'business_vocabulary',
        { question: resolvedQuestion },
        skills,
      );
      const queryLimit = inferred.limit ?? vocabulary?.limit ?? resolveQueryLimit(resolvedQuestion);

      const timeWindows = boundContract?.timeWindows?.length
        ? boundContract.timeWindows.map((window) => normalizeDateInfo({
          ...window,
          dateField: window.dateField ?? inferredDateField,
        }))
        : [
          this.skillRegistry.resolveCoreSkill(
            'temporal_expression',
            { question: resolvedQuestion },
            skills,
          )
          ?? normalizeDateInfo(args.dateRange),
        ];
      const dateInfo = timeWindows[0];
      dateInfo.dateField ??= inferredDateField;
      const effectiveFilters = boundContract
        ? boundContract.filterFields.map((filter) => ({
          bizName: filter.field,
          operator: filter.operator,
          value: filter.value,
          source: 'CONTRACT',
        }))
        : mergeSemanticFilters(args.filters ?? [], []);
      if (dateInfo.dateField && dimensions.some(isDateDimensionName)) {
        const preferredDateDimension = mapRequestedDimensions(
          [dateInfo.dateField],
          allowedDetailDimensions,
        )[0];
        if (preferredDateDimension) {
          dimensions = [...new Set(dimensions.map((dimension) => (
            isDateDimensionName(dimension) ? preferredDateDimension : dimension
          )))];
        }
      }
      startWorkflowStage('PLAN', '生成查询计划');
      const compileStartedAt = Date.now();
      const compiledPlan = this.semanticCompiler.compile({
        question: resolvedQuestion,
        indicator,
        metrics: metricNames,
        dimensions,
        filters: effectiveFilters,
        dateInfo,
        limit: queryLimit,
        source: activeHarness?.mode === 'local-rule' ? 'RULE' : 'LLM',
      });
      const compileDurationMs = Date.now() - compileStartedAt;
      appendProcessStep({
        id: `step-${processSteps.length + 1}`,
        type: 'plan',
        stageCode: 'PLAN',
        status: 'success',
        name: 'compile_semantic_plan',
        skillCode: 'indicator_query',
        skillName: '语义编译',
        title: '编译查询计划',
        detail: `${indicator.name}，指标 ${metricNames.join('、')}，维度 ${
          dimensions.join('、') || '汇总'
        }`,
        durationMs: compileDurationMs,
      });
      completeWorkflowStage('PLAN', {
        summary: `生成「${indicator.name}」查询计划`,
        detail: `指标 ${metricNames.join('、')}；维度 ${dimensions.join('、') || '汇总'}`,
        evidence: [{ type: 'PLAN', id: compiledPlan.id, intent: compiledPlan.intent }],
      });
      startWorkflowStage('VALIDATE', '校验查询计划');
      const validationStartedAt = Date.now();
      const validation = this.semanticCompiler.validate(compiledPlan, {
        indicator,
        allowedDimensions: allowedDetailDimensions.map(
          (dimension) => dimension.dimensionBizName ?? dimension.bizName,
        ),
        scope,
      });
      const validationDurationMs = Date.now() - validationStartedAt;
      appendProcessStep({
        id: `step-${processSteps.length + 1}`,
        type: 'validation',
        stageCode: 'VALIDATE',
        status: validation.valid ? 'success' : 'error',
        name: 'validate_semantic_plan',
        skillCode: 'indicator_query',
        skillName: '计划校验',
        title: '校验白名单与权限',
        detail: validation.valid
          ? `通过 ${validation.checks.length} 项校验`
          : validation.issues.map((issue) => issue.message).join('；'),
        durationMs: validationDurationMs,
      });
      if (validation.valid) {
        completeWorkflowStage('VALIDATE', {
          summary: '指标、维度、数据集和权限校验通过',
          detail: validation.checks.join('、'),
        });
      } else {
        failWorkflowStage(
          'VALIDATE',
          new Error(validation.issues.map((issue) => issue.message).join('；')),
        );
      }
      if (!validation.valid) {
        this.growth?.record({
          term: normalizedQuestion,
          kind: 'QUERY_PATTERN',
          source: 'PLAN_VALIDATION',
          context: {
            themeId: theme.id,
            userId: user.id,
            sessionId: session.id,
            planId: compiledPlan.id,
            issues: validation.issues,
          },
        });
        await saveQueryPlan({
          id: compiledPlan.id,
          userId: user.id,
          themeId: theme.id,
          sessionId: session.id,
          question: resolvedQuestion,
          status: 'REJECTED',
          plan: compiledPlan,
          validation,
        });
        const validationError = new Error(
          `主题配置或字段白名单需要调整：${
            validation.issues.map((issue) => issue.message).join('；')
          }`,
        );
        validationError.terminal = true;
        validationError.code = 'PLAN_VALIDATION_FAILED';
        throw validationError;
      }
      const effectivePlan = this.semanticCompiler.bindPermissions(compiledPlan, scope);
      effectivePlan.timeWindows = timeWindows;
      effectivePlan.calculation = boundContract?.calculation ?? { type: 'NONE' };
      effectivePlan.contractId = boundContract?.id ?? null;
      effectivePlan.queryContract = boundContract ?? null;
      effectivePlan.compilerVersion = boundContract?.compilerVersion ?? null;
      const queryContractFilters = boundContract
        ? boundContract.filterFields.map((filter) => ({
          field: filter.field,
          operator: filter.operator,
          value: filter.value,
          scope: filter.scope ?? 'ROW',
          source: 'AGENT',
        }))
        : effectivePlan.filters;
      const queryContract = buildQueryContract({
        indicatorId: indicator.id,
        metrics: metricNames,
        derivedMetrics: boundContract?.derivedMetrics ?? [],
        dimensions: timeWindows.length > 1 ? [...dimensions, '__period'] : dimensions,
        filters: queryContractFilters,
        dateInfo,
        timeGrain: inferred.timeGrain,
        limit: effectivePlan.limit,
        timeWindows,
        calculation: effectivePlan.calculation,
        periodOrder: timeWindows.map((window, index) => (
          window.detectWord || window.expression || window.label || `期间${index + 1}`
        )),
        analysisMode: boundContract?.analysisMode,
        attribution: boundContract?.attribution,
        semanticPolicy: boundContract?.semanticPolicy,
        semanticResolutions: boundContract?.semanticResolutions,
        internalMetrics: boundContract?.internalMetrics,
        analysisPipeline: boundContract?.analysisPipeline,
        limitPolicy: boundContract?.limitPolicy,
      });
      const fingerprint = queryFingerprint(queryContract);
      const fingerprintExecution = lockedExecutions.get(fingerprint);
      if (fingerprintExecution) {
        appendProcessStep({
          id: `step-${processSteps.length + 1}`,
          type: 'reuse',
          stageCode: 'EXECUTE',
          status: 'success',
          name: 'reuse_locked_result',
          skillCode: 'indicator_query',
          skillName: '结果复用',
          title: '复用查询快照',
          detail: `查询指纹 ${fingerprint.slice(0, 12)} 已存在，直接复用工作区数据`,
          durationMs: 0,
        });
        return fingerprintExecution.toolResult;
      }
      emit({
        type: 'execution_selected',
        source: {
          mode: this.indicatorService.mode === 'local'
            ? 'local-indicator-catalog'
            : 'unconfigured-indicator',
          configured: true,
          indicatorId: String(indicator.id),
          indicatorName: indicator.name,
          queryFingerprint: fingerprint,
        },
      });
      startWorkflowStage('EXECUTE', '执行指标查询');
      const rawResults = [];
      try {
        for (const window of timeWindows) {
          rawResults.push(await this.indicatorService.queryIndicator({
            metricNames,
            dimensionNames: dimensions,
            filters: effectivePlan.filters.map((filter) => ({
              bizName: filter.bizName,
              operator: filter.operator,
              value: filter.value,
            })),
            dateInfo: window,
            limit: effectivePlan.limit,
          }));
        }
      } catch (error) {
        await saveQueryPlan({
          id: effectivePlan.id,
          userId: user.id,
          themeId: theme.id,
          sessionId: session.id,
          question: resolvedQuestion,
          status: 'FAILED',
          plan: effectivePlan,
          validation,
          evidence: {
            error: error.message,
            execution: {
              adapter: this.indicatorService.mode === 'local'
                ? 'local-indicator-catalog'
                : 'unconfigured-indicator',
              endpoint: '/api/semantic/query/metric',
            },
          },
        });
        this.growth?.record({
          term: normalizedQuestion,
          kind: 'EXECUTION',
          source: 'INDICATOR_ADAPTER',
          context: {
            themeId: theme.id,
            userId: user.id,
            sessionId: session.id,
            planId: effectivePlan.id,
            error: error.message,
          },
        });
        throw error;
      }
      const rawResult = rawResults[0];
      const dateDimension = dimensions.find(isDateDimensionName);
      const securedResults = rawResults.map((raw) => applyColumnPolicies(
        selectColumns(raw),
        selectRows(raw),
        scope.columnPolicies,
      ));
      const timeAggregatedResults = securedResults.map((secured) => (
        aggregateRowsByTimeGrain({
          columns: secured.columns,
          rows: secured.rows,
          dateKey: dateDimension,
          grain: inferred.timeGrain,
        })
      ));
      const baseResult = timeAggregatedResults[0] ?? { columns: [], rows: [] };
      const timeAggregatedResult = timeWindows.length > 1
        ? {
          columns: [
            ...baseResult.columns,
            {
              name: '对比期间',
              bizName: '__period',
              showType: 'CATEGORY',
              type: 'STRING',
            },
          ],
          rows: timeAggregatedResults.flatMap((result, index) => (
            result.rows.map((row) => ({
              ...row,
              __period: timeWindows[index].detectWord
                || timeWindows[index].expression
                || `期间${index + 1}`,
            }))
          )),
        }
        : baseResult;
      const derivedResult = applyDerivedMetrics({
        columns: timeAggregatedResult.columns,
        rows: timeAggregatedResult.rows,
        definitions: queryContract.derivedMetrics ?? [],
      });
      const derivedRows = queryContract.analysisPipeline
        ? derivedResult.rows
        : applyDerivedMetricFilters({
          rows: derivedResult.rows,
          filters: queryContract.filters,
          derivedFields: (queryContract.derivedMetrics ?? [])
            .map((metric) => metric.outputField),
        });
      const pipelineResult = queryContract.analysisPipeline
        ? applyAnalysisPipeline({
          columns: derivedResult.columns,
          rows: derivedRows,
          pipeline: queryContract.analysisPipeline,
        })
        : {
          columns: derivedResult.columns,
          rows: derivedRows,
        };
      const stableResult = stabilizeQueryResult({
        columns: pipelineResult.columns,
        rows: pipelineResult.rows,
        contract: queryContract,
        question: resolvedQuestion,
      });
      const displayResult = selectPublicResult({
        columns: stableResult.columns,
        rows: stableResult.rows,
        internalMetrics: queryContract.internalMetrics,
      });
      const metricDefinitions = metricNames.map((key) => {
        const metric = (indicator.metrics ?? []).find((item) => (
          String(item.metricBizName ?? item.bizName) === String(key)
        ));
        return {
          key,
          label: metric?.metricName ?? metric?.name ?? key,
          aggregation: 'SUM',
        };
      });
      let presentationEvidence = buildPresentationEvidence(rawResult);
      const hasOnlinePresentation = Object.keys(
        presentationEvidence.onlineTemplates,
      ).length > 0 || presentationEvidence.onlineFormattedRows.length > 0;
      try {
        if (!hasOnlinePresentation) {
          const presentationCacheKey = buildCacheKey({
            indicatorId: String(indicator.id),
            metricNames,
            dimensions,
            filters: effectivePlan.filters,
            timeWindows,
            limit: effectivePlan.limit,
          });
          const formattedResult = await this.runtimeCache.presentationEvidence.getOrSet(
            'presentation-evidence',
            presentationCacheKey,
            async () => {
              const formattedResults = [];
              for (const window of timeWindows) {
                formattedResults.push(
                  await this.indicatorService.queryIndicatorPresentationEvidence({
                    metricNames,
                    dimensionNames: dimensions,
                    filters: effectivePlan.filters.map((filter) => ({
                      bizName: filter.bizName,
                      operator: filter.operator,
                      value: filter.value,
                    })),
                    dateInfo: window,
                    limit: effectivePlan.limit,
                  }),
                );
              }
              return formattedResults[0];
            },
            { ttlMs: 60_000 },
          );
          presentationEvidence = buildPresentationEvidence(formattedResult);
        }
        appendProcessStep({
          id: `step-${processSteps.length + 1}`,
          type: 'presentation',
          stageCode: 'ANALYZE',
          status: 'success',
          name: 'load_presentation_evidence',
          skillCode: 'indicator_query',
          skillName: '展示证据',
          title: '加载在线展示元数据',
          detail: `按相同筛选和粒度加载 ${Object.keys(presentationEvidence.onlineTemplates).length} 个结构化格式模板`,
          review: {
            details: {
              templates: presentationEvidence.onlineTemplates,
              formattedRows: presentationEvidence.onlineFormattedRows.slice(0, 5),
            },
          },
        });
      } catch (error) {
        emit({
          type: 'warning',
          code: 'PRESENTATION_EVIDENCE_FAILED',
          message: `在线展示元数据加载失败，将由模型根据结果证据生成契约：${error.message}`,
        });
      }
      const presentationContract = applyConversationDirectivesToPresentationContract(
        await this.presentationPlanner.plan({
          harness: activeHarness,
          prompt: theme.systemPrompt,
          question: resolvedQuestion,
          columns: displayResult.columns,
          rows: displayResult.rows,
          presentationEvidence,
          metadata: {
            userId: user.id,
            sessionId: session.id,
            themeId: theme.id,
            signal,
          },
        }),
        sessionDirectives,
      );
      for (const warning of presentationContract.meta?.warnings ?? []) {
        emit({
          type: 'warning',
          code: warning.code,
          message: warning.message,
        });
      }
      appendProcessStep({
        id: `step-${processSteps.length + 1}`,
        type: 'presentation',
        stageCode: 'ANALYZE',
        status: 'success',
        name: 'compile_presentation_contract',
        skillCode: 'presentation_contract',
        skillName: '展示契约',
        title: '生成结果展示契约',
        detail: presentationContract.meta?.generatedByModel
          ? `模型编译 ${presentationContract.meta.fieldCount} 个字段的展示规则`
          : '未生成展示规则，保持原始格式',
        review: {
          details: {
            source: presentationContract.source,
            provider: presentationContract.meta?.provider ?? null,
            model: presentationContract.meta?.model ?? null,
            fields: presentationContract.fields,
            warnings: presentationContract.meta?.warnings ?? [],
          },
        },
      });
      const presentationResult = applyResultPresentation({
        columns: displayResult.columns,
        rows: displayResult.rows,
        contract: presentationContract,
      });
      const secureResult = {
        columns: presentationResult.columns,
        rows: displayResult.rows,
      };
      completeWorkflowStage('EXECUTE', {
        summary: this.indicatorService.mode === 'local'
          ? '通过指标平台执行指标查询'
          : '指标源尚未配置，未执行真实查询',
        detail: `返回 ${secureResult.rows.length} 行 / ${secureResult.columns.length} 列`,
        evidence: [{
          type: 'EXECUTION',
          adapter: this.indicatorService.mode === 'local'
          ? 'local-indicator-catalog'
            : 'unconfigured-indicator',
          rowCount: secureResult.rows.length,
          queryFingerprint: fingerprint,
          dataHash: stableResult.dataHash,
        }],
      });
      startWorkflowStage('ANALYZE', '分析并可视化查询结果');
      const chart = suggestChart({
        columns: secureResult.columns,
        rows: secureResult.rows,
        question: resolvedQuestion,
        preferred: resolveChartPreference({
          preferredChart,
          question: resolvedQuestion,
          themeDefault: theme.defaultChart,
        }),
      });
      const filterLabels = Object.fromEntries(allowedDetailDimensions.map((dimension) => [
        dimension.dimensionBizName ?? dimension.bizName,
        dimension.dimensionName ?? dimension.name,
      ]));
      const summary = buildDeterministicSummary({
        subjectName: indicator.name,
        columns: secureResult.columns,
        rows: secureResult.rows,
        contract: queryContract,
        question: resolvedQuestion,
        metricDefinitions,
        filterLabels,
        lexicon: resolveBusinessLexicon(theme),
        vocabularyResolver: ({ question: source }) => this.skillRegistry.resolveCoreSkill(
          'business_vocabulary', { question: source }, skills,
        ),
      });
      progressiveAnswer.emit(summary);
      const queryScope = buildQueryScopeSummary({
        subjectName: indicator.name,
        columns: secureResult.columns,
        contract: queryContract,
        filterLabels,
        lexicon: resolveBusinessLexicon(theme),
      });
      appendProcessStep({
        id: `step-${processSteps.length + 1}`,
        type: 'analysis',
        stageCode: 'ANALYZE',
        status: 'success',
        name: 'query_scope_summary',
        skillCode: 'indicator_query',
        skillName: '查询范围',
        title: '查询范围与口径',
        detail: queryScope,
      });
      const evidence = this.semanticCompiler.buildEvidence(effectivePlan, {
        indicator,
        rawResult,
        secureResult,
        rowPolicyCount: scope.rowPolicies.length,
        columnPolicyCount: scope.columnPolicies.length,
      });
      evidence.queryFingerprint = fingerprint;
      evidence.dataHash = stableResult.dataHash;
      evidence.resultLocked = true;
      const semanticParse = {
        ...this.semanticCompiler.buildSemanticParse({
          plan: effectivePlan,
          validation,
          evidence,
          runtime: {
            mode: activeHarness.mode,
            model: activeHarness.model ?? null,
          },
        }),
        queryContract,
        gateSummary: queryContract.gateSummary ?? null,
        queryFingerprint: fingerprint,
        dataHash: stableResult.dataHash,
        timeGrain: inferred.timeGrain,
        analysisMode: boundContract?.analysisMode ?? analysisMode.mode,
        attribution: boundContract?.attribution ?? null,
        mappingProvenance: boundContract?.provenance ?? null,
        presentation: presentationResult.contract,
        presentationEvidence: {
          onlineTemplates: presentationEvidence?.onlineTemplates ?? {},
          onlineFormattedRows: presentationEvidence?.onlineFormattedRows?.slice(0, 8) ?? [],
        },
        deterministic: true,
        resultLocked: true,
      };
      const queryArtifact = await persistQueryArtifact({
        sourceType: 'INDICATOR',
        source: {
          id: String(indicator.id),
          name: indicator.name,
          adapter: this.indicatorService.mode === 'local'
            ? 'local-indicator-catalog'
            : 'unconfigured-indicator',
        },
        indicator: {
          id: String(indicator.id),
          name: indicator.name,
          businessCaliber: indicator.businessCaliber,
        },
        data: secureResult,
        chart,
        semanticParse,
        question: normalizedQuestion,
        resolvedQuestion,
        queryFingerprint: fingerprint,
        dataHash: stableResult.dataHash,
      });
      await saveQueryPlan({
        id: effectivePlan.id,
        userId: user.id,
        themeId: theme.id,
        sessionId: session.id,
        question: resolvedQuestion,
        status: 'EXECUTED',
        plan: effectivePlan,
        validation,
        evidence,
      });
      const toolResult = {
        indicator: {
          id: String(indicator.id),
          name: indicator.name,
        },
        metricNames,
        dimensions,
        filters: effectivePlan.filters,
        rowCount: secureResult.rows.length,
        columns: secureResult.columns,
        sampleRows: secureResult.rows.slice(0, 12),
        chart,
        summary,
        planId: effectivePlan.id,
        semanticParse,
        queryFingerprint: fingerprint,
        dataHash: stableResult.dataHash,
        timeGrain: inferred.timeGrain,
        locked: true,
        finalMessage: summary,
      };
      toolResult.workspaceArtifactId = queryArtifact?.id ?? null;
      const executionRecord = {
        kind: 'indicator',
        queryArtifactId: queryArtifact?.id ?? null,
        queryFingerprint: fingerprint,
        dataHash: stableResult.dataHash,
        finalMessage: summary,
        toolResult,
      };
      queryExecutions.push(executionRecord);
      if (executionKey) {
        lockedExecutions.set(executionKey, executionRecord);
      }
      lockedExecutions.set(fingerprint, executionRecord);
      lastLockedExecution = executionRecord;
      lastQueryResult = secureResult;
      lastChart = chart;
      lastIndicator = indicator;
      lastSemanticParse = semanticParse;
      completeWorkflowStage('ANALYZE', {
        summary: `选择${chart.type}进行结果展示`,
        detail: summary,
        evidence: [{
          type: 'VISUALIZATION',
          chartType: chart.type,
          reason: chart.reason,
        }],
      });

      return toolResult;
    };

    const getBusinessDatasetDefinition = async (args) => {
      startWorkflowStage('SEMANTIC_CONFIRM', '读取业务数据集字段口径');
      const dataset = businessDatasets.find(
        (item) => Number(item.id) === Number(args.datasetId),
      );
      if (!dataset) {
        throw new Error('business dataset permission denied');
      }
      const rawFields = await this.businessDatasets.getDatasetFieldsAsync(dataset.id, true);
      const schemaFingerprint = buildCacheKey(
        rawFields.map((field) => ({
          fieldName: field.fieldName,
          role: field.role,
          semanticType: field.semanticType,
          description: field.description,
        })),
      );
      const semanticKey = buildCacheKey({
        datasetId: dataset.id,
        schemaFingerprint,
        prompt: theme.systemPrompt,
        config: theme.semanticValueConfig,
        semanticPolicy: theme.semanticPolicy,
        scope,
      });
      let fields = rawFields;
      if (this.semanticValues) {
        try {
          fields = await this.runtimeCache.semanticContexts.getOrSet(
            'semantic-context',
            `dataset:${semanticKey}`,
            async () => this.semanticValues.initializeDataset(
              dataset,
              rawFields,
              theme.systemPrompt,
              (field) => this.businessDatasets.listDistinctFieldValues(
                dataset.id,
                field.fieldName,
                { limit: 200 },
              ),
              theme.semanticValueConfig,
              theme.id,
              true,
              theme.semanticPolicy,
              scope,
            ),
            { ttlMs: 300_000 },
          );
        } catch (error) {
          // Field metadata (name/type/role/aggregator) is sufficient for a
          // plain metric aggregation. Optional enum/value-domain enrichment
          // must not hide the underlying dataset schema from the agent.
          emit({
            type: 'warning',
            code: 'SEMANTIC_VALUE_DOMAIN_UNAVAILABLE',
            message: `数据集字段元数据已读取；默认值域补充暂不可用：${error.message}`,
          });
          fields = rawFields;
        }
      }
      confirmationState.confirmedDatasetIds.add(String(dataset.id));
      confirmationState.datasetDefinitions.set(String(dataset.id), {
        dataset,
        fields,
      });
      completeWorkflowStage('SEMANTIC_CONFIRM', {
        summary: `确认数据集「${dataset.name}」字段口径`,
        detail: `${fields.length} 个字段，${
          fields.filter((field) => field.role === 'METRIC').length
        } 个指标字段，${
          fields.filter((field) => (field.values ?? []).length > 0).length
        } 个字段完成默认值域初始化`,
        evidence: [
          {
            type: 'BUSINESS_DATASET',
            id: String(dataset.id),
            name: dataset.name,
            table: `${dataset.schemaName}.${dataset.primaryTable}`,
          },
        ],
      });
      return {
        dataset: {
          id: dataset.id,
          code: dataset.code,
          name: dataset.name,
          schemaName: dataset.schemaName,
          tableName: dataset.primaryTable,
          description: dataset.description,
        },
        fields: fields.map((field) => ({
          name: field.fieldName,
          displayName: field.displayName,
          role: field.role,
          semanticType: field.semanticType,
          aggregator: field.aggregator,
          allowedOperators: field.allowedOperators,
          description: field.description,
          values: field.values ?? [],
          valueAliases: field.valueAliases ?? {},
          valueSource: field.valueDomain?.source ?? [],
        })),
      };
    };

    const runBusinessDatasetQuery = async (args) => {
      const dataset = businessDatasets.find(
        (item) => Number(item.id) === Number(args.datasetId),
      );
      if (!dataset) {
        throw new Error('business dataset permission denied');
      }
      if (!confirmationState.confirmedDatasetIds.has(String(dataset.id))) {
        const error = new Error('必须确认业务数据集字段口径后才能执行查询');
        failWorkflowStage('SEMANTIC_CONFIRM', error);
        throw error;
      }
      const executionKey = args.__contract?.id ?? null;
      const reusedExecution = executionKey
        ? lockedExecutions.get(executionKey)
        : null;
      if (reusedExecution) {
        appendProcessStep({
        id: `step-${processSteps.length + 1}`,
        type: 'reuse',
        stageCode: 'EXECUTE',
          status: 'success',
          name: 'reuse_locked_result',
          skillCode: 'business_dataset_query',
          skillName: '结果锁定',
          title: '复用首个有效结果',
          detail: `已复用查询 ${reusedExecution.queryFingerprint.slice(0, 12)} 的数据快照`,
          durationMs: 0,
        });
        return reusedExecution.toolResult;
      }
      const fields = confirmationState.datasetDefinitions.get(
        String(dataset.id),
      )?.fields ?? await this.businessDatasets.getDatasetFieldsAsync(dataset.id, true);
      const boundContract = args.__contract ?? null;
      const boundExecution = boundContract
        ? prepareBoundDatasetExecution(boundContract)
        : null;
      const executionFilterFields = boundExecution?.executionFilterFields ?? [];
      const requestedMetrics = boundContract
        ? boundExecution.requestedMetrics
        : (args.metrics ?? []).map((metric) => (
          typeof metric === 'string' ? { field: metric } : metric
        ));
      const requestedDimensions = boundContract
        ? resolveBoundDimensionsFromModule(boundContract)
        : (args.dimensions ?? []).map(String);
      const inferred = boundContract
        ? {
          metrics: requestedMetrics,
          dimensions: requestedDimensions,
          order: boundContract.order ?? [],
          limit: boundContract.limit,
          timeGrain: boundContract.timeGrain,
          aggregationIntent: requestedDimensions.length > 0 ? 'GROUP' : 'SUMMARY',
        }
        : inferDatasetQuerySpec({
          question: resolvedQuestion,
          fields,
          fallbackMetrics: requestedMetrics,
          fallbackDimensions: requestedDimensions,
          vocabularyResolver: ({ question: source }) => this.skillRegistry.resolveCoreSkill(
            'business_vocabulary',
            { question: source },
            skills,
          ),
        });
      const boundWindows = boundContract?.timeWindows ?? [];
      const datasetDateRange = boundWindows.length > 0
        ? {
          field: selectDatasetTimeField(fields)?.fieldName,
          startDate: boundWindows[0].startDate ?? null,
          endDate: boundWindows[0].endDate ?? null,
        }
        : buildDatasetDateRange(
          resolvedQuestion,
          fields,
          args.dateRange,
          ({ question: source }) => this.skillRegistry.resolveCoreSkill(
            'temporal_expression',
            { question: source },
            skills,
          ),
        );
      startWorkflowStage('PLAN', '生成业务数据集查询计划');
      const datasetPlanStartedAt = Date.now();
      const derivedOutputFields = new Set(
        (boundContract?.derivedMetrics ?? []).map(
          (metric) => String(metric.outputField),
        ),
      );
      for (const stage of boundContract?.analysisPipeline?.stages ?? []) {
        if (stage.type === 'BUCKET_FIELD' && stage.outputField) {
          derivedOutputFields.add(String(stage.outputField));
        }
        if (stage.type === 'DERIVE') {
          for (const definition of stage.definitions ?? []) {
            if (definition.outputField) {
              derivedOutputFields.add(String(definition.outputField));
            }
          }
        }
        if (stage.type === 'ROLLUP') {
          for (const output of stage.outputs ?? []) {
            if (output.outputField) {
              derivedOutputFields.add(String(output.outputField));
            }
          }
        }
      }
      const plan = this.semanticCompiler.compileDatasetQuery({
        question: resolvedQuestion,
        dataset,
        metrics: inferred.metrics.map((metric) => ({
          field: metric.field,
          aggregator: metric.aggregator,
          outputField: metric.outputField ?? metric.field,
          predicateFilters: metric.predicateFilters ?? [],
        })),
        dimensions: inferred.dimensions,
        filters: boundContract
          ? executionFilterFields
            .filter((filter) => !derivedOutputFields.has(String(filter.field)))
            .map((filter) => ({
              field: filter.field,
              operator: filter.operator,
              value: filter.value,
              scope: filter.scope ?? 'ROW',
            }))
          : mergeSemanticFilters(args.filters ?? [], []),
        dateRange: datasetDateRange,
        order: inferred.order.length > 0 ? inferred.order : args.order,
        limit: inferred.limit,
        source: activeHarness?.mode === 'local-rule' ? 'RULE' : 'LLM',
      });
      const datasetPlanDurationMs = Date.now() - datasetPlanStartedAt;
      appendProcessStep({
        id: `step-${processSteps.length + 1}`,
        type: 'plan',
        stageCode: 'PLAN',
        status: 'success',
        name: 'compile_dataset_plan',
        skillCode: 'business_dataset_query',
        skillName: '业务数据集',
        title: '编译业务数据计划',
        detail: `${dataset.name}，指标 ${
          plan.metrics.map((metric) => metric.field).join('、') || '无'
        }，维度 ${plan.dimensions.join('、') || '汇总'}`,
        durationMs: datasetPlanDurationMs,
      });
      completeWorkflowStage('PLAN', {
        summary: `生成「${dataset.name}」业务查询计划`,
        detail: `指标 ${
          plan.metrics.map((metric) => metric.field).join('、') || '无'
        }；维度 ${plan.dimensions.join('、') || '汇总'}`,
        evidence: [{ type: 'PLAN', id: plan.id, intent: plan.intent }],
      });
      startWorkflowStage('VALIDATE', '校验业务数据集查询计划');
      const datasetValidationStartedAt = Date.now();
      const validation = this.semanticCompiler.validateDatasetPlan(plan, {
        fields,
        scope,
      });
      const datasetValidationDurationMs = Date.now() - datasetValidationStartedAt;
      appendProcessStep({
        id: `step-${processSteps.length + 1}`,
        type: 'validation',
        stageCode: 'VALIDATE',
        status: validation.valid ? 'success' : 'error',
        name: 'validate_dataset_plan',
        skillCode: 'business_dataset_query',
        skillName: '业务计划校验',
        title: '校验业务字段与权限',
        detail: validation.valid
          ? `通过 ${validation.checks.length} 项校验`
          : validation.issues.map((issue) => issue.message).join('；'),
        durationMs: datasetValidationDurationMs,
      });
      if (validation.valid) {
        completeWorkflowStage('VALIDATE', {
          summary: '业务字段、数据集授权和只读边界校验通过',
          detail: validation.checks.join('、'),
        });
      } else {
        failWorkflowStage(
          'VALIDATE',
          new Error(validation.issues.map((issue) => issue.message).join('；')),
        );
      }
      if (!validation.valid) {
        await saveQueryPlan({
          id: plan.id,
          userId: user.id,
          themeId: theme.id,
          sessionId: session.id,
          sourceType: 'BUSINESS_DATASET',
          datasetId: String(dataset.id),
          question: resolvedQuestion,
          status: 'REJECTED',
          plan,
          validation,
        });
        const validationError = new Error(
          `主题配置或字段白名单需要调整：${
            validation.issues.map((issue) => issue.message).join('；')
          }`,
        );
        validationError.terminal = true;
        validationError.code = 'DATASET_PLAN_VALIDATION_FAILED';
        throw validationError;
      }
      const effectivePlan = this.semanticCompiler.bindDatasetPermissions(
        plan,
        scope,
        dataset.config?.policyFieldMap ?? {},
        dataset.config?.policyValueMap ?? {},
      );
      effectivePlan.timeWindows = boundContract?.timeWindows ?? [];
      effectivePlan.calculation = boundContract?.calculation ?? { type: 'NONE' };
      effectivePlan.postProcessing = boundContract?.postProcessing ?? null;
      effectivePlan.contractId = boundContract?.id ?? null;
      effectivePlan.queryContract = boundContract ?? null;
      effectivePlan.compilerVersion = boundContract?.compilerVersion ?? null;
      if (boundContract?.analysisPipeline) {
        effectivePlan.limit = boundContract.limit;
      }
      const datasetDateInfo = effectivePlan.dateRange
        ? {
          dateMode: 'BETWEEN',
          startDate: effectivePlan.dateRange.startDate ?? null,
          endDate: effectivePlan.dateRange.endDate ?? null,
          dateField: effectivePlan.dateRange.field ?? null,
        }
        : null;
      const queryContractFilters = boundContract
        ? boundContract.filterFields.map((filter) => ({
          field: filter.field,
          operator: filter.operator,
          value: filter.value,
          scope: filter.scope ?? 'ROW',
          applicationScope: filter.applicationScope ?? 'GLOBAL',
          conditionIds: filter.conditionIds ?? [],
          source: 'AGENT',
        }))
        : effectivePlan.filters;
      const queryContract = buildQueryContract({
        indicatorId: `dataset:${dataset.id}`,
        metrics: effectivePlan.metrics.map((metric) => metric.field),
        metricSpecs: effectivePlan.metrics,
        derivedMetrics: boundContract?.derivedMetrics ?? [],
        dimensions: boundWindows.length > 1
          ? [...effectivePlan.dimensions, '__period']
          : effectivePlan.dimensions,
        filters: queryContractFilters,
        dateInfo: datasetDateInfo,
        timeGrain: inferred.timeGrain,
        limit: effectivePlan.limit,
        timeWindows: boundWindows,
        calculation: effectivePlan.calculation,
        postProcessing: effectivePlan.postProcessing,
        periodOrder: boundWindows.map((window, index) => (
          window.detectWord || window.expression || window.label || `期间${index + 1}`
        )),
        analysisMode: boundContract?.analysisMode,
        attribution: boundContract?.attribution,
        semanticPolicy: boundContract?.semanticPolicy,
        semanticResolutions: boundContract?.semanticResolutions,
        internalMetrics: boundContract?.internalMetrics,
        analysisPipeline: boundContract?.analysisPipeline,
        limitPolicy: boundContract?.limitPolicy,
      });
      const fingerprint = queryFingerprint(queryContract);
      const fingerprintExecution = lockedExecutions.get(fingerprint);
      if (fingerprintExecution) {
        appendProcessStep({
          id: `step-${processSteps.length + 1}`,
          type: 'reuse',
          stageCode: 'EXECUTE',
          status: 'success',
          name: 'reuse_locked_result',
          skillCode: 'business_dataset_query',
          skillName: '结果复用',
          title: '复用查询快照',
          detail: `查询指纹 ${fingerprint.slice(0, 12)} 已存在，直接复用工作区数据`,
          durationMs: 0,
        });
        return fingerprintExecution.toolResult;
      }
      emit({
        type: 'execution_selected',
        source: {
          mode: datasetExecution(dataset).adapter,
          configured: true,
          datasetId: dataset.id,
          datasetName: dataset.name,
          queryFingerprint: fingerprint,
        },
      });
      startWorkflowStage('EXECUTE', '执行业务数据集查询');
      const executionWindows = boundWindows.length > 0 ? boundWindows : [null];
      const results = [];
      try {
        for (const window of executionWindows) {
          const request = {
            metrics: effectivePlan.metrics,
            dimensions: effectivePlan.dimensions,
            filters: effectivePlan.filters.map((filter) => ({
              field: filter.field ?? filter.bizName,
              operator: filter.operator,
              value: filter.value,
              scope: filter.scope ?? 'ROW',
            })),
            dateRange: window
              ? {
                field: window.dateField
                  ?? effectivePlan.dateRange?.field
                  ?? selectDatasetTimeField(fields)?.fieldName,
                startDate: window.startDate ?? effectivePlan.dateRange?.startDate ?? null,
                endDate: window.endDate ?? effectivePlan.dateRange?.endDate ?? null,
              }
              : effectivePlan.dateRange,
            order: effectivePlan.order,
            limit: effectivePlan.limit,
            timeGrain: inferred.timeGrain,
            analysisPipeline: Boolean(queryContract.analysisPipeline),
          };
          results.push(await this.businessDatasets.executeQuery({
            datasetId: dataset.id,
            request,
            userId: user.id,
            sessionId: session.id,
          }));
        }
      } catch (error) {
        await saveQueryPlan({
          id: effectivePlan.id,
          userId: user.id,
          themeId: theme.id,
          sessionId: session.id,
          sourceType: 'BUSINESS_DATASET',
          datasetId: String(dataset.id),
          question: resolvedQuestion,
          status: 'FAILED',
          plan: effectivePlan,
          validation,
          evidence: { error: error.message },
        });
        this.growth?.record({
          term: normalizedQuestion,
          kind: 'DATASET_EXECUTION',
          source: `${datasetExecution(dataset).dbType}_DATASET`,
          context: {
            themeId: theme.id,
            userId: user.id,
            sessionId: session.id,
            datasetId: dataset.id,
            error: error.message,
          },
        });
        throw error;
      }
      const result = results[0];
      const rawTruncated = results.some((item) => item.truncated === true);
      const intentionalTopN = Number(queryContract?.limitPolicy?.intentionalTopN) || null;
      const resultTruncated = rawTruncated && !intentionalTopN;
      if (resultTruncated) {
        emit({
          type: 'warning',
          code: 'RESULT_TRUNCATED',
          message: `结果已达到查询上限 ${result.limit ?? effectivePlan.limit} 行，当前结果可能被截断。`,
        });
      }
      const securedResults = results.map((item) => applyColumnPolicies(
        item.columns,
        item.rows,
        scope.columnPolicies,
      ));
      const fieldMap = new Map(fields.map((field) => [field.fieldName, field]));
      const metricDefinitions = effectivePlan.metrics.map((metric) => {
        const inferredMetric = inferred.metrics.find((item) => (
          String(item.field) === String(metric.field)
          && String(item.outputField ?? item.field) === String(metric.outputField ?? metric.field)
        ));
        return {
          key: metric.outputField ?? metric.field,
          field: metric.field,
          label: inferredMetric?.label
            ?? fieldMap.get(metric.field)?.displayName
            ?? metric.field,
          aggregation: metric.aggregator ?? fieldMap.get(metric.field)?.aggregator,
        };
      });
      const displayColumnsByResult = securedResults.map((secured) => (
        secured.columns.map((column) => {
          const definition = metricDefinitions.find(
            (metric) => String(metric.key) === String(column.bizName),
          );
          return definition ? { ...column, name: definition.label } : column;
        })
      ));
      const dateDimension = effectivePlan.dimensions.find(isDateDimensionName);
      const timeAggregatedResults = securedResults.map((secured, index) => (
        aggregateRowsByTimeGrain({
          columns: displayColumnsByResult[index],
          rows: secured.rows,
          dateKey: dateDimension,
          grain: inferred.timeGrain,
        })
      ));
      const baseAggregatedResult = timeAggregatedResults[0] ?? { columns: [], rows: [] };
      const timeAggregatedResult = boundWindows.length > 1
        ? {
          columns: [
            ...baseAggregatedResult.columns,
            {
              name: '对比期间',
              bizName: '__period',
              showType: 'CATEGORY',
              type: 'STRING',
            },
          ],
          rows: timeAggregatedResults.flatMap((item, index) => (
            item.rows.map((row) => ({
              ...row,
              __period: boundWindows[index].detectWord
                || boundWindows[index].expression
                || boundWindows[index].label
                || `期间${index + 1}`,
            }))
          )),
        }
        : baseAggregatedResult;
      const effectivePostProcessing = effectivePlan.postProcessing
        ? JSON.parse(JSON.stringify(effectivePlan.postProcessing))
        : null;
      if (
        effectivePostProcessing?.periodComparison
        && queryContract.periodOrder?.length >= 2
      ) {
        const baseIndex = Number.isInteger(queryContract.calculation?.baseWindowIndex)
          ? queryContract.calculation.baseWindowIndex
          : 0;
        const compareIndex = Number.isInteger(queryContract.calculation?.compareWindowIndex)
          ? queryContract.calculation.compareWindowIndex
          : 1;
        effectivePostProcessing.periodComparison.basePeriod =
          queryContract.periodOrder[baseIndex] ?? queryContract.periodOrder[0];
        effectivePostProcessing.periodComparison.comparePeriod =
          queryContract.periodOrder[compareIndex] ?? queryContract.periodOrder[1];
      }
      const processedResult = applyResultPostProcessing({
        columns: timeAggregatedResult.columns,
        rows: timeAggregatedResult.rows,
        postProcessing: effectivePostProcessing,
        periodOrder: queryContract.periodOrder,
      });
      const derivedResult = applyDerivedMetrics({
        columns: processedResult.columns,
        rows: processedResult.rows,
        definitions: queryContract.derivedMetrics ?? [],
      });
      const derivedRows = queryContract.analysisPipeline
        ? derivedResult.rows
        : applyDerivedMetricFilters({
          rows: derivedResult.rows,
          filters: queryContract.filters,
          derivedFields: (queryContract.derivedMetrics ?? [])
            .map((metric) => metric.outputField),
        });
      const pipelineResult = queryContract.analysisPipeline
        ? applyAnalysisPipeline({
          columns: derivedResult.columns,
          rows: derivedRows,
          pipeline: queryContract.analysisPipeline,
        })
        : {
          columns: derivedResult.columns,
          rows: derivedRows,
        };
      const stableResult = stabilizeQueryResult({
        columns: pipelineResult.columns,
        rows: pipelineResult.rows,
        contract: queryContract,
        question: resolvedQuestion,
      });
      const displayResult = selectPublicResult({
        columns: stableResult.columns,
        rows: stableResult.rows,
        internalMetrics: queryContract.internalMetrics,
      });
      let presentationEvidence = null;
      let formattingIndicator = null;
      const metricKeys = new Set(
        effectivePlan.metrics.map((metric) => String(metric.field)),
      );
      for (const detail of confirmationState.indicatorDetails.values()) {
        const matched = (detail.metrics ?? []).some((metric) => (
          metricKeys.has(String(metric.metricBizName ?? metric.bizName))
        ));
        if (matched) {
          formattingIndicator = detail;
          break;
        }
      }
      if (formattingIndicator) {
        const formattingDimensions = new Set(
          (formattingIndicator.dimensions ?? []).flatMap((dimension) => [
            String(dimension.dimensionBizName ?? dimension.bizName ?? ''),
            String(dimension.dimensionName ?? dimension.name ?? ''),
          ]).filter(Boolean),
        );
        const formattedMetricNames = (formattingIndicator.metrics ?? [])
          .map((metric) => String(metric.metricBizName ?? metric.bizName ?? ''))
          .filter((field) => metricKeys.has(field));
        const formattedDimensions = effectivePlan.dimensions
          .filter((dimension) => formattingDimensions.has(String(dimension)));
        const formattedFilters = effectivePlan.filters
          .filter((filter) => formattingDimensions.has(String(filter.field ?? filter.bizName)))
          .map((filter) => ({
            bizName: filter.field ?? filter.bizName,
            operator: filter.operator,
            value: filter.value,
          }));
        try {
          if (
            formattedMetricNames.length !== metricKeys.size
            || formattedDimensions.length !== effectivePlan.dimensions.length
          ) {
            throw new Error('在线指标字段或维度无法与最终结果粒度一一对应');
          }
          const presentationCacheKey = buildCacheKey({
            indicatorId: String(formattingIndicator.id),
            metricNames: formattedMetricNames,
            dimensions: formattedDimensions,
            filters: formattedFilters,
            windows: boundWindows,
            dateRange: effectivePlan.dateRange,
            limit: effectivePlan.limit,
          });
          const formattedResult = await this.runtimeCache.presentationEvidence.getOrSet(
            'presentation-evidence',
            presentationCacheKey,
            async () => {
              const formattedResults = [];
              for (const window of (boundWindows.length > 0 ? boundWindows : [null])) {
                formattedResults.push(
                  await this.indicatorService.queryIndicatorPresentationEvidence({
                    metricNames: formattedMetricNames,
                    dimensionNames: formattedDimensions,
                    filters: formattedFilters,
                    dateInfo: window
                      ? {
                        dateMode: 'BETWEEN',
                        startDate: window.startDate ?? effectivePlan.dateRange?.startDate,
                        endDate: window.endDate ?? effectivePlan.dateRange?.endDate,
                        dateField: window.dateField ?? effectivePlan.dateRange?.field,
                      }
                      : effectivePlan.dateRange,
                    limit: effectivePlan.limit,
                  }),
                );
              }
              return formattedResults[0];
            },
            { ttlMs: 60_000 },
          );
          presentationEvidence = buildPresentationEvidence(formattedResult);
          appendProcessStep({
            id: `step-${processSteps.length + 1}`,
            type: 'presentation',
            stageCode: 'ANALYZE',
            status: 'success',
            name: 'load_presentation_evidence',
            skillCode: 'business_dataset_query',
            skillName: '展示证据',
            title: '匹配在线指标展示元数据',
            detail: `使用指标「${formattingIndicator.name}」加载 ${Object.keys(presentationEvidence.onlineTemplates).length} 个结构化格式模板`,
            review: {
              details: {
                indicatorId: String(formattingIndicator.id),
                templates: presentationEvidence.onlineTemplates,
                formattedRows: presentationEvidence.onlineFormattedRows.slice(0, 5),
              },
            },
          });
        } catch (error) {
          emit({
            type: 'warning',
            code: 'PRESENTATION_EVIDENCE_FAILED',
            message: `在线指标展示元数据加载失败，将由模型根据结果证据生成契约：${error.message}`,
          });
        }
      } else {
        emit({
          type: 'warning',
          code: 'PRESENTATION_INDICATOR_NOT_MAPPED',
          message: '最终展示项未匹配到在线指标，将由模型根据结果证据生成展示契约。',
        });
      }
      const presentationContract = applyConversationDirectivesToPresentationContract(
        await this.presentationPlanner.plan({
          harness: activeHarness,
          prompt: theme.systemPrompt,
          question: resolvedQuestion,
          columns: displayResult.columns,
          rows: displayResult.rows,
          presentationEvidence,
          metadata: {
            userId: user.id,
            sessionId: session.id,
            themeId: theme.id,
            signal,
          },
        }),
        sessionDirectives,
      );
      for (const warning of presentationContract.meta?.warnings ?? []) {
        emit({
          type: 'warning',
          code: warning.code,
          message: warning.message,
        });
      }
      appendProcessStep({
        id: `step-${processSteps.length + 1}`,
        type: 'presentation',
        stageCode: 'ANALYZE',
        status: 'success',
        name: 'compile_presentation_contract',
        skillCode: 'presentation_contract',
        skillName: '展示契约',
        title: '生成结果展示契约',
        detail: presentationContract.meta?.generatedByModel
          ? `模型编译 ${presentationContract.meta.fieldCount} 个字段的展示规则`
          : '未生成展示规则，保持原始格式',
        review: {
          details: {
            source: presentationContract.source,
            provider: presentationContract.meta?.provider ?? null,
            model: presentationContract.meta?.model ?? null,
            fields: presentationContract.fields,
            warnings: presentationContract.meta?.warnings ?? [],
          },
        },
      });
      const presentationResult = applyResultPresentation({
        columns: displayResult.columns,
        rows: displayResult.rows,
        contract: presentationContract,
      });
      const secureResult = {
        columns: presentationResult.columns,
        rows: displayResult.rows,
      };
      completeWorkflowStage('EXECUTE', {
        summary: `通过 ${datasetExecution(dataset).label} 数据集执行只读查询`,
        detail: `返回 ${secureResult.rows.length} 行 / ${secureResult.columns.length} 列`,
        evidence: [{
          type: 'EXECUTION',
          adapter: datasetExecution(dataset).adapter,
          rowCount: secureResult.rows.length,
          generatedSql: results.map((item) => item.sql).filter(Boolean).join('; '),
          queryFingerprint: fingerprint,
          dataHash: stableResult.dataHash,
        }],
      });
      startWorkflowStage('ANALYZE', '分析并可视化业务查询结果');
      const chart = suggestChart({
        columns: secureResult.columns,
        rows: secureResult.rows,
        question: resolvedQuestion,
        preferred: resolveChartPreference({
          preferredChart,
          question: resolvedQuestion,
          themeDefault: theme.defaultChart,
        }),
      });
      const queryScopeFilterLabels = Object.fromEntries(fields.map((field) => [
        field.fieldName,
        field.displayName,
      ]));
      const summary = buildDeterministicSummary({
        subjectName: dataset.name,
        columns: secureResult.columns,
        rows: secureResult.rows,
        contract: queryContract,
        question: resolvedQuestion,
        metricDefinitions,
        filterLabels: queryScopeFilterLabels,
        lexicon: resolveBusinessLexicon(theme),
        vocabularyResolver: ({ question: source }) => this.skillRegistry.resolveCoreSkill(
          'business_vocabulary', { question: source }, skills,
        ),
        resultQuality: {
          truncated: resultTruncated,
          limit: result.limit ?? effectivePlan.limit,
        },
      });
      progressiveAnswer.emit(summary);
      const queryScope = buildQueryScopeSummary({
        subjectName: dataset.name,
        columns: secureResult.columns,
        contract: queryContract,
        filterLabels: queryScopeFilterLabels,
        lexicon: resolveBusinessLexicon(theme),
      });
      appendProcessStep({
        id: `step-${processSteps.length + 1}`,
        type: 'analysis',
        stageCode: 'ANALYZE',
        status: 'success',
        name: 'query_scope_summary',
        skillCode: 'business_dataset_query',
        skillName: '查询范围',
        title: '查询范围与口径',
        detail: queryScope,
      });
      const evidence = this.semanticCompiler.buildDatasetEvidence(
        effectivePlan,
        {
          columns: secureResult.columns,
          rows: secureResult.rows,
        },
        {
          rowPolicyCount: scope.rowPolicies.length,
          columnPolicyCount: scope.columnPolicies.length,
          generatedSql: results.map((item) => item.sql).filter(Boolean).join('; '),
        },
      );
      evidence.queryFingerprint = fingerprint;
      evidence.dataHash = stableResult.dataHash;
      evidence.timeGrain = inferred.timeGrain;
      evidence.resultLocked = true;
      const semanticParse = {
        ...this.semanticCompiler.buildDatasetSemanticParse({
          plan: effectivePlan,
          validation,
          evidence,
          runtime: {
            mode: activeHarness.mode,
            model: activeHarness.model ?? null,
          },
        }),
        queryContract,
        gateSummary: queryContract.gateSummary ?? null,
        queryFingerprint: fingerprint,
        dataHash: stableResult.dataHash,
        timeGrain: inferred.timeGrain,
        analysisMode: boundContract?.analysisMode ?? analysisMode.mode,
        attribution: boundContract?.attribution ?? null,
        mappingProvenance: boundContract?.provenance ?? null,
        presentation: presentationResult.contract,
        presentationEvidence: {
          onlineTemplates: presentationEvidence?.onlineTemplates ?? {},
          onlineFormattedRows: presentationEvidence?.onlineFormattedRows?.slice(0, 8) ?? [],
        },
        formattingIndicator: formattingIndicator ? {
          id: String(formattingIndicator.id),
          name: formattingIndicator.name,
        } : null,
        deterministic: true,
        resultLocked: true,
        resultQuality: {
          truncated: resultTruncated,
          limit: result.limit ?? effectivePlan.limit,
        },
      };
      const queryArtifact = await persistQueryArtifact({
        sourceType: 'BUSINESS_DATASET',
        source: {
          id: String(dataset.id),
          name: dataset.name,
          table: `${dataset.schemaName}.${dataset.primaryTable}`,
          adapter: datasetExecution(dataset).adapter,
        },
        dataset: {
          id: dataset.id,
          code: dataset.code,
          name: dataset.name,
          schemaName: dataset.schemaName,
          tableName: dataset.primaryTable,
        },
        data: secureResult,
        chart,
        semanticParse,
        question: normalizedQuestion,
        resolvedQuestion,
        queryFingerprint: fingerprint,
        dataHash: stableResult.dataHash,
      });
      await saveQueryPlan({
        id: effectivePlan.id,
        userId: user.id,
        themeId: theme.id,
        sessionId: session.id,
        sourceType: 'BUSINESS_DATASET',
        datasetId: String(dataset.id),
        question: resolvedQuestion,
        status: 'EXECUTED',
        plan: effectivePlan,
        validation,
        evidence,
      });
      lastQueryResult = secureResult;
      lastChart = chart;
      lastBusinessDataset = dataset;
      lastSemanticParse = semanticParse;
      const toolResult = {
        dataset: {
          id: dataset.id,
          name: dataset.name,
        },
        metrics: effectivePlan.metrics.map((metric) => metric.field),
        dimensions: effectivePlan.dimensions,
        filters: effectivePlan.filters,
        rowCount: secureResult.rows.length,
        columns: secureResult.columns,
        sampleRows: secureResult.rows.slice(0, 12),
        chart,
        summary,
        planId: effectivePlan.id,
        semanticParse,
        queryFingerprint: fingerprint,
        dataHash: stableResult.dataHash,
        locked: true,
        finalMessage: summary,
      };
      toolResult.workspaceArtifactId = queryArtifact?.id ?? null;
      const executionRecord = {
        kind: 'dataset',
        queryArtifactId: queryArtifact?.id ?? null,
        queryFingerprint: fingerprint,
        dataHash: stableResult.dataHash,
        finalMessage: summary,
        toolResult,
      };
      queryExecutions.push(executionRecord);
      if (executionKey) {
        lockedExecutions.set(executionKey, executionRecord);
      }
      lockedExecutions.set(fingerprint, executionRecord);
      lastLockedExecution = executionRecord;
      completeWorkflowStage('ANALYZE', {
        summary: `选择${chart.type}进行业务数据分析`,
        detail: summary,
        evidence: [{
          type: 'VISUALIZATION',
          chartType: chart.type,
          reason: chart.reason,
        }],
      });
      return toolResult;
    };

    const compileQueryContract = async (args, options = {}) => {
      startWorkflowStage('PLAN', '编译查询契约');
      const sourceType = String(args.sourceType ?? '').toUpperCase();
      if (localIndicatorMode && sourceType === 'INDICATOR') {
        const sourceError = new Error(
          '指标平台模块已在系统设置中停用，当前只能使用业务数据集或工作区数据进行大模型直连分析。',
        );
        sourceError.code = 'LOCAL_INDICATOR_QUERY_UNSUPPORTED';
        sourceError.recoverable = true;
        throw sourceError;
      }
      if (businessDatasets.length > 0 && sourceType !== 'BUSINESS_DATASET') {
        const sourceError = new Error(
          'BUSINESS_DATASET_EXECUTION_REQUIRED：当前主题已配置业务数据集，指标平台只用于指标口径确认。',
        );
        sourceError.code = 'BUSINESS_DATASET_EXECUTION_REQUIRED';
        sourceError.recoverable = true;
        throw sourceError;
      }
      const sourceContext = buildContextFromModule({
        taskState: conversationContext.taskState,
        resolvedQuestion,
        clarificationText: clarificationOptionLabel,
      });
      const startedAt = Date.now();
      let result;
      if (sourceType === 'INDICATOR') {
        const indicatorId = String(args.indicatorId ?? '');
        if (!indicatorId) {
          throw new Error('compile_query_contract requires indicatorId');
        }
        if (!confirmationState.confirmedIndicatorIds.has(indicatorId)) {
          throw new Error('必须先确认指标口径后才能编译查询契约');
        }
        const indicator = confirmationState.indicatorDetails.get(indicatorId)
          ?? await getIndicator(indicatorId);
        const allowedDimensions = filterDimensionsByScope(
          indicator.dimensions ?? [],
          scope,
        );
        result = this.queryContractCompiler.compile({
          question: resolvedQuestion,
          sourceType,
          indicator,
          availableMetrics: indicator.metrics ?? [],
          availableDimensions: allowedDimensions,
          theme,
          scope,
          draft: args,
          sourceContext,
          vocabularyResolver: ({ question: source }) => this.skillRegistry.resolveCoreSkill(
            'business_vocabulary', { question: source }, skills,
          ),
        });
      } else if (sourceType === 'BUSINESS_DATASET') {
        const datasetId = String(args.datasetId ?? '');
        if (!datasetId) {
          throw new Error('compile_query_contract requires datasetId');
        }
        if (!confirmationState.confirmedDatasetIds.has(datasetId)) {
          throw new Error('必须先确认业务数据集字段口径后才能编译查询契约');
        }
        const confirmed = confirmationState.datasetDefinitions.get(datasetId);
        const dataset = confirmed?.dataset
          ?? businessDatasets.find((item) => String(item.id) === datasetId);
        if (!dataset) {
          throw new Error('business dataset permission denied');
        }
        const fields = confirmed?.fields
          ?? await this.businessDatasets.getDatasetFieldsAsync(dataset.id, true);
        result = this.queryContractCompiler.compile({
          question: resolvedQuestion,
          sourceType,
          dataset,
          datasetFields: fields,
          theme,
          scope,
          draft: args,
          sourceContext,
          vocabularyResolver: ({ question: source }) => this.skillRegistry.resolveCoreSkill(
            'business_vocabulary', { question: source }, skills,
          ),
        });
      } else {
        throw new Error(`unsupported query contract sourceType: ${sourceType || '-'}`);
      }

      const contractId = result.valid ? result.contract.id : null;
      if (result.valid) {
        compiledContracts.set(result.contract.id, {
          ...result.contract,
          userId: user.id,
          themeId: theme.id,
          sessionId: session.id,
        });
      }
      await saveQueryPlan({
        id: result.contract.id,
        userId: user.id,
        themeId: theme.id,
        sessionId: session.id,
        sourceType,
        datasetId: result.contract.datasetId,
        question: resolvedQuestion,
        status: result.valid ? 'CONTRACT_READY' : 'CONTRACT_REJECTED',
        plan: {
          ...result.contract,
          draft: args,
        },
        validation: {
          valid: result.valid,
          issues: result.issues,
          checkedAt: new Date().toISOString(),
          stage: 'CONTRACT_GATE',
        },
      });
      if (!result.valid && options.fastPath) {
        emit({
          type: 'warning',
          code: 'SEMANTIC_FAST_PATH_REJECTED',
          message: '语义快车道未通过完整门禁，自动回退到 DataAgent 工作流。',
          issues: result.issues,
        });
        return {
          valid: false,
          contractId,
          issues: result.issues,
          coverage: result.contract.coverage,
          normalized: null,
          fastPathRejected: true,
        };
      }
      if (result.valid) {
        invalidContractAttempts = 0;
        pendingValueCandidates = [];
        pendingSemanticSpans = [];
        pendingModelClarification = null;
      } else {
        invalidContractAttempts += 1;
        pendingValueCandidates = collectValueCandidates(result.issues);
        pendingSemanticSpans = result.contract?.unresolvedSemanticSpans ?? [];
        if (invalidContractAttempts >= 4) {
          const contractError = new Error(
            `查询契约连续 ${invalidContractAttempts} 次未通过：${
              result.issues.map((issue) => issue.message).join('；')
            }`,
          );
          contractError.terminal = true;
          contractError.code = 'CONTRACT_GATE_EXHAUSTED';
          throw contractError;
        }
      }
      if (result.valid) {
        const pipelineSummary = result.contract.analysisPipeline
          ? `；通用分析管线 ${result.contract.analysisPipeline.stages.length} 个阶段`
          : '';
        completeWorkflowStage('PLAN', {
          summary: '查询契约编译通过',
          detail: `${result.contract.metricFields.length} 个指标字段，${
            result.contract.dimensionFields.length
          } 个维度，${result.contract.filterFields.length} 个过滤条件，${
            result.contract.timeWindows.length
          } 个时间窗口${pipelineSummary}`,
          evidence: [{
            type: 'QUERY_CONTRACT',
            id: result.contract.id,
          }],
        });
      } else {
        failWorkflowStage(
          'PLAN',
          new Error(result.issues.map((issue) => issue.message).join('；')),
        );
      }
      emit({
        type: 'contract_compiled',
        contractId,
        valid: result.valid,
        issues: result.issues,
        contract: result.contract,
        durationMs: Date.now() - startedAt,
      });
      return {
        valid: result.valid,
        contractId,
        issues: result.issues,
        coverage: result.contract.coverage,
        normalized: {
          sourceType,
          indicatorId: result.contract.indicatorId,
          datasetId: result.contract.datasetId,
          metrics: result.contract.metricFields.map((item) => item.field),
          dimensions: result.contract.dimensionFields.map((item) => item.field),
          filters: result.contract.filterFields,
          scopeModifiers: result.contract.scopeModifiers,
          timeWindows: result.contract.timeWindows,
          timeGrain: result.contract.timeGrain,
          calculation: result.contract.calculation,
          analysisPipeline: result.contract.analysisPipeline,
          limit: result.contract.limit,
        },
      };
    };

    const executeQueryContract = async (args) => {
      startWorkflowStage('VALIDATE', '校验查询契约');
      const contractId = String(args.contractId ?? '');
      const contract = compiledContracts.get(contractId);
      if (!contract) {
        throw new Error('查询契约不存在或已失效，请重新编译后再执行');
      }
      let indicator = null;
      let dataset = null;
      if (contract.sourceType === 'INDICATOR') {
        indicator = confirmationState.indicatorDetails.get(String(contract.indicatorId));
        if (!indicator) {
          throw new Error('查询契约缺少已确认的指标口径');
        }
      } else if (contract.sourceType === 'BUSINESS_DATASET') {
        const confirmed = confirmationState.datasetDefinitions.get(String(contract.datasetId));
        dataset = confirmed?.dataset ?? null;
        if (!dataset) {
          throw new Error('查询契约缺少已确认的数据集口径');
        }
      }
      const review = this.queryContractCompiler.review(contract, {
        indicator,
        dataset,
        theme,
        scope,
      });
      if (!review.valid) {
        throw new Error(
          `查询契约门禁未通过：${review.issues.map((issue) => issue.message).join('；')}`,
        );
      }
      completeWorkflowStage('VALIDATE', {
        summary: '能力门禁校验通过',
        detail: '逐项条件、字段绑定、时间和规则来源均已覆盖',
        evidence: [{ type: 'QUERY_CONTRACT', id: contract.id }],
      });
      if (contract.sourceType === 'INDICATOR') {
        const result = await runQuery({
          indicatorId: contract.indicatorId,
          __contract: contract,
        });
        return {
          ...result,
          stopAgent: true,
          finalMessage: result?.finalMessage ?? result?.summary ?? '',
        };
      }
      const result = await runBusinessDatasetQuery({
        datasetId: contract.datasetId,
        __contract: contract,
      });
      return {
        ...result,
        stopAgent: true,
        finalMessage: result?.finalMessage ?? result?.summary ?? '',
      };
    };

    // 长期记忆检索是只读旁路：常驻上下文只放摘要，正文由这个处理器按需读取。
    const handleUserMemoryTool = createUserMemoryToolHandler({
      store: this.userMemories,
      user,
      themeId: theme?.id ?? null,
    });

    const datasetToolHandlers = createAgentDatasetToolHandlers({
      businessDatasets,
      datasetService: this.businessDatasets,
      getBusinessDatasetDefinition,
      runBusinessDatasetQuery,
      startWorkflowStage,
      completeWorkflowStage,
    });
    const workspaceToolHandlers = createAgentWorkspaceToolHandlers({
      workspace,
      workspaceService: this.workspace,
      user,
      session,
      codeExecution: this.codeExecution,
      resolvedQuestion,
      getLastBusinessDataset: () => lastBusinessDataset,
      getLastIndicator: () => lastIndicator,
      buildArtifactTitle,
      generatedCodeArtifacts,
      generatedWorkspaceArtifactIds,
      emit,
      validateAnalysisOutputsAsync,
    });

    const executeRawTool = async (name, args) => {
      if (name === 'request_clarification') {
        // 澄清预算耗尽时不再允许反问：工具直接报错，逼模型按已有信息执行或报能力缺口。
        if (clarificationPolicy?.allowed === false) {
          throw new Error(
            '本轮已达到澄清上限，不得再向用户反问；请基于已确认的规则执行，或明确报告能力缺口。',
          );
        }
        const question = String(args?.question ?? '').trim();
        const options = Array.isArray(args?.options) ? args.options : [];
        if (!question || options.length < 2) {
          throw new Error('request_clarification 需要 question 和至少 2 个候选项');
        }
        pendingModelClarification = { question, options };
        return { accepted: true, optionCount: options.length };
      }
      if (name === 'compile_query_contract') {
        return compileQueryContract(args);
      }
      if (name === 'execute_query_contract') {
        return executeQueryContract(args);
      }
      if (
        localIndicatorMode
        && ['search_indicators', 'get_indicator', 'query_indicator'].includes(name)
      ) {
        throw new Error('指标平台模块已停用，指标工具不可用');
      }
      if (
        indicatorSourceState.source === 'UNAVAILABLE'
        && ['search_indicators', 'get_indicator', 'query_indicator'].includes(name)
      ) {
        const sourceError = new Error(
          '指标目录来源不可用（SOURCE-002）：指标平台读取失败且无可用快照，不得继续指标查询。',
        );
        sourceError.code = 'INDICATOR_SOURCE_UNAVAILABLE';
        sourceError.gateId = 'SOURCE-002';
        throw sourceError;
      }
      switch (name) {
        case 'search_user_memory':
          return handleUserMemoryTool(name, args);
        case 'search_indicators':
          return searchIndicators(args.keyword ?? '', args.limit);
        case 'get_indicator':
          return getIndicator(args.indicatorId);
        case 'query_indicator':
          return runQuery(args);
        case 'list_business_datasets':
          return datasetToolHandlers.listBusinessDatasets();
        case 'get_business_dataset_definition':
          return datasetToolHandlers.getBusinessDatasetDefinition(args);
        case 'query_business_dataset':
          return datasetToolHandlers.runBusinessDatasetQuery(args);
        case 'list_workspace_artifacts':
          return workspaceToolHandlers.listWorkspaceArtifacts();
        case 'transform_workspace_artifact':
          return workspaceToolHandlers.transformWorkspaceArtifact(args);
        case 'execute_analysis_code':
          return workspaceToolHandlers.executeAnalysisCode(args);
        default:
          throw new Error(`unsupported tool: ${name}`);
      }
    };

    const executeTool = createAgentToolExecutor({
      skillRegistry: this.skillRegistry, skills, processSteps, appendProcessStep, emit,
      executeRawTool, describeToolStep, buildToolReview, recordProcessArtifact,
      toolStageCode,
    });

    const workspaceArtifactList = workspace && this.workspace
      ? (this.workspace.listArtifactsAsync
        ? await this.workspace.listArtifactsAsync({ workspaceId: workspace.id, userId: user.id })
        : this.workspace.listArtifacts({ workspaceId: workspace.id, userId: user.id }))
      : [];
    const workspaceArtifacts = await Promise.all(
      workspaceArtifactList.filter((artifact) => artifact.artifactType !== 'PROCESS_STEP').slice(0, 12).map(async (artifact) => {
        const full = this.workspace.getArtifactAsync
          ? await this.workspace.getArtifactAsync({ artifactId: artifact.id, userId: user.id })
          : this.workspace.getArtifact({ artifactId: artifact.id, userId: user.id });
        const columns = full?.payload?.data?.columns ?? [];
        return {
          ...artifact,
          columns: columns.map((column) => ({
            name: column.name,
            bizName: column.bizName,
            showType: column.showType ?? column.type,
            unit: column.unit ?? '',
          })),
          sampleRows: full?.payload?.data?.rows?.slice(0, 3) ?? [],
          queryFingerprint: full?.metadata?.queryFingerprint ?? null,
          dataHash: full?.metadata?.dataHash ?? null,
          source: full?.metadata?.source ?? null,
          inputArtifactIds: full?.metadata?.inputArtifactIds
            ?? full?.metadata?.parentArtifactIds
            ?? [],
          lineageQuestion: full?.metadata?.lineageQuestion ?? '',
          capabilities: full?.metadata?.capabilities
            ?? buildArtifactCapabilities({
              sourceType: full?.metadata?.source?.type,
              source: full?.metadata?.source,
              data: full?.payload?.data,
              semanticParse: full?.payload?.semanticParse,
              queryFingerprint: full?.metadata?.queryFingerprint,
              dataHash: full?.metadata?.dataHash,
            }),
        };
      }),
    );
    const artifactReusePolicy = resolveArtifactReusePolicy(
      normalizedQuestion,
      conversationContext,
      workspaceArtifacts.length,
    );
    const reuseArtifactsOnly = artifactReusePolicy.reuseArtifactsOnly;
    const controlledRequeryAllowed = artifactReusePolicy.controlledRequeryAllowed;
    skillAudit = await (this.skillRegistry?.auditPlanningContextAsync?.({
      skills,
      question: resolvedQuestion,
      theme,
      businessDatasets,
      primaryBusinessDatasetId,
    }) ?? this.skillRegistry?.auditPlanningContext?.({
      skills,
      question: resolvedQuestion,
      theme,
      businessDatasets,
      primaryBusinessDatasetId,
    }) ?? null);
    if (skillAudit?.skillCount > 0) {
      startWorkflowStage('SKILL_AUDIT', '执行 Skill 口径审计');
      appendProcessStep({
        id: `step-${processSteps.length + 1}`,
        type: 'skill_audit',
        stageCode: 'SKILL_AUDIT',
        status: 'success',
        name: 'audit_planning_context',
        skillCode: 'skill_registry',
        skillName: 'Skill Registry',
        title: '执行 Skill 口径审计',
        detail: `加载 ${skillAudit.skillCount} 个外部 Skill，形成 ${skillAudit.checks.length} 项规划检查`,
        review: {
          facts: [
            { label: '审计 Skill', value: String(skillAudit.skillCount) },
            { label: '检查项', value: String(skillAudit.checks.length) },
          ],
          details: {
            skills: skillAudit.guidance.map((item) => ({
              code: item.code,
              name: item.name,
            })),
            checks: skillAudit.checks,
          },
        },
      });
      completeWorkflowStage('SKILL_AUDIT', {
        summary: `完成 ${skillAudit.skillCount} 个 Skill 的规划前口径审计`,
        detail: '已校验数据来源、行粒度、时间口径和业务范围，并注入查询契约约束。',
        evidence: skillAudit.guidance.map((item) => ({
          type: 'SKILL',
          id: item.code,
          name: item.name,
          phase: item.phase,
        })),
      });
    } else {
      workflow.skip('SKILL_AUDIT', '当前主题未启用外部审计 Skill');
    }
    const skillValidationGuidance = this.skillRegistry?.buildPhaseInstructionsAsync
      ? await this.skillRegistry.buildPhaseInstructionsAsync(skills, 'POST_EXECUTE')
      : this.skillRegistry?.buildPhaseInstructions(skills, 'POST_EXECUTE') ?? [];
    const skillPlanGuidance = this.skillRegistry?.buildPhaseInstructionsAsync
      ? await this.skillRegistry.buildPhaseInstructionsAsync(skills, 'PLAN')
      : this.skillRegistry?.buildPhaseInstructions(skills, 'PLAN') ?? [];
    const systemPrompt = buildSystemPrompt({
      user,
      theme,
      scope,
      indicators: allowedIndicators,
      skills,
      feedbackHints,
      skillAuditInstructions: skillAudit?.guidance ?? [],
      skillPlanInstructions: skillPlanGuidance,
      skillValidationInstructions: skillValidationGuidance,
      businessDatasets,
      localIndicatorMode,
      workspaceArtifacts,
      contextMode: conversationContext.mode,
      contextReason: conversationContext.reason,
      inheritQueryContext: conversationContext.inheritQueryContext,
      historyMessageCount: conversationContext.historyMessageCount,
      taskState: conversationContext.taskState,
      executionContext: executionContext.sourceContext,
      analysisMode,
      clarificationPolicy,
      clarificationOptionId,
      reuseArtifactsOnly,
      controlledRequeryAllowed,
      question: resolvedQuestion,
      replanHint,
      conversationDirectives: sessionDirectives,
    });
    let enabledTools = this.skillRegistry.filterTools(TOOL_DEFINITIONS, skills);
    if (localIndicatorMode) {
      const disabledIndicatorTools = new Set([
        'search_indicators',
        'get_indicator',
        'query_indicator',
      ]);
      enabledTools = enabledTools.filter(
        (tool) => !disabledIndicatorTools.has(tool.function?.name),
      );
    }
    if (businessDatasets.length > 0) {
      enabledTools = enabledTools.filter(
        (tool) => tool.function?.name !== 'query_indicator',
      );
    }
    if (reuseArtifactsOnly) {
      const disallowedReuseTools = new Set([
        'search_indicators',
        'get_indicator',
        'query_indicator',
      ]);
      enabledTools = enabledTools.filter(
        (tool) => !disallowedReuseTools.has(tool.function?.name),
      );
    }
    if (!reuseArtifactsOnly && (businessDatasets.length > 0 || localIndicatorMode)) {
      const executionSourceType = businessDatasets.length > 0
        ? 'BUSINESS_DATASET'
        : 'INDICATOR';
      enabledTools = enabledTools.map((tool) => {
        if (tool.function?.name !== 'compile_query_contract') {
          return tool;
        }
        const parameters = JSON.parse(JSON.stringify(tool.function.parameters ?? {}));
        parameters.properties ??= {};
        parameters.properties.sourceType = {
          ...(parameters.properties.sourceType ?? {}),
          enum: [executionSourceType],
        };
        return {
          ...tool,
          function: {
            ...tool.function,
            description: [
              tool.function.description,
              localIndicatorMode
                ? 'Indicator-platform matching is disabled. Use BUSINESS_DATASET only; map business terms directly from the dataset definition, semantic policy and theme prompt.'
                : executionSourceType === 'BUSINESS_DATASET'
                ? 'This theme is bound to a business dataset. The contract sourceType MUST be BUSINESS_DATASET; use indicators only to confirm business definitions and formulas.'
                : 'No business dataset is bound to this theme. The contract sourceType MUST be INDICATOR.',
            ].filter(Boolean).join(' '),
            parameters,
          },
        };
      });
    } else if (localIndicatorMode && businessDatasets.length === 0) {
      enabledTools = enabledTools.filter(
        (tool) => !['compile_query_contract', 'execute_query_contract'].includes(
          tool.function?.name,
        ),
      );
    }
    let harnessResult;
    let semanticFastPathUsed = false;
    let semanticFastPathError = null;
    const canUseSemanticFastPath = businessDatasets.length > 0
      && !reuseArtifactsOnly
      && conversationContext.turnType !== TURN_TYPES.INSTRUCTION
      && ['NEW_TOPIC', 'INDEPENDENT'].includes(conversationContext.mode);
    if (canUseSemanticFastPath) {
      const preferredDataset = businessDatasets.find(
        (dataset) => Number(dataset.id) === Number(primaryBusinessDatasetId),
      );
      const fastDataset = preferredDataset
        ?? (businessDatasets.length === 1 ? businessDatasets[0] : null);
      if (fastDataset) {
        const fastPathStartedAt = Date.now();
        try {
          const definition = await getBusinessDatasetDefinition({
            datasetId: fastDataset.id,
          });
          const fastPath = buildSemanticFastPathDraft({
            question: resolvedQuestion,
            theme,
            datasetFields: definition.fields ?? [],
          });
          if (!fastPath.eligible) {
            throw Object.assign(new Error(fastPath.reason), { semanticFastPathIneligible: true });
          }
          startWorkflowStage('SEMANTIC_DISCOVERY', '语义快车道检索业务数据集');
          completeWorkflowStage('SEMANTIC_DISCOVERY', {
            summary: `语义包唯一命中，优先使用数据集「${fastDataset.name}」`,
            detail: `${fastPath.metricMatches.length} 个指标口径，${fastPath.timeMentions.length} 个时间窗口`,
          });
          emit({
            type: 'semantic_fast_path',
            metric: fastPath.metricMatches[0].concept,
            datasetId: fastDataset.id,
            reason: fastPath.reason,
          });
          const compiled = await compileQueryContract({
            ...fastPath.draft,
            sourceType: 'BUSINESS_DATASET',
            datasetId: fastDataset.id,
          }, { fastPath: true });
          if (compiled.valid) {
            await executeQueryContract({
              contractId: compiled.contractId,
            });
            semanticFastPathUsed = true;
            harnessResult = {
              content: '',
              trace: [],
              semanticFastPath: true,
            };
            appendProcessStep({
              id: `step-${processSteps.length + 1}`,
              type: 'semantic_fast_path',
              stageCode: 'EXECUTE',
              status: 'success',
              name: 'execute_semantic_fast_path',
              skillCode: 'semantic_policy',
              skillName: '语义快车道',
              title: '语义包确定性执行',
              detail: `${fastPath.metricMatches[0].concept} 已由主题语义包唯一解析，直接编译契约并查询`,
              durationMs: Date.now() - fastPathStartedAt,
            });
          }
        } catch (error) {
          if (!error.semanticFastPathIneligible) {
            semanticFastPathError = error;
            emit({
              type: 'warning',
              code: 'SEMANTIC_FAST_PATH_FAILED',
              message: `语义快车道执行失败，已回退到 DataAgent 工作流：${error.message}`,
            });
          }
        }
      }
    }
    // “换个图表类型”是展示层操作：复用上一轮锁定结果按请求类型原生渲染，
    // 不重新取数、不生成图表图片，也不让模型介入。
    let chartRestyleApplied = false;
    // 用本轮原始问法判断，避免上下文补全后的长问题把展示层诉求误判成新取数。
    const restyleChartType = detectChartRestyle(normalizedQuestion);
    if (restyleChartType && this.workspace && workspace) {
      const snapshotRef = selectReusableSnapshot(workspaceArtifacts);
      const snapshot = snapshotRef
        ? (this.workspace.getArtifactAsync
          ? await this.workspace.getArtifactAsync({ artifactId: snapshotRef.id, userId: user.id })
          : this.workspace.getArtifact({ artifactId: snapshotRef.id, userId: user.id }))
        : null;
      const snapshotColumns = snapshot?.payload?.data?.columns ?? [];
      const snapshotRows = snapshot?.payload?.data?.rows ?? [];
      if (snapshot && snapshotColumns.length > 0) {
        const chart = suggestChart({
          columns: snapshotColumns,
          rows: snapshotRows,
          question: snapshot.metadata?.lineageQuestion ?? resolvedQuestion,
          preferred: restyleChartType,
        });
        const outcome = buildChartRestyleOutcome({
          snapshot,
          rows: snapshotRows,
          chartType: restyleChartType,
          chart,
        });
        const snapshotSource = snapshot.metadata?.source ?? null;
        const sourceId = snapshotSource?.id != null ? String(snapshotSource.id) : null;
        lastQueryResult = { columns: snapshotColumns, rows: snapshotRows };
        lastChart = chart;
        lastSemanticParse = snapshot.payload?.semanticParse ?? null;
        // 还原结果来源，保证引用同一个 artifact 的展示层回答也能通过来源校验。
        lastBusinessDataset = snapshotSource?.type === 'BUSINESS_DATASET'
          ? { ...(businessDatasets.find((dataset) => String(dataset.id) === sourceId) ?? { id: snapshotSource.id, name: snapshotSource.name ?? null }),
            dbType: lastSemanticParse?.matchedDataset?.dbType }
          : null;
        lastIndicator = snapshotSource?.type === 'INDICATOR'
          ? allowedIndicators.find((item) => String(item.id) === sourceId)
            ?? { id: snapshotSource.id, name: snapshotSource.name ?? null }
          : null;
        queryExecutions.push(outcome.reuseRecord);
        lastLockedExecution = outcome.reuseRecord;
        harnessResult = { content: '', trace: [] };
        chartRestyleApplied = true;
        completeWorkflowStage('EXECUTE', outcome.executeStage);
        completeWorkflowStage('ANALYZE', outcome.analyzeStage);
        appendProcessStep({
          id: `step-${processSteps.length + 1}`,
          ...outcome.processStep,
        });
        emit({
          type: 'chart_restyle',
          chartType: chart.type,
          artifactId: snapshot.id,
        });
      }
    }
    try {
      if (conversationContext.turnType === TURN_TYPES.INSTRUCTION) {
        const confirmation = conversationDirective?.confirmation
          ?? '收到，本会话会按你的要求处理；这条消息不触发数据查询。';
        await this.saveSessionDirective(session.id, user.id, conversationDirective);
        appendProcessStep({
          id: `step-${processSteps.length + 1}`,
          type: 'directive',
          stageCode: 'INTENT',
          status: 'success',
          name: 'conversation_directive',
          skillCode: null,
          skillName: '会话指令',
          title: '更新会话偏好',
          detail: conversationDirective
            ? describeConversationDirective(conversationDirective)
            : '已识别为会话指令，本轮不执行数据查询',
        });
        emit({
          type: 'conversation_directive',
          directive: conversationDirective,
          message: confirmation,
        });
        emit({
          type: 'runtime_response',
          provider: 'platform-directive',
          model: 'conversation-directive',
          content: confirmation,
          toolCalls: [],
        });
        harnessResult = { content: confirmation, trace: [] };
      } else if (chartRestyleApplied) {
        emit({
          type: 'runtime_response',
          provider: 'platform-native-chart',
          model: 'chart-restyle',
          content: '',
          toolCalls: [],
        });
      } else if (!semanticFastPathUsed) {
        harnessResult = await activeHarness.run({
          messages: [
            { role: 'system', content: systemPrompt },
            ...(executionContext.systemMessage ? [executionContext.systemMessage] : []),
            {
              role: 'user',
              content: replanHint
                ? `${resolvedQuestion}\n\n[反思重规划提示] ${replanHint}`
                : resolvedQuestion,
            },
          ],
          tools: enabledTools,
          executeTool,
          metadata: {
            userId: user.id,
            sessionId: session.id,
            themeId: theme.id,
            question: normalizedQuestion,
            sourceMode: localIndicatorMode
              ? this.indicatorService.mode ?? 'unknown'
              : 'direct-llm',
            preferBusinessDatasets: businessDatasets.length > 0,
            primaryBusinessDatasetId,
            analysisMode: analysisMode.mode,
            clarificationPolicy,
            clarificationOptionId,
            reuseArtifactsOnly,
            signal,
          },
          onEvent: emit,
        });
      } else {
        emit({
          type: 'runtime_response',
          provider: 'deterministic-semantic-policy',
          model: 'platform-fast-path',
          content: '',
          toolCalls: toolTrace
            .filter((item) => item.type === 'tool_call')
            .map((item) => ({ name: item.name, args: item.args })),
        });
      }
    } catch (error) {
      try {
        await this.growth?.record({
          term: normalizedQuestion,
          kind: 'EXECUTION',
          source: 'AGENT_RUNTIME',
          context: {
            themeId: theme.id,
            userId: user.id,
            sessionId: session.id,
            error: error.message,
          },
        });
      } catch {
        // A failed telemetry write must not replace the query failure.
      }
      const failureMessage = `本次查询失败：${error.message}`;
      if (!recoveryMode) {
        await this.memory.appendAssistantMessageAsync(session.id, user.id, failureMessage, {
          error: error.message,
          question: normalizedQuestion,
          resolvedQuestion,
          turnType: conversationContext.turnType,
          taskId: conversationContext.taskId,
          turnId: conversationContext.turnId,
          taskState: { ...conversationContext.taskState, status: 'FAILED' },
          contextDecision: publicContextDecision(conversationContext),
          processSteps,
          skills: skills.map((skill) => ({
            code: skill.code,
            name: skill.name,
            kind: skill.kind,
          })),
        });
        error.persisted = true;
      }
      if (!recoveryMode) emit({
        type: 'error',
        message: error.message,
        processSteps,
        workflow: workflow.toJSON(),
      });
      error.recoveryContext = {
        sessionId: session.id,
        phase: workflow.stages.find((stage) => stage.status === 'RUNNING')?.code
          ?? workflow.stages.find((stage) => stage.status === 'FAILED')?.code
          ?? null,
        completedStages: workflow.stages
          .filter((stage) => ['SUCCESS', 'FAILED', 'SKIPPED'].includes(stage.status))
          .map((stage) => ({ code: stage.code, status: stage.status, summary: stage.summary ?? '' })),
        processSteps: processSteps.slice(-12).map((step) => ({
          title: step.title,
          status: step.status,
          detail: step.detail ?? '',
        })),
      };
      throw error;
    }
    toolTrace.push(...(harnessResult.trace ?? []));
    const canRunDeterministicFallback = false;
    if (canRunDeterministicFallback && allowedIndicators.length > 0) {
      const candidates = rankIndicators(
        allowedIndicators,
        resolvedQuestion,
        3,
        resolveBusinessLexicon(theme),
        theme.systemPrompt,
      );
      for (const candidate of candidates) {
        try {
          if (!confirmationState.indicatorSearchCompleted) {
            await executeTool('search_indicators', {
              keyword: resolvedQuestion,
              limit: 6,
            });
          }
          const detail = await executeTool('get_indicator', {
            indicatorId: candidate.indicator.id,
          });
          const inferred = inferIndicatorQuerySpec({
            question: resolvedQuestion,
            metrics: detail.metrics ?? [],
            dimensions: detail.dimensions ?? [],
            fallbackMetrics: [],
            fallbackDimensions: [],
            dateField: selectDateField(detail.dimensions ?? []),
            lexicon: resolveBusinessLexicon(theme),
            vocabularyResolver: ({ question: source }) => this.skillRegistry.resolveCoreSkill(
              'business_vocabulary',
              { question: source },
              skills,
            ),
          });
          if (inferred.metrics.length === 0) {
            continue;
          }
          await executeTool('query_indicator', {
            indicatorId: candidate.indicator.id,
            metricNames: inferred.metrics,
            dimensions: inferred.dimensions,
            limit: inferred.limit,
          });
          break;
        } catch (error) {
          emit({
            type: 'warning',
            code: 'DETERMINISTIC_INDICATOR_FALLBACK_FAILED',
            message: `自动指标查询失败：${error.message}`,
          });
        }
      }
    }
    if (
      queryExecutions.length === 0
      && canRunDeterministicFallback
      && businessDatasets.length > 0
    ) {
      const candidates = (await Promise.all(businessDatasets
        .map(async (dataset) => {
          const fields = await this.businessDatasets.getDatasetFieldsAsync(dataset.id, true);
          const inferred = inferDatasetQuerySpec({
            question: resolvedQuestion,
            fields,
            fallbackMetrics: [],
            fallbackDimensions: [],
            vocabularyResolver: ({ question: source }) => this.skillRegistry.resolveCoreSkill(
              'business_vocabulary',
              { question: source },
              skills,
            ),
          });
          const dateRange = buildDatasetDateRange(
            resolvedQuestion,
            fields,
            null,
            ({ question: source }) => this.skillRegistry.resolveCoreSkill(
              'temporal_expression',
              { question: source },
              skills,
            ),
          );
          return { dataset, fields, inferred, dateRange };
        })))
        .filter((candidate) => candidate.inferred.metrics.length > 0)
        .filter((candidate) => (
          candidate.dataset.config?.requireDateRange === false
          || Boolean(candidate.dateRange)
        ))
        .sort((left, right) => (
          right.inferred.metrics.length - left.inferred.metrics.length
          || right.inferred.dimensions.length - left.inferred.dimensions.length
          || Number(left.dataset.id) - Number(right.dataset.id)
        ));
      const candidate = candidates[0];
      if (candidate) {
        try {
          await executeTool('get_business_dataset_definition', {
            datasetId: candidate.dataset.id,
          });
          await executeTool('query_business_dataset', {
            datasetId: candidate.dataset.id,
            metrics: candidate.inferred.metrics,
            dimensions: candidate.inferred.dimensions,
            dateRange: candidate.dateRange,
            order: candidate.inferred.order,
            limit: candidate.inferred.limit,
          });
        } catch (error) {
          emit({
            type: 'warning',
            code: 'DETERMINISTIC_DATASET_FALLBACK_FAILED',
            message: `自动业务数据集查询失败：${error.message}`,
          });
        }
      }
    }
    if (lastQueryResult?.rows?.length > 0) {
      startWorkflowStage('RESULT_ANALYST', '分析查询结果');
      resultAnalysis = analyzeWithPlugins({
        columns: lastQueryResult.columns,
        rows: lastQueryResult.rows,
        policy: theme.semanticPolicy,
      });
      appendProcessStep({
        id: `step-${processSteps.length + 1}`,
        type: 'analysis',
        stageCode: 'RESULT_ANALYST',
        status: 'success',
        name: 'analyze_query_result',
        skillCode: 'core.result_analyst',
        skillName: '结果分析器',
        title: '生成结果分析',
        detail: resultAnalysis.facts
          ? `${resultAnalysis.facts.rowCount} 行，${resultAnalysis.facts.topBottom.length} 组 TopN，${resultAnalysis.facts.trends.length} 组趋势`
          : '无可用分析事实',
        review: {
          details: resultAnalysis,
        },
      });
      completeWorkflowStage('RESULT_ANALYST', {
        summary: '完成合计、TopN、趋势和异常分析',
        detail: buildResultAnalysisText(resultAnalysis.facts),
        evidence: [{
          type: 'ANALYSIS_PLUGIN',
          id: resultAnalysis.plugin?.id ?? 'core.result_analyst',
          name: resultAnalysis.plugin?.name ?? '结果分析器',
        }],
      });
    } else {
      workflow.skip('RESULT_ANALYST', '本轮没有可分析的结果数据');
    }

    if (queryExecutions.length > 0) {
      startWorkflowStage('RESULT_VALIDATION', '执行 Skill 结果验证');
      resultValidation = await (this.skillRegistry?.validateQueryResultAsync?.({
        skills,
        question: resolvedQuestion,
        semanticParse: lastSemanticParse,
        dataset: lastBusinessDataset,
        indicator: lastIndicator,
        data: lastQueryResult,
      }) ?? this.skillRegistry?.validateQueryResult?.({
        skills,
        question: resolvedQuestion,
        semanticParse: lastSemanticParse,
        dataset: lastBusinessDataset,
        indicator: lastIndicator,
        data: lastQueryResult,
      }) ?? null);
      const validationStatus = resultValidation?.status ?? 'SKIPPED';
      appendProcessStep({
        id: `step-${processSteps.length + 1}`,
        type: 'skill_validation',
        stageCode: 'RESULT_VALIDATION',
        status: validationStatus === 'FAILED'
          ? 'error'
          : validationStatus === 'WARNING'
            ? 'warning'
            : validationStatus === 'SKIPPED'
              ? 'skipped'
              : 'success',
        name: 'validate_query_result',
        skillCode: 'skill_registry',
        skillName: 'Skill Registry',
        title: '执行 Skill 结果验证',
        detail: resultValidation
          ? `${resultValidation.skillCount} 个验证 Skill，${resultValidation.checks.length} 项检查`
          : '当前主题未启用外部结果验证 Skill',
        review: {
          details: resultValidation ?? { status: 'SKIPPED' },
        },
      });
      if (validationStatus === 'FAILED') {
        failWorkflowStage(
          'RESULT_VALIDATION',
          new Error(
            resultValidation.checks
              .filter((check) => check.level === 'ERROR')
              .map((check) => check.message)
              .join('；') || '结果验证未通过',
          ),
        );
      } else if (validationStatus === 'SKIPPED') {
        workflow.skip('RESULT_VALIDATION', '当前主题未启用外部结果验证 Skill');
      } else {
        completeWorkflowStage('RESULT_VALIDATION', {
          summary: validationStatus === 'WARNING'
            ? '结果验证完成，存在需要关注的检查项'
            : '结果验证通过',
          detail: resultValidation.checks
            .filter((check) => check.level !== 'INFO')
            .map((check) => check.message)
            .join('；'),
          evidence: resultValidation.guidance.map((item) => ({
            type: 'SKILL',
            id: item.code,
            name: item.name,
            phase: item.phase,
          })),
        });
      }
    }
    startWorkflowStage('RESPOND', '生成最终回答');
    appendProcessStep({
      id: `step-${processSteps.length + 1}`,
      type: 'response',
      stageCode: 'RESPOND',
      status: 'success',
      name: 'generate_response',
      skillCode: null,
      skillName: '结果生成',
      title: '生成业务回答',
      detail: lastLockedExecution
        ? `基于锁定的 ${lastQueryResult?.rows.length ?? 0} 行查询结果生成确定性回答`
        : '整合智能体回答',
      startedAt: new Date().toISOString(),
      durationMs: Date.now() - answerStartedAt,
    });

    const clarificationExhausted = queryExecutions.length === 0
      && analysisMode.mode === 'ATTRIBUTION'
      && !clarificationPolicy.allowed
      && isClarificationText(harnessResult.content);
    const currentExecutions = queryExecutions.slice(carriedExecutionCount);
    const deterministicMessage = currentExecutions.length > 0
      ? currentExecutions.map((execution) => execution.finalMessage).join('\n\n')
      : '';
    // 过滤值歧义优先：候选值一旦存在，本轮只问「选哪个值」，用它覆盖模型那段
    // 口径反问。值确定后下一轮会重新编译契约，剩余阻塞项届时再按规则处理。
    const valueClarificationAllowed = clarificationPolicy?.allowed !== false;
    const valueClarification = lastQueryResult
      ? null
      : buildValueClarification(pendingValueCandidates, { allowed: valueClarificationAllowed });
    const semanticSpanClarification = lastQueryResult || valueClarification
      ? null
      : buildSemanticSpanClarification(
        collectSemanticSpanGroups(pendingSemanticSpans),
        { allowed: valueClarificationAllowed },
      );
    const modelClarification = lastQueryResult
      ? null
      : buildModelClarification(
        pendingModelClarification ?? {},
        { allowed: valueClarificationAllowed },
      );
    const validationWarnings = resultValidation?.checks
      ?.filter((check) => check.level === 'ERROR' || check.level === 'WARN')
      .map((check) => `- ${check.message}`) ?? [];
    const analysisText = resultAnalysis && !chartRestyleApplied && !deterministicMessage && !carryForward
      ? buildResultAnalysisText(resultAnalysis.facts)
      : '';
    const { baseMessage: baseFinalMessage } = composeAnswerMessage({
      deterministicMessage,
      semanticFastPathError: queryExecutions.length === 0 ? semanticFastPathError : null,
      clarificationExhausted,
      harnessContent: harnessResult.content,
      carryForwardSummary: carryForward?.lastSummary,
      datasetName: lastBusinessDataset?.name,
    });
    let activeClarification = valueClarification
      ?? semanticSpanClarification
      ?? modelClarification;
    let answerEvidence = buildAnswerEvidence({
      semanticParse: lastSemanticParse,
      data: lastQueryResult,
      queryFingerprint: lastLockedExecution?.queryFingerprint ?? null,
      dataHash: lastLockedExecution?.dataHash ?? null,
      executionCount: queryExecutions.length,
    });
    const groundingGuardCandidate = requiresGroundedAnswer({
      analysisMode,
      contextReason: conversationContext.reason,
      hasClarification: Boolean(activeClarification),
    }) && conversationContext.turnType !== TURN_TYPES.INSTRUCTION && !answerEvidence.grounded;
    const groundingGuardApplied = groundingGuardCandidate
      && looksLikeDataClaim(baseFinalMessage);
    if (groundingGuardApplied) {
      activeClarification = buildClarificationFromModule({
        message: UNGROUNDED_ANSWER_MESSAGE,
        clarificationPolicy,
      }) ?? {
        type: 'NEEDS_CONFIRMATION',
        prompt: UNGROUNDED_ANSWER_MESSAGE,
        recommendedOptionId: 'cancel',
        options: [{
          id: 'cancel',
          label: '停止本轮查询',
          description: '等待补充可验证的查询范围或口径。',
          recommended: true,
        }],
      };
      answerEvidence = { ...answerEvidence, guarded: true };
    }
    const { finalMessage } = composeAnswerMessage({
      deterministicMessage,
      semanticFastPathError: queryExecutions.length === 0 ? semanticFastPathError : null,
      clarificationExhausted,
      harnessContent: harnessResult.content,
      carryForwardSummary: carryForward?.lastSummary,
      datasetName: lastBusinessDataset?.name,
      analysisText,
      validationWarnings,
      clarification: activeClarification,
    });
    const structuredClarification = !lastQueryResult
      && conversationContext.turnType !== TURN_TYPES.INSTRUCTION
      ? (activeClarification ?? buildClarificationFromModule({
        message: finalMessage,
        clarificationPolicy,
      }))
      : null;
    if (!lastQueryResult) {
      for (const code of ['SEMANTIC_RESOLVE', 'PLAN', 'VALIDATE', 'EXECUTE', 'RESULT_ANALYST', 'RESULT_VALIDATION', 'ANALYZE']) {
        if (workflow.isCompleted(code)) {
          continue;
        }
        workflow.skip(code, '本轮回答未执行数据查询');
      }
    } else if (carryForward && currentExecutions.length === 0) {
      for (const code of ['SEMANTIC_RESOLVE', 'SEMANTIC_DISCOVERY', 'SEMANTIC_CONFIRM', 'PLAN', 'VALIDATE', 'EXECUTE']) {
        if (!workflow.isCompleted(code)) {
          workflow.skip(code, '复用上一轮已锁定查询结果，未重复取数');
        }
      }
    }
    completeWorkflowStage('RESPOND', {
      summary: '生成业务回答与执行证据',
      detail: finalMessage,
      evidence: [{
        type: 'ANSWER',
        hasData: Boolean(lastQueryResult),
        rowCount: lastQueryResult?.rows?.length ?? 0,
      }],
    });
    const maxReplanDepth = Math.max(0, Number(this.config?.reflection?.maxReplan ?? 2));
    const reflection = await this._runReflection({
      question: resolvedQuestion,
      answer: finalMessage,
      result: lastQueryResult,
      contract: lastSemanticParse,
      harness: activeHarness,
      depth: replanDepth,
      judgeTimeoutMs: this.config?.reflection?.judgeTimeoutMs,
    });
    // Only a genuine strategy failure (with replan budget left) suppresses
    // persistence and hands control back to the replan loop. A passing
    // reflection — or one that has exhausted the budget — persists normally.
    const shouldReplan = Boolean(reflection.needsReplan) && replanDepth < maxReplanDepth;
    startWorkflowStage('REFLECT', '执行后反思');
    if (shouldReplan) {
      failWorkflowStage('REFLECT', new Error(reflection.hint || '需要换策略重规划'));
    } else {
      completeWorkflowStage('REFLECT', {
        summary: reflection.passed ? '反思通过' : '反思存在偏差但已达重规划上限',
        detail: reflection.checks.map((check) => `${check.name}:${check.pass ? 'pass' : 'fail'}`).join('；'),
        evidence: [{
          type: 'REFLECTION',
          judgeUsed: reflection.judgeUsed,
          needsReplan: reflection.needsReplan,
        }],
      });
    }
    const workflowWarnings = [];
    if (!reflection.passed) {
      workflowWarnings.push({
        code: 'REFLECTION_WARNING',
        message: reflection.checks
          .filter((check) => !check.pass)
          .map((check) => `${check.name}:${check.detail || '未通过'}`)
          .join('；'),
      });
    }
    if (groundingGuardApplied) {
      workflowWarnings.push({
        code: 'UNGROUNDED_ANSWER_BLOCKED',
        message: '未发现可验证的查询证据，已阻止生成推测性数据答案。',
      });
    }
    const workflowSnapshot = workflow.finish(finalMessage, { warnings: workflowWarnings });
    const taskState = completeTaskState({
      contextTask: conversationContext.taskState,
      answer: {
        semanticParse: lastSemanticParse,
        indicator: lastIndicator,
        analysisMode,
        resolvedQuestion,
        queryFingerprint: lastLockedExecution?.queryFingerprint ?? null,
        dataHash: lastLockedExecution?.dataHash ?? null,
      },
      artifactId: lastLockedExecution?.queryArtifactId
        ?? generatedCodeArtifacts[0]?.artifactId
        ?? null,
    });
    const contextDecision = publicContextDecision(conversationContext);

    const answer = {
      question: normalizedQuestion,
      resolvedQuestion,
      contextMode: conversationContext.mode,
      contextReason: conversationContext.reason,
      inheritQueryContext: conversationContext.inheritQueryContext,
      historyMessageCount: conversationContext.historyMessageCount,
      turnType: conversationContext.turnType,
      taskId: conversationContext.taskId,
      turnId: conversationContext.turnId,
      rootTaskId: conversationContext.rootTaskId,
      taskState,
      conversationDirective,
      sessionDirectives,
      contextDecision,
      analysisMode,
      clarificationPolicy,
      clarification: structuredClarification,
      answerEvidence,
      reflection,
      gateSummary: lastSemanticParse?.gateSummary ?? null,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
      },
      theme: {
        id: theme.id,
        name: theme.name,
      },
      message: finalMessage,
      indicator: lastIndicator ? {
        id: String(lastIndicator.id),
        name: lastIndicator.name,
        businessCaliber: lastIndicator.businessCaliber,
      } : null,
      dataset: lastBusinessDataset ? {
        id: lastBusinessDataset.id,
        code: lastBusinessDataset.code,
        name: lastBusinessDataset.name,
        schemaName: lastBusinessDataset.schemaName,
        tableName: lastBusinessDataset.primaryTable,
      } : null,
      data: lastQueryResult ?? { columns: [], rows: [] },
      chart: lastChart,
      semanticParse: lastSemanticParse,
      provenance: lastSemanticParse?.mappingProvenance
        ?? defaultMappingProvenance({
          indicator: lastIndicator,
          dataset: lastBusinessDataset,
        }),
      deterministic: queryExecutions.length > 0,
      queryFingerprint: lastLockedExecution?.queryFingerprint ?? null,
      dataHash: lastLockedExecution?.dataHash ?? null,
      executionResults: queryExecutions.map((execution) => ({
        kind: execution.kind,
        artifactId: execution.queryArtifactId,
        queryFingerprint: execution.queryFingerprint,
        dataHash: execution.dataHash,
        rowCount: execution.toolResult?.rowCount ?? 0,
        summary: execution.finalMessage,
      })),
      modelNarrative: queryExecutions.length > 0 ? (harnessResult.content || '') : null,
      skillAudit: skillAudit ? {
        phase: skillAudit.phase,
        status: skillAudit.status,
        skillCount: skillAudit.skillCount,
        checks: skillAudit.checks,
        skills: skillAudit.guidance.map((item) => ({
          code: item.code,
          name: item.name,
        })),
      } : null,
      resultValidation: resultValidation ? {
        phase: resultValidation.phase,
        status: resultValidation.status,
        skillCount: resultValidation.skillCount,
        checks: resultValidation.checks,
        skills: resultValidation.guidance.map((item) => ({
          code: item.code,
          name: item.name,
        })),
      } : null,
      workflow: workflowSnapshot,
      runtime: {
        mode: activeHarness.mode ?? 'unknown',
        model: activeHarness.model ?? null,
        sourceMode: localIndicatorMode
          ? this.indicatorService.mode ?? 'unknown'
          : 'direct-llm',
        sourceConfigured: true,
        executionAdapter: lastBusinessDataset
          ? datasetExecution(lastBusinessDataset).adapter
          : !localIndicatorMode
            ? 'direct-llm'
            : this.indicatorService.mode === 'local'
            ? 'local-indicator-catalog'
            : 'unconfigured-indicator',
        usage: harnessResult.usage ?? null,
        toolCalls: processSteps.filter((step) => step.type === 'tool').length,
        reuseCount: processSteps.filter((step) => step.type === 'reuse').length,
        durationMs: Date.now() - answerStartedAt,
        capabilities: activeHarness.capabilities ?? {},
      },
      trace: toolTrace,
      processSteps,
      skills: skills.map((skill) => ({
        code: skill.code,
        name: skill.name,
        kind: skill.kind,
        toolName: skill.toolName,
        source: skill.source,
        phaseTags: skill.phaseTags,
      })),
      permissions: {
        rowPolicyCount: scope.rowPolicies.length,
        columnPolicyCount: scope.columnPolicies.length,
        allowedIndicatorCount: scope.allowedIndicatorIds.length,
      },
      sessionId: session.id,
    };
    if (shouldReplan) {
      // 反思判定需换策略：本尝试不落库、不追加助手消息、不绑定产物，
      // 仅返回 answer（含 reflection/sessionId）供上层反思回路重跑。
      answer.traceId = runTraceId;
      return answer;
    }
    const assistantMessage = await this.memory.appendAssistantMessageAsync(
      session.id,
      user.id,
      answer.message,
      answer,
    );
    if (workspace && String(answer.message ?? '').trim()) {
      const markdown = String(answer.message);
      const analysisTitle = String(answer.resolvedQuestion ?? answer.question ?? '问数结果')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 72) || '问数结果';
      const analysisArtifact = this.workspace.createFileArtifactAsync
        ? await this.workspace.createFileArtifactAsync({
          workspaceId: workspace.id,
          userId: user.id,
          sessionId: session.id,
          messageId: assistantMessage.id,
          title: `分析结果 - ${analysisTitle}.md`,
          content: markdown,
          format: 'md',
          mimeType: 'text/markdown; charset=utf-8',
          purpose: '问数分析结果',
          size: Buffer.byteLength(markdown, 'utf8'),
          source: { type: 'ANALYSIS_MARKDOWN', messageId: assistantMessage.id },
        })
        : this.workspace.createFileArtifact({
          workspaceId: workspace.id,
          userId: user.id,
          sessionId: session.id,
          messageId: assistantMessage.id,
          title: `分析结果 - ${analysisTitle}.md`,
          content: markdown,
          format: 'md',
          mimeType: 'text/markdown; charset=utf-8',
          purpose: '问数分析结果',
          size: Buffer.byteLength(markdown, 'utf8'),
          source: { type: 'ANALYSIS_MARKDOWN', messageId: assistantMessage.id },
        });
      if (analysisArtifact?.id) {
        generatedWorkspaceArtifactIds.push(analysisArtifact.id);
      }
    }
    const queryArtifact = lastLockedExecution?.queryArtifactId
      ? (this.workspace?.getArtifactAsync ? await this.workspace.getArtifactAsync({
        artifactId: lastLockedExecution.queryArtifactId,
        userId: user.id,
      }) : this.workspace?.getArtifact({ artifactId: lastLockedExecution.queryArtifactId, userId: user.id }))
      : null;
    const fallbackResultArtifact = !queryArtifact && workspace && answer.data?.columns?.length
      ? (this.workspace.createResultArtifactAsync ? await this.workspace.createResultArtifactAsync({
        workspaceId: workspace.id,
        userId: user.id,
        sessionId: session.id,
        messageId: assistantMessage.id,
        conversationId: null,
        answer,
        artifactType: 'QUERY_RESULT',
        source: {
          type: lastIndicator
            ? 'INDICATOR'
            : lastBusinessDataset
              ? 'BUSINESS_DATASET'
              : 'UNKNOWN',
          id: lastIndicator?.id ?? lastBusinessDataset?.id ?? null,
          name: lastIndicator?.name ?? lastBusinessDataset?.name ?? null,
        },
      }) : this.workspace.createResultArtifact({
        workspaceId: workspace.id, userId: user.id, sessionId: session.id,
        messageId: assistantMessage.id, conversationId: null, answer,
        artifactType: 'QUERY_RESULT',
        source: { type: lastIndicator ? 'INDICATOR' : lastBusinessDataset ? 'BUSINESS_DATASET' : 'UNKNOWN', id: lastIndicator?.id ?? lastBusinessDataset?.id ?? null, name: lastIndicator?.name ?? lastBusinessDataset?.name ?? null },
      }))
      : null;
    if (fallbackResultArtifact?.id) {
      generatedWorkspaceArtifactIds.push(fallbackResultArtifact.id);
    }
    const primaryOutputArtifact = !queryArtifact && !fallbackResultArtifact
      && generatedCodeArtifacts.length > 0
      ? (this.workspace?.getArtifactAsync ? await this.workspace.getArtifactAsync({
        artifactId: generatedCodeArtifacts[0].artifactId,
        userId: user.id,
      }) : this.workspace?.getArtifact({ artifactId: generatedCodeArtifacts[0].artifactId, userId: user.id }))
      : null;
    const linkedArtifact = queryArtifact ?? fallbackResultArtifact ?? primaryOutputArtifact;
    if (workspace && generatedWorkspaceArtifactIds.length > 0) {
      await (this.workspace.bindArtifactsToMessageAsync ? this.workspace.bindArtifactsToMessageAsync({
        artifactIds: generatedWorkspaceArtifactIds,
        userId: user.id,
        messageId: assistantMessage.id,
      }) : this.workspace.bindArtifactsToMessage({ artifactIds: generatedWorkspaceArtifactIds, userId: user.id, messageId: assistantMessage.id }));
    }
    const savedAnswer = {
      ...answer,
      sessionId: session.id,
      messageId: assistantMessage.id,
      workspaceId: workspace?.id ?? null,
      artifactId: linkedArtifact?.id ?? null,
      artifactTitle: linkedArtifact?.title ?? null,
      artifactType: linkedArtifact?.artifactType ?? null,
    };
    const conversationInput = {
      userId: user.id,
      themeId: theme.id,
      question: normalizedQuestion,
      answer: savedAnswer,
    };
    const savedConversation = await callPlatformDatabase(this.database, 'saveConversationAsync', 'saveConversation', conversationInput);
    const conversationId = typeof savedConversation === 'object'
      ? Number(savedConversation?.id)
      : Number(savedConversation);
    await this.database.addAuditLogAsync({
      userId: user.id,
      themeId: theme.id,
      action: 'AGENT_QUERY',
      detail: {
        conversationId,
        sessionId: session.id,
        messageId: assistantMessage.id,
        planId: lastSemanticParse?.planId ?? null,
        question: normalizedQuestion,
        resolvedQuestion,
        contextMode: conversationContext.mode,
        contextReason: conversationContext.reason,
        inheritQueryContext: conversationContext.inheritQueryContext,
        artifactId: linkedArtifact?.id ?? null,
        workspaceId: workspace?.id ?? null,
        indicatorId: savedAnswer.indicator?.id ?? null,
        datasetId: savedAnswer.dataset?.id ?? null,
        rowCount: savedAnswer.data.rows.length,
        queryFingerprint: savedAnswer.queryFingerprint,
        dataHash: savedAnswer.dataHash,
        provenanceMode: savedAnswer.provenance?.mode ?? null,
        runtime: savedAnswer.runtime.mode,
      },
    });
    savedAnswer.conversationId = conversationId;
    emit({
      type: 'result',
      messageId: assistantMessage.id,
      sessionId: session.id,
      conversationId,
      workspaceId: savedAnswer.workspaceId,
      artifactId: savedAnswer.artifactId,
      artifactTitle: savedAnswer.artifactTitle,
      artifactType: savedAnswer.artifactType,
      workflow: workflowSnapshot,
      processSteps,
      runtime: savedAnswer.runtime,
      provenance: savedAnswer.provenance,
      rowCount: savedAnswer.data.rows.length,
      message: savedAnswer.message,
    });
    emit({
      type: 'done',
      messageId: assistantMessage.id,
      sessionId: session.id,
      conversationId,
      durationMs: savedAnswer.runtime.durationMs,
    });
    savedAnswer.traceId = runTraceId;
    savedAnswer.indicatorSource = indicatorSourceState;
    return savedAnswer;
  }

  async _runReflection({ question, answer, result, contract, harness, depth, judgeTimeoutMs }) {
    if (this.config?.reflection?.enabled === false) {
      return {
        version: REFLECTION_VERSION,
        depth,
        passed: true,
        needsReplan: false,
        hint: null,
        judgeUsed: false,
        degraded: true,
        skipped: true,
        checks: [],
      };
    }
    const judge = createHarnessJudge(harness);
    return reflectOnAnswer({
      question,
      answer,
      result,
      contract,
      judge,
      depth,
      judgeTimeoutMs,
    });
  }

  // Public entry: runs the pipeline, then reflects; on a strategy failure it
  // replans with a changed strategy (full re-run from INTENT), bounded by
  // reflection.maxReplan. The Judge only drives the replan decision — it never
  // fabricates numbers; results stay on the deterministic query path.
  async answerWithTrace(options = {}, runTraceId = currentTraceId()) {
    const reflectionEnabled = this.config?.reflection?.enabled !== false;
    const maxReplan = reflectionEnabled
      ? Math.max(0, Number(this.config?.reflection?.maxReplan ?? 2))
      : 0;
    let opts = options;
    let hint = '';
    let last = null;
    let carryForward = null;
    const recovery = createAgentRecoveryCoordinator({
      maxAttempts: this.config?.recovery?.maxAttempts ?? 5,
      signal: options.signal,
      onEvent: options.onEvent,
      onTerminalFailure: async (error, context) => {
        const sessionId = context.sessionId ?? error.recoveryContext?.sessionId;
        if (sessionId && !error.persisted) {
          await this.memory.appendAssistantMessageAsync(
            sessionId,
            context.userId ?? options.userId,
            `本次查询失败：${error.message}`,
            { error: error.message, recoveryAttempts: context.attempts, recoveryContext: error.recoveryContext ?? null },
          ).catch(() => {});
        }
        try { options.onEvent?.({ type: 'error', message: error.message, recoveryAttempts: context.attempts }); } catch {}
      },
    });
    let depth = 0;
    while (depth <= maxReplan) {
      last = await recovery.run((recoveryHint, recoveryAttempts, recoveryContext) => this._runOnce(
        {
          ...opts,
          sessionId: recoveryContext.sessionId ?? opts.sessionId,
          replanDepth: depth,
          replanHint: recoveryHint || hint,
          carryForward,
          suppressUserMessage: depth > 0 || recoveryAttempts > 0,
          recoveryMode: recoveryAttempts < (this.config?.recovery?.maxAttempts ?? 5),
        },
        runTraceId,
      ), { sessionId: opts.sessionId, userId: opts.userId });
      opts = { ...opts, sessionId: last?.sessionId ?? opts.sessionId };
      const reflection = last?.reflection;
      if (!reflection || !reflection.needsReplan || depth === maxReplan) {
        return last;
      }
      carryForward = buildReplanCarryForward(last) ?? carryForward;
      hint = reflection.hint || '请换一种查询或分析策略重试';
      // Reuse the same session: replan re-runs the full pipeline from INTENT
      // without creating a new session or appending the user question again.
      opts = { ...opts, sessionId: last.sessionId ?? opts.sessionId };
      depth += 1;
    }
    return last;
  }
}

export { TOOL_DEFINITIONS };
