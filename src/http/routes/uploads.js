// 本地上传路由：把用户上传的本地文件写入当前会话工作区。
// 上传物是会话级产物，随会话上下文对 agent 可见，不需要按轮次显式携带。
export function registerUploadRoutes(table) {
  table.add({
    id: 'workspaces.uploadFile',
    method: 'POST',
    path: '/api/workspaces/files',
    tags: ['chat'],
    summary: '上传本地文件到会话工作区',
    middleware: ['auth', 'rateLimit:default'],
    handler: async (ctx) => {
      const {
        request, response, database, uploads, getRequestUser, readJson, sendJson,
      } = ctx;
      const user = getRequestUser(request, database);
      const maxBytes = Number(uploads?.limits?.maxBytes) || 8 * 1024 * 1024;
      // base64 体积约为原始字节的 4/3，这里按上限放宽本次读体限制。
      const body = await readJson(request, Math.ceil((maxBytes * 4) / 3) + 4096);
      const result = uploads.upload({
        userId: user.id,
        sessionId: Number(body.sessionId),
        name: body.name,
        contentBase64: body.contentBase64,
      });
      sendJson(response, 200, result);
    },
  });
}
