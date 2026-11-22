// 问数反馈与知识盲区路由：结果纠错反馈的提交与管理员查阅，
// 以及知识盲区（knowledge gap）的列表与处置。

export function registerChatFeedbackRoutes(table) {
  table.add({
    id: 'feedback.submit',
    method: 'POST',
    path: '/api/feedback',
    tags: ['feedback'],
    summary: '提交问数反馈',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, application, getRequestUser, readJson, sendJson } = ctx;
      const user = await getRequestUser(request, database);
      const body = await readJson(request);
      const result = await application.feedback.submitAsync({
        userId: user.id,
        themeId: body.themeId ? Number(body.themeId) : null,
        sessionId: body.sessionId ? Number(body.sessionId) : null,
        messageId: body.messageId ? Number(body.messageId) : null,
        question: body.question,
        correct: Boolean(body.correct),
        comment: body.comment,
        corrected: body.corrected ?? {},
      });
      await database.addAuditLogAsync({
        userId: user.id,
        themeId: body.themeId ? Number(body.themeId) : null,
        action: 'QA_FEEDBACK',
        detail: {
          feedbackId: result.id,
          messageId: body.messageId,
          correct: result.correct,
        },
      });
      sendJson(response, 200, result);
    },
  });

  table.add({
    id: 'feedback.list',
    method: 'GET',
    path: '/api/feedback',
    tags: ['feedback'],
    summary: '列出反馈（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, url, database, application, getRequestUser, sendJson, parseIntParam } = ctx;
      const user = await getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      sendJson(response, 200, await application.feedback.listAsync({
        themeId: url.searchParams.get('themeId'),
        correct: url.searchParams.has('correct')
          ? url.searchParams.get('correct') === 'true'
          : null,
        limit: parseIntParam(url.searchParams.get('limit'), 200),
      }));
    },
  });

  table.add({
    id: 'knowledgeGaps.list',
    method: 'GET',
    path: '/api/knowledge-gaps',
    tags: ['feedback'],
    summary: '列出知识盲区（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, url, database, application, getRequestUser, sendJson, parseIntParam } = ctx;
      const user = await getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      sendJson(response, 200, await application.growth.listAsync({
        includeClosed: url.searchParams.get('includeClosed') === 'true',
        limit: parseIntParam(url.searchParams.get('limit'), 200),
      }));
    },
  });

  for (const action of ['dismiss', 'resolve', 'reopen']) {
    table.add({
      id: `knowledgeGaps.${action}`,
      method: 'POST',
      path: `/api/knowledge-gaps/:id(\\d+)/${action}`,
      tags: ['feedback'],
      summary: `知识盲区 ${action}（管理员）`,
      middleware: ['auth', 'admin'],
      adminOnly: true,
      handler: async (ctx) => {
        const { request, response, database, application, params, getRequestUser, readJson, sendJson } = ctx;
        const id = Number(params[0]);
        const user = await getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const body = await readJson(request);
        const resolution = body.resolution ?? { note: body.note ?? '' };
        const gap = await application.growth.updateAsync(id, action === 'dismiss'
          ? { dismissed: true, resolution }
          : action === 'resolve'
            ? { resolved: true, resolution }
            : { dismissed: false, resolved: false, resolution: {} });
        await database.addAuditLogAsync({
          userId: user.id,
          action: 'KNOWLEDGE_GAP_UPDATE',
          detail: { gapId: id, action, resolution },
        });
        sendJson(response, 200, gap);
      },
    });
  }
}
