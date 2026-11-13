import { resolveToolContext } from './resolveToolContext.js';
// 工具 resolve_query：将语义层参数编译为确定性的查询契约，经平台门禁 review
// 后冻结落库，返回 contractId。后续 execute_query 凭 contractId 执行。
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  wrapToolHandler, buildMeta, assertTenantScope, MCP_ERROR, fail,
} from './shared.js';
import { buildQueryContract } from '../../queryContract.js';

const contractInputSchema = {
  userId: z.number().int().describe('用户 ID'),
  themeId: z.number().int().describe('主题 ID'),
  sourceType: z.enum(['INDICATOR', 'BUSINESS_DATASET']).describe('数据来源类型'),
  indicatorId: z.string().optional().describe('INDICATOR 类型时的指标 ID'),
  datasetId: z.string().optional().describe('BUSINESS_DATASET 类型时的数据集 ID'),
  metrics: z.array(z.string()).describe('指标业务名列表'),
  dimensions: z.array(z.string()).optional().describe('维度业务名列表'),
  filters: z.array(z.object({
    field: z.string(),
    operator: z.string(),
    value: z.any(),
    scope: z.string().optional(),
  })).optional().describe('过滤条件'),
  dateInfo: z.object({
    dateMode: z.string(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    dateField: z.string().optional(),
  }).optional().describe('时间范围'),
  timeGrain: z.string().optional().describe('时间粒度 DAY/WEEK/MONTH/QUARTER/YEAR'),
  limit: z.number().int().optional().describe('最大返回行数'),
  analysisMode: z.string().optional().describe('分析模式 METRIC_QUERY/TREND/ATTRIBUTION'),
};

export function registerResolveQuery(server, ctx) {
  server.registerTool('resolve_query', {
    title: '编译查询契约',
    description: '将语义层参数（指标/维度/过滤/时间）编译为确定性的查询契约，'
      + '经平台门禁 review 后冻结落库并返回 contractId。后续 execute_query 凭 contractId 执行，'
      + '保证「同一契约同一结果」。',
    inputSchema: contractInputSchema,
  }, wrapToolHandler(async (args) => {
    const { agent, database, requestContext, auditToolCall } = ctx;
    assertTenantScope(ctx, args.themeId);
    return auditToolCall(database, buildMeta('resolve_query', requestContext, args), async () => {
      if (args.sourceType === 'INDICATOR' && !args.indicatorId) {
        throw fail(MCP_ERROR.INTERNAL, 'INDICATOR 类型必须提供 indicatorId');
      }
      if (args.sourceType === 'BUSINESS_DATASET' && !args.datasetId) {
        throw fail(MCP_ERROR.INTERNAL, 'BUSINESS_DATASET 类型必须提供 datasetId');
      }
      const resolved = await resolveToolContext(agent, args.userId, args.themeId);
      const { theme, scope } = resolved;
      if (!scope || scope.allowed === false) {
        throw fail(-32002, scope?.reason ?? '无查询权限');
      }
      let indicator = null;
      let dataset = null;
      if (args.sourceType === 'INDICATOR') {
        indicator = args.indicatorId
          ? await agent.indicatorService.getIndicator(args.indicatorId).catch(() => null)
          : null;
      } else {
        dataset = database.getBusinessDatasetAsync
          ? await database.getBusinessDatasetAsync(args.datasetId)
          : database.getBusinessDataset(args.datasetId);
      }
      const contract = buildQueryContract({
        indicatorId: args.indicatorId,
        metrics: args.metrics,
        dimensions: args.dimensions ?? [],
        filters: args.filters ?? [],
        dateInfo: args.dateInfo,
        timeGrain: args.timeGrain,
        limit: args.limit ?? 200,
        analysisMode: args.analysisMode,
      });
      const review = agent.queryContractCompiler.review(contract, { indicator, dataset, theme, scope });
      if (!review || review.valid === false) {
        const issues = (review?.issues ?? []).map((item) => item?.message ?? String(item)).join('；');
        throw fail(MCP_ERROR.INTERNAL, `查询契约门禁未通过：${issues}`);
      }
      const contractId = `mcq_${randomBytes(16).toString('hex')}`;
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await database.saveMcpQueryContract({
        contractId,
        tenantId: requestContext.tenantId ?? 'default',
        userId: args.userId,
        themeId: args.themeId,
        sourceType: args.sourceType,
        indicatorId: args.indicatorId ?? null,
        datasetId: args.datasetId ?? null,
        contractJson: JSON.stringify(contract),
        status: 'FROZEN',
        expiresAt,
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            contractId,
            sourceType: args.sourceType,
            expiresAt,
            contract,
            review: { valid: true, warnings: review.warnings ?? [] },
          }, null, 2),
        }],
      };
    });
  }));
}
