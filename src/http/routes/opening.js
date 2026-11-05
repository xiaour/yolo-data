import { buildOpeningSuggestions } from '../../openingSuggestions.js';
import { collectThemeSemantics } from '../openingSemantics.js';

// 「继续上次」：取该主题下最近一次会话的最后几个问题，供用户一键重问。
async function buildResume({ agent, userId, themeId }) {
  const sessions = (await agent.listSessionsAsync(userId))
    .filter((session) => Number(session.themeId) === Number(themeId));
  if (sessions.length === 0) {
    return null;
  }
  const latest = sessions[0];
  const questions = (await agent.listMessagesAsync(latest.id, userId))
    .filter((message) => message.role === 'user')
    .map((message) => String(message.content ?? '').trim())
    .filter(Boolean)
    .slice(-3);
  if (questions.length === 0) {
    return null;
  }
  return {
    sessionId: Number(latest.id),
    title: String(latest.title ?? '').trim() || '未命名会话',
    updatedAt: latest.updatedAt ?? null,
    questions,
  };
}

function countUnique(values) {
  return new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean)).size;
}

export function registerOpeningRoutes(table) {
  table.add({
    id: 'themes.suggestions',
    method: 'GET',
    path: '/api/themes/:id(\\d+)/suggestions',
    tags: ['themes'],
    summary: '当前主题的开场示例卡与继续上次入口',
    middleware: ['auth'],
    handler: async (ctx) => {
      const {
        request, response, application, database, agent, params,
        getRequestUser, sendJson,
      } = ctx;
      const user = await getRequestUser(request, database);
      const themeId = Number(params[0]);
      const themes = await agent.getThemesForUserAsync(user.id);
      const theme = themes
        .find((item) => Number(item.id) === themeId);
      if (!theme) {
        throw Object.assign(new Error('theme not found'), { statusCode: 404 });
      }
      // Configured examples are authoritative; semantic metadata cannot affect
      // their cards, so avoid loading every dataset's fields on this hot path.
      const hasExamples = (theme.examples ?? []).some((value) => String(value ?? '').trim());
      const [{ metricNames, dimensionNames, datasetName }, resume] = await Promise.all([
        hasExamples
          ? Promise.resolve({ metricNames: [], dimensionNames: [], datasetName: '' })
          : collectThemeSemantics({ theme, user, application, database }),
        buildResume({ agent, userId: user.id, themeId }),
      ]);
      const { source, cards } = buildOpeningSuggestions({
        examples: theme.examples ?? [],
        metricNames,
        dimensionNames,
      });
      sendJson(response, 200, {
        themeId,
        source,
        cards,
        stats: {
          metricCount: countUnique(metricNames),
          dimensionCount: countUnique(dimensionNames),
          datasetName: datasetName || null,
        },
        resume,
      });
    },
  });
}
