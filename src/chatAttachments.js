import { resolveQuestionAttachments, resolveQuestionAttachmentsAsync } from './questionAttachments.js';
export { resolveQuestionAttachments, resolveQuestionAttachmentsAsync, MAX_ATTACHMENTS_PER_QUESTION } from './questionAttachments.js';

// 落库用户提问并绑定附件：一次调用同时完成 appendUserMessage 和 message 绑定，
// 使「这一问引用了哪些文件」可被追溯，并在提问气泡中展示。
export function appendUserQuestionWithAttachments({
  memory,
  workspace,
  session,
  user,
  question,
  displayQuestion = '',
  artifactIds = [],
}) {
  const attachments = resolveQuestionAttachments({
    workspace,
    userId: user.id,
    sessionId: session.id,
    artifactIds,
  });
  const message = memory.appendUserMessage(
    session.id,
    user.id,
    String(displayQuestion ?? '').trim() || question,
    {
      attachments,
      question,
    },
  );
  if (attachments.length > 0 && workspace) {
    const input = {
      artifactIds: attachments.map((item) => item.artifactId),
      userId: user.id,
      messageId: message.id,
    };
    if (workspace.bindArtifactsToMessage) workspace.bindArtifactsToMessage(input);
  }
  return { message, attachments };
}

export async function appendUserQuestionWithAttachmentsAsync(args) {
  const attachments = await resolveQuestionAttachmentsAsync({ workspace: args.workspace, userId: args.user.id, sessionId: args.session.id, artifactIds: args.artifactIds });
  const message = await args.memory.appendUserMessageAsync(
    args.session.id,
    args.user.id,
    String(args.displayQuestion ?? '').trim() || args.question,
    { attachments, question: args.question },
  );
  if (attachments.length > 0 && args.workspace) {
    const input = { artifactIds: attachments.map((item) => item.artifactId), userId: args.user.id, messageId: message.id };
    if (args.workspace.bindArtifactsToMessageAsync) await args.workspace.bindArtifactsToMessageAsync(input);
    else if (args.workspace.bindArtifactsToMessage) args.workspace.bindArtifactsToMessage(input);
  }
  return { message, attachments };
}
