// Artifact I/O is separate from shared analysis contract validation.
export function readArtifactText(workspace, artifactId, userId = undefined) {
  if (!workspace?.getArtifact || !artifactId) {
    return null;
  }
  let artifact = null;
  try {
    artifact = workspace.getArtifact({ artifactId, userId });
  } catch {
    return null;
  }
  const content = artifact?.payload?.content ?? artifact?.content ?? null;
  return content === null || content === undefined ? null : String(content);
}

export async function readArtifactTextAsync(workspace, artifactId, userId = undefined) {
  if (!workspace || !artifactId) return null;
  try {
    const artifact = workspace.getArtifactAsync
      ? await workspace.getArtifactAsync({ artifactId, userId })
      : workspace.getArtifact({ artifactId, userId });
    const content = artifact?.payload?.content ?? artifact?.content ?? null;
    return content === null || content === undefined ? null : String(content);
  } catch {
    return null;
  }
}

