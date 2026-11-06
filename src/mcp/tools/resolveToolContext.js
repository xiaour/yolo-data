import { fail, MCP_ERROR } from './shared.js';

// Preserve the context provider's receiver and translate only resolution errors.
// Tool-specific scope checks and their messages remain with the handlers.
export async function resolveToolContext(agent, userId, themeId) {
  try {
    return agent.resolveContextAsync
      ? await agent.resolveContextAsync(userId, themeId)
      : agent.resolveContext(userId, themeId);
  } catch (error) {
    throw fail(MCP_ERROR.FORBIDDEN, error?.message ?? '解析上下文失败');
  }
}
