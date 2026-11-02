// 提问附件：把用户在输入框上方选择的本地文件绑定到当轮用户提问。
// 只做归属校验、提问绑定和展示投影，不包含任何业务口径判断。

// 单轮提问最多携带的附件数，防止一次请求把整个会话的产物都挂上来。
export const MAX_ATTACHMENTS_PER_QUESTION = 20;

// 只接受当前用户、当前会话下、状态正常的 FILE 产物；其余一律忽略而不是报错。
function attachmentIds(artifactIds) {
  return [...new Set((artifactIds ?? []).map((item) => String(item ?? '').trim()).filter(Boolean))]
    .slice(0, MAX_ATTACHMENTS_PER_QUESTION);
}

function projectAttachment(artifact, sessionId) {
  if (!artifact || artifact.artifactType !== 'FILE' || Number(artifact.sessionId) !== Number(sessionId)) return null;
  const source = artifact.metadata?.source ?? {};
  return { artifactId: artifact.id, artifactType: artifact.artifactType, title: artifact.title, name: source.name ?? artifact.title, extension: source.extension ?? null, size: source.size ?? null, sha256: source.sha256 ?? null };
}

export function resolveQuestionAttachments({ workspace, userId, sessionId, artifactIds }) {
  const ids = attachmentIds(artifactIds);
  if (ids.length === 0 || !workspace) return [];
  return ids.flatMap((artifactId) => {
    try { return projectAttachment(workspace.getArtifact({ artifactId, userId }), sessionId) ?? []; }
    catch { return []; }
  });
}

export async function resolveQuestionAttachmentsAsync({ workspace, userId, sessionId, artifactIds }) {
  const ids = attachmentIds(artifactIds);
  if (ids.length === 0 || !workspace) {
    return [];
  }
  const session = Number(sessionId);
  const attachments = [];
  for (const artifactId of ids) {
    let artifact = null;
    try {
      artifact = workspace.getArtifactAsync
        ? await workspace.getArtifactAsync({ artifactId, userId })
        : workspace.getArtifact({ artifactId, userId });
    } catch {
      continue;
    }
    const projected = projectAttachment(artifact, session);
    if (projected) attachments.push(projected);
  }
  return attachments;
}
