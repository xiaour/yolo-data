export function registerChatRoutes(table) {
  table.add({
    id: 'chat.queryStream',
    method: 'POST',
    path: '/api/chat/query/stream',
    tags: ['chat'],
    summary: '流式问数（NDJSON，协议保持不变）',
    middleware: ['auth', 'rateLimit:chat'],
    handler: async (ctx) => {
      const { request, response, database, agent, getRequestUser, readJson, startNdjsonStream } = ctx;
      const user = getRequestUser(request, database);
      const body = await readJson(request);
      const writeEvent = startNdjsonStream(response);
      const abortController = new AbortController();
      const abortOnClose = () => {
        if (!response.writableEnded) {
          abortController.abort();
        }
      };
      request.on('aborted', abortOnClose);
      response.on('close', abortOnClose);
      try {
        const answer = await agent.answer({
          userId: user.id,
          themeId: body.themeId ? Number(body.themeId) : undefined,
          sessionId: body.sessionId ? Number(body.sessionId) : undefined,
          question: body.question,
          preferredChart: body.preferredChart,
          clarificationOptionId: body.clarificationOptionId,
          modelId: body.modelId ? Number(body.modelId) : null,
          attachmentArtifactIds: body.attachmentArtifactIds,
          signal: abortController.signal,
          onEvent: writeEvent,
        });
        writeEvent({ type: 'final', answer });
        writeEvent({
          type: 'stream_done',
          messageId: answer.messageId,
          sessionId: answer.sessionId,
        });
      } catch (error) {
        writeEvent({
          type: 'stream_error',
          message: error.message ?? 'query failed',
        });
      } finally {
        request.off('aborted', abortOnClose);
        response.off('close', abortOnClose);
        if (!response.writableEnded) {
          response.end();
        }
      }
    },
  });

  table.add({
    id: 'chat.query',
    method: 'POST',
    path: '/api/chat/query',
    tags: ['chat'],
    summary: '同步问数',
    middleware: ['auth', 'rateLimit:chat', 'timeout:180s'],
    handler: async (ctx) => {
      const { request, response, database, agent, getRequestUser, readJson, sendJson } = ctx;
      const user = getRequestUser(request, database);
      const body = await readJson(request);
      const result = await agent.answer({
        userId: user.id,
        themeId: body.themeId ? Number(body.themeId) : undefined,
        sessionId: body.sessionId ? Number(body.sessionId) : undefined,
        question: body.question,
        preferredChart: body.preferredChart === 'auto' ? 'auto' : body.preferredChart,
        clarificationOptionId: body.clarificationOptionId,
        modelId: body.modelId ? Number(body.modelId) : null,
        attachmentArtifactIds: body.attachmentArtifactIds,
      });
      sendJson(response, 200, result);
    },
  });

  table.add({
    id: 'workspaces.list',
    method: 'GET',
    path: '/api/workspaces',
    tags: ['chat'],
    summary: '列出当前用户工作区',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, workspace, getRequestUser, sendJson } = ctx;
      const user = getRequestUser(request, database);
      const sessionId = request.url.includes('?')
        ? Number(new URL(request.url, 'http://localhost').searchParams.get('sessionId'))
        : null;
      sendJson(response, 200, workspace.listForUser({
        userId: user.id,
        sessionId: Number.isFinite(sessionId) && sessionId > 0 ? sessionId : null,
      }));
    },
  });

  table.add({
    id: 'workspaces.artifacts',
    method: 'GET',
    path: '/api/workspaces/:id(\\d+)/artifacts',
    tags: ['chat'],
    summary: '列出工作区产物',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, workspace, params, getRequestUser, sendJson } = ctx;
      const workspaceArtifactsRoute = params;
      const user = getRequestUser(request, database);
      sendJson(response, 200, workspace.listArtifacts({
        workspaceId: Number(workspaceArtifactsRoute[0]),
        userId: user.id,
      }));
    },
  });

  table.add({
    id: 'artifacts.read',
    method: 'GET',
    path: '/api/artifacts/:artifactId',
    tags: ['chat'],
    summary: '读取产物详情',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, workspace, params, getRequestUser, sendJson } = ctx;
      const artifactRoute = params;
      const user = getRequestUser(request, database);
      sendJson(response, 200, workspace.getArtifact({
        artifactId: decodeURIComponent(artifactRoute[0]),
        userId: user.id,
      }));
    },
  });

  table.add({
    id: 'artifacts.transform',
    method: 'POST',
    path: '/api/artifacts/:artifactId/transform',
    tags: ['chat'],
    summary: '对产物执行转换',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, workspace, params, getRequestUser, readJson, sendJson } = ctx;
      const artifactTransformRoute = params;
      const user = getRequestUser(request, database);
      const body = await readJson(request);
      const result = workspace.transformArtifact({
        artifactId: decodeURIComponent(artifactTransformRoute[0]),
        userId: user.id,
        operation: body.operation,
        params: body.params ?? {},
      });
      database.addAuditLog({
        userId: user.id,
        action: 'WORKSPACE_ARTIFACT_TRANSFORM',
        detail: {
          artifactId: result.id,
          operation: body.operation,
          version: result.currentVersion,
        },
      });
      sendJson(response, 200, result);
    },
  });

  table.add({
    id: 'artifacts.download',
    method: 'GET',
    path: '/api/artifacts/:artifactId/download',
    tags: ['chat'],
    summary: '下载产物',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, workspace, params, getRequestUser } = ctx;
      const artifactDownloadRoute = params;
      const user = getRequestUser(request, database);
      const url = new URL(request.url, 'http://localhost');
      const exported = workspace.exportArtifact({
        artifactId: decodeURIComponent(artifactDownloadRoute[0]),
        userId: user.id,
        format: url.searchParams.get('format') ?? 'csv',
      });
      response.writeHead(200, {
        'Content-Type': exported.contentType,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(exported.filename)}`,
        'Cache-Control': 'no-store',
      });
      response.end(exported.content);
    },
  });

  table.add({
    id: 'chat.sessions.list',
    method: 'GET',
    path: '/api/chat/sessions',
    tags: ['chat'],
    summary: '列出会话',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, agent, getRequestUser, sendJson } = ctx;
      const user = getRequestUser(request, database);
      sendJson(response, 200, agent.listSessions(user.id));
    },
  });

  table.add({
    id: 'chat.sessions.create',
    method: 'POST',
    path: '/api/chat/sessions',
    tags: ['chat'],
    summary: '创建会话',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, agent, getRequestUser, readJson, sendJson } = ctx;
      const user = getRequestUser(request, database);
      const body = await readJson(request);
      const session = agent.createSession({
        userId: user.id,
        themeId: Number(body.themeId),
        title: body.title,
        modelId: body.modelId ? Number(body.modelId) : null,
      });
      database.addAuditLog({
        userId: user.id,
        themeId: session.themeId,
        action: 'CHAT_SESSION_CREATE',
        detail: {
          sessionId: session.id,
          themeId: session.themeId,
          modelId: session.modelId ?? null,
        },
      });
      sendJson(response, 200, session);
    },
  });

  table.add({
    id: 'chat.sessions.messages',
    method: 'GET',
    path: '/api/chat/sessions/:id(\\d+)/messages',
    tags: ['chat'],
    summary: '列出会话消息',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, agent, params, getRequestUser, sendJson } = ctx;
      const sessionMessagesRoute = params;
      const user = getRequestUser(request, database);
      const messages = agent.listMessages(Number(sessionMessagesRoute[0]), user.id);
      sendJson(response, 200, messages);
    },
  });

  table.add({
    id: 'chat.sessions.delete',
    method: 'DELETE',
    path: '/api/chat/sessions/:id(\\d+)',
    tags: ['chat'],
    summary: '删除会话',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, agent, params, getRequestUser, sendJson } = ctx;
      const sessionDeleteRoute = params;
      const user = getRequestUser(request, database);
      const deleted = agent.deleteSession(Number(sessionDeleteRoute[0]), user.id);
      database.addAuditLog({
        userId: user.id,
        action: 'CHAT_SESSION_DELETE',
        detail: { sessionId: Number(sessionDeleteRoute[0]), deleted },
      });
      sendJson(response, 200, { deleted });
    },
  });

  table.add({
    id: 'feedback.submit',
    method: 'POST',
    path: '/api/feedback',
    tags: ['feedback'],
    summary: '提交问数反馈',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, application, getRequestUser, readJson, sendJson } = ctx;
      const user = getRequestUser(request, database);
      const body = await readJson(request);
      const result = application.feedback.submit({
        userId: user.id,
        themeId: body.themeId ? Number(body.themeId) : null,
        sessionId: body.sessionId ? Number(body.sessionId) : null,
        messageId: body.messageId ? Number(body.messageId) : null,
        question: body.question,
        correct: Boolean(body.correct),
        comment: body.comment,
        corrected: body.corrected ?? {},
      });
      database.addAuditLog({
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
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      sendJson(response, 200, application.feedback.list({
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
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      sendJson(response, 200, application.growth.list({
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
        const user = getRequestUser(request, database);
        if (user.role !== 'ADMIN') {
          throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
        }
        const body = await readJson(request);
        const resolution = body.resolution ?? { note: body.note ?? '' };
        const gap = action === 'dismiss'
          ? application.growth.dismiss(id, resolution)
          : action === 'resolve'
            ? application.growth.resolve(id, resolution)
            : application.growth.reopen(id);
        database.addAuditLog({
          userId: user.id,
          action: 'KNOWLEDGE_GAP_UPDATE',
          detail: { gapId: id, action, resolution },
        });
        sendJson(response, 200, gap);
      },
    });
  }

  table.add({
    id: 'queryPlans.read',
    method: 'GET',
    path: '/api/query-plans/:id',
    tags: ['chat'],
    summary: '读取查询计划',
    middleware: ['auth'],
    handler: async (ctx) => {
      const { request, response, database, params, getRequestUser, sendJson } = ctx;
      const queryPlanRoute = params;
      const user = getRequestUser(request, database);
      const plan = database.getQueryPlan(
        queryPlanRoute[0],
        user.role === 'ADMIN' ? null : user.id,
      );
      if (!plan) {
        throw Object.assign(new Error('query plan not found'), { statusCode: 404 });
      }
      sendJson(response, 200, plan);
    },
  });

  table.add({
    id: 'llmLogs.list',
    method: 'GET',
    path: '/api/llm-logs',
    tags: ['system'],
    summary: '列出 LLM 调用日志（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, url, database, application, getRequestUser, sendJson, parseIntParam } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      sendJson(response, 200, {
        stats: application.llmAudit.stats(),
        items: application.llmAudit.list(parseIntParam(url.searchParams.get('limit'), 200)),
      });
    },
  });

  table.add({
    id: 'audit.list',
    method: 'GET',
    path: '/api/audit',
    tags: ['system'],
    summary: '列出审计日志（管理员）',
    middleware: ['auth', 'admin'],
    adminOnly: true,
    handler: async (ctx) => {
      const { request, response, url, database, getRequestUser, sendJson, parseIntParam } = ctx;
      const user = getRequestUser(request, database);
      if (user.role !== 'ADMIN') {
        throw Object.assign(new Error('admin permission required'), { statusCode: 403 });
      }
      sendJson(response, 200, database.listAuditLogs(
        parseIntParam(url.searchParams.get('limit'), 100),
      ));
    },
  });
}
