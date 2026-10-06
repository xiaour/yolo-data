// 提问附件：把用户在输入框上方选择的本地文件绑定到当轮用户提问。
// 只做归属校验、提问绑定和展示投影，不包含任何业务口径判断。

// 单轮提问最多携带的附件数，防止一次请求把整个会话的产物都挂上来。
const MAX_ATTACHMENTS_PER_QUESTION = 20;

// 只接受当前用户、当前会话下、状态正常的 FILE 产物；其余一律忽略而不是报错。
function resolveQuestionAttachments({ workspace, userId, sessionId, artifactIds }) {
  const ids = [...new Set((artifactIds ?? [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean))]
    .slice(0, MAX_ATTACHMENTS_PER_QUESTION);
  if (ids.length === 0 || !workspace) {
    return [];
  }
  const session = Number(sessionId);
  const attachments = [];
  for (const artifactId of ids) {
    let artifact = null;
    try {
      artifact = workspace.getArtifact({ artifactId, userId });
    } catch {
      continue;
    }
    if (!artifact || artifact.artifactType !== 'FILE' || Number(artifact.sessionId) !== session) {
      continue;
    }
    const source = artifact.metadata?.source ?? {};
    attachments.push({
      artifactId: artifact.id,
      artifactType: artifact.artifactType,
      title: artifact.title,
      name: source.name ?? artifact.title,
      extension: source.extension ?? null,
      size: source.size ?? null,
      sha256: source.sha256 ?? null,
    });
  }
  return attachments;
}

// 落库用户提问并绑定附件：一次调用同时完成 appendUserMessage 和 message 绑定，
// 使「这一问引用了哪些文件」可被追溯，并在提问气泡中展示。
export function appendUserQuestionWithAttachments({
  memory,
  workspace,
  session,
  user,
  question,
  artifactIds = [],
}) {
  const attachments = resolveQuestionAttachments({
    workspace,
    userId: user.id,
    sessionId: session.id,
    artifactIds,
  });
  const message = memory.appendUserMessage(session.id, user.id, question, { attachments });
  if (attachments.length > 0 && typeof workspace?.bindArtifactsToMessage === 'function') {
    workspace.bindArtifactsToMessage({
      artifactIds: attachments.map((item) => item.artifactId),
      userId: user.id,
      messageId: message.id,
    });
  }
  return { message, attachments };
}

export { resolveQuestionAttachments, MAX_ATTACHMENTS_PER_QUESTION };
