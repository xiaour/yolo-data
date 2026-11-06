import { resolveToolContext } from './resolveToolContext.js';
// 工具 get_policy：查询用户在某主题下的访问策略（只读）。
import { z } from 'zod';
import { wrapToolHandler, buildMeta, assertTenantScope } from './shared.js';
import { fail } from './shared.js';

export function registerGetPolicy(server, ctx) {
  server.registerTool('get_policy', {
    title: '查询访问策略',
    description: '返回指定用户在某主题下的访问策略：可问指标范围、可问数据集、维度限制、'
      + '行/列级策略与管理权限。只读。',
    inputSchema: {
      userId: z.number().int().describe('用户 ID'),
      themeId: z.number().int().describe('主题 ID'),
    },
  }, wrapToolHandler(async (args) => {
    const { agent, database, requestContext, auditToolCall } = ctx;
    assertTenantScope(ctx, args.themeId);
    return auditToolCall(database, buildMeta('get_policy', requestContext, args), async () => {
      const resolved = await resolveToolContext(agent, args.userId, args.themeId);
      const scope = resolved?.scope;
      if (!scope || scope.allowed === false) {
        throw fail(-32002, scope?.reason ?? '当前用户无该主题的查询权限');
      }
      return { content: [{ type: 'text', text: JSON.stringify(scope, null, 2) }] };
    });
  }));
}
