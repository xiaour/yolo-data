// 长期记忆的按需检索工具：常驻上下文只放摘要，正文通过这个工具按需读取。
// 与 Codex 的 list / read / search 三件套等价，这里收敛成一个工具：
// 不给 query 时返回记忆索引（作用域、版本、条目结构），给 query 时返回命中片段。
import { memoryScopeKey } from './userMemory.js';

export const USER_MEMORY_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_user_memory',
      description: 'Read the current user\'s long-term memory handbook on demand. '
        + 'Call without a query to list memory scopes and their section outline; '
        + 'call with a query to search the memory body for matching lines.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords to look for in the memory body. Omit to read the index instead.',
          },
          scope: {
            type: 'string',
            enum: ['all', 'global', 'theme'],
            description: 'Which memory scope to read: theme-scoped, cross-theme global, or all.',
          },
          limit: { type: 'integer', description: 'Maximum number of matches (default 8).' },
        },
        additionalProperties: false,
      },
    },
  },
];

export const USER_MEMORY_TOOL_NAMES = new Set(
  USER_MEMORY_TOOLS.map((tool) => tool.function.name),
);

function headingsOf(content) {
  return String(content ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^#{2,3}\s+\S/.test(line))
    .slice(0, 20);
}

// 只返回记忆内容本身，不包含任何平台业务口径。
export function createUserMemoryToolHandler({ store, user, themeId = null }) {
  return async function handleUserMemoryTool(name, args = {}) {
    if (!USER_MEMORY_TOOL_NAMES.has(name)) {
      throw new Error(`unknown user memory tool: ${name}`);
    }
    const scope = String(args.scope ?? 'all');
    const query = String(args.query ?? '').trim();
    const limit = Number(args.limit) || 8;
    const documents = store.listDocuments({ userId: user.id, status: 1 });
    const scoped = documents.filter((document) => {
      if (scope === 'global') {
        return document.scopeKey === memoryScopeKey(null);
      }
      if (scope === 'theme') {
        return document.scopeKey === memoryScopeKey(themeId);
      }
      return themeId
        ? document.scopeKey === memoryScopeKey(themeId) || document.scopeKey === 'global'
        : documents.length > 0;
    });
    const usable = scoped.filter((document) => document.content.trim() || document.summary.trim());
    if (usable.length === 0) {
      return {
        available: false,
        message: '当前用户还没有沉淀长期记忆，按本轮问题和主题提示词正常执行。',
      };
    }
    if (!query) {
      return {
        available: true,
        scopes: usable.map((document) => ({
          scope: document.scopeLabel,
          scopeKey: document.scopeKey,
          version: document.version,
          updatedAt: document.updatedAt,
          summary: document.summary,
          sections: headingsOf(document.content),
        })),
        hint: '用 query 检索正文获取具体口径；摘要仅供参考，细节以检索结果为准。',
      };
    }
    const results = store.search(user.id, themeId, query, limit);
    return {
      available: true,
      scope,
      query,
      version: usable.map((document) => ({ scope: document.scopeLabel, version: document.version })),
      results: results.map((item) => ({
        scope: item.scopeLabel,
        location: item.location,
        version: item.version,
        excerpt: item.excerpt,
      })),
      hint: results.length === 0
        ? '记忆中没有相关条目，按本轮问题和主题提示词正常执行，不要凭记忆推测。'
        : '记忆内容与主题提示词、平台规则冲突时以后者为准。',
    };
  };
}
