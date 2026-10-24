import { buildProcessArtifact, KIND_LABELS, MAX_STEPS_PER_RUN } from './processArtifactDraft.js';

// 记录器：agent 每完成一个数据环节就调用一次；没有可读数据的环节直接跳过，
// 写入失败也只跳过，不影响主流程。
function createProcessArtifactRecorder({
  service,
  workspaceId,
  userId,
  sessionId,
  emit = () => {},
  artifactIds = null,
  maxSteps = MAX_STEPS_PER_RUN,
}) {
  const state = { previousArtifactId: null, count: 0 };
  return ({ tool, result = null, error = null, step = {} }) => {
    if (!service || !workspaceId || state.count >= maxSteps) {
      return null;
    }
    let artifact = null;
    try {
      const draft = buildProcessArtifact({
        tool,
        result,
        error,
        step,
        previousArtifactId: state.previousArtifactId,
      });
      if (!draft) {
        return null;
      }
      const input = {
        workspaceId,
        userId,
        sessionId,
        title: draft.title,
        metadata: draft.metadata,
        payload: draft.payload,
      };
      artifact = service.createProcessArtifact(input);
    } catch {
      return null;
    }
    state.previousArtifactId = artifact.id;
    state.count += 1;
    if (Array.isArray(artifactIds)) {
      artifactIds.push(artifact.id);
    }
    emit({ type: 'workspace_updated', workspaceId, artifactId: artifact.id });
    return artifact;
  };
}

function createProcessArtifactRecorderAsync(options) {
  const { service, workspaceId, userId, sessionId, emit = () => {}, artifactIds = null, maxSteps = MAX_STEPS_PER_RUN } = options;
  const state = { previousArtifactId: null, count: 0 };
  const record = async ({ tool, result = null, error = null, step = {} }) => {
    if (!service || !workspaceId || state.count >= maxSteps) return null;
    try {
      const draft = buildProcessArtifact({ tool, result, error, step, previousArtifactId: state.previousArtifactId });
      if (!draft) return null;
      const input = { workspaceId, userId, sessionId, title: draft.title, metadata: draft.metadata, payload: draft.payload };
      const artifact = service.createProcessArtifactAsync
        ? await service.createProcessArtifactAsync(input)
        : service.createProcessArtifact(input);
      state.previousArtifactId = artifact.id;
      state.count += 1;
      if (Array.isArray(artifactIds)) artifactIds.push(artifact.id);
      emit({ type: 'workspace_updated', workspaceId, artifactId: artifact.id });
      return artifact;
    } catch {
      return null;
    }
  };
  let pending = Promise.resolve();
  return input => {
    const result = pending.then(() => record(input));
    pending = result.catch(() => {});
    return result;
  };
}

export {
  buildProcessArtifact,
  createProcessArtifactRecorder,
  createProcessArtifactRecorderAsync,
  KIND_LABELS,
  MAX_STEPS_PER_RUN,
};
