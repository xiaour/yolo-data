/** Workspace-related agent tools, bound to the current turn's authorized scope. */
export function createAgentWorkspaceToolHandlers({
  workspace,
  workspaceService,
  user,
  session,
  codeExecution,
  resolvedQuestion,
  getLastBusinessDataset,
  getLastIndicator,
  buildArtifactTitle,
  generatedCodeArtifacts,
  generatedWorkspaceArtifactIds,
  emit,
  validateAnalysisOutputsAsync,
}) {
  return {
    async listWorkspaceArtifacts() {
      if (!workspace || !workspaceService) return { artifacts: [] };
      const artifacts = workspaceService.listArtifactsAsync
        ? await workspaceService.listArtifactsAsync({ workspaceId: workspace.id, userId: user.id })
        : workspaceService.listArtifacts({ workspaceId: workspace.id, userId: user.id });
      const visible = artifacts.filter((artifact) => artifact.artifactType !== 'PROCESS_STEP');
      return {
        workspace,
        artifacts: await Promise.all(visible.map(async (artifact) => {
          const full = workspaceService.getArtifactAsync
            ? await workspaceService.getArtifactAsync({ artifactId: artifact.id, userId: user.id })
            : workspaceService.getArtifact({ artifactId: artifact.id, userId: user.id });
          return {
            ...artifact,
            columns: full?.payload?.data?.columns?.map((column) => ({
              name: column.name,
              bizName: column.bizName,
              showType: column.showType ?? column.type,
              unit: column.unit ?? '',
            })) ?? [],
            sampleRows: full?.payload?.data?.rows?.slice(0, 5) ?? [],
            format: full?.metadata?.format ?? full?.payload?.format ?? null,
          };
        })),
      };
    },
    async transformWorkspaceArtifact(args) {
      if (!workspaceService) throw new Error('workspace service is not configured');
      const artifact = workspaceService.transformArtifactAsync
        ? await workspaceService.transformArtifactAsync({
          artifactId: args.artifactId,
          userId: user.id,
          operation: args.operation,
          params: args.params ?? {},
        })
        : await workspaceService.transformArtifact({
          artifactId: args.artifactId,
          userId: user.id,
          operation: args.operation,
          params: args.params ?? {},
        });
      emit({ type: 'workspace_updated', workspaceId: artifact.workspaceId, artifactId: artifact.id });
      return {
        artifactId: artifact.id,
        title: artifact.title,
        version: artifact.currentVersion,
        rowCount: artifact.metadata?.rowCount ?? 0,
        columns: artifact.payload?.data?.columns ?? [],
        sampleRows: artifact.payload?.data?.rows?.slice(0, 10) ?? [],
        parentArtifactIds: artifact.metadata?.parentArtifactIds ?? [],
        summary: `已生成派生结果「${artifact.title}」，来源 artifact ${artifact.metadata?.derivedFromArtifactId ?? '-'}`,
      };
    },
    async executeAnalysisCode(args) {
      if (!workspace || !codeExecution) throw new Error('analysis code execution is not configured');
      if (String(args.language ?? 'python').toLowerCase() !== 'python') {
        throw new Error('only Python analysis code is currently supported');
      }
      const result = await codeExecution.run({
        userId: user.id,
        workspaceId: workspace.id,
        sessionId: session.id,
        code: args.code,
        inputArtifactIds: args.inputArtifactIds ?? [],
        outputFiles: args.outputFiles ?? [],
        timeoutSeconds: args.timeoutSeconds,
        purpose: args.purpose ?? '',
        artifactPrefix: buildArtifactTitle(resolvedQuestion, {
          fallback: getLastBusinessDataset()?.name ?? getLastIndicator()?.name ?? '问数产物',
        }),
      });
      if (result.codeArtifactId) generatedWorkspaceArtifactIds.push(result.codeArtifactId);
      for (const output of result.outputs) {
        generatedCodeArtifacts.push(output);
        generatedWorkspaceArtifactIds.push(output.artifactId);
        emit({ type: 'workspace_updated', workspaceId: workspace.id, artifactId: output.artifactId });
      }
      const analysis = await validateAnalysisOutputsAsync({ workspace, outputs: result.outputs });
      if (analysis && !analysis.valid) {
        emit({
          type: 'warning',
          message: `分析结果契约校验未通过：${analysis.issues.map((item) => item.code).join('、')}`,
        });
      }
      return {
        analysis,
        runId: result.runId,
        codeArtifactId: result.codeArtifactId,
        success: result.success,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        inputArtifacts: result.inputArtifacts,
        outputs: result.outputs,
        summary: result.success
          ? `代码执行完成，生成 ${result.outputs.length} 个文件产物`
          : `代码执行失败：${result.stderr || `exit ${result.exitCode}`}`,
      };
    },
  };
}
