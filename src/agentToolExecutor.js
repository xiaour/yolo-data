export function createAgentToolExecutor({ skillRegistry, skills, processSteps, appendProcessStep, emit, executeRawTool, describeToolStep, buildToolReview, recordProcessArtifact, toolStageCode }) {
  return async (name, args) => {
      const skill = skillRegistry.resolveToolSkill(skills, name);
      const step = {
        id: `step-${processSteps.length + 1}`,
        type: 'tool',
        status: 'running',
        name,
        stageCode: toolStageCode(name),
        skillCode: skill?.code ?? null,
        skillName: skill?.name ?? name,
        title: skill?.name ?? name,
        detail: '正在执行',
        args,
        startedAt: new Date().toISOString(),
        durationMs: null,
      };
      appendProcessStep(step);
      emit({
        type: 'tool_call',
        step: { ...step },
        name,
        args,
      });
      const startedAt = Date.now();
      try {
        const result = await executeRawTool(name, args);
        const description = describeToolStep(name, args, result);
        Object.assign(step, {
          status: 'success',
          title: description.title,
          detail: description.detail,
          durationMs: Date.now() - startedAt,
          resultSummary: description.detail,
          review: buildToolReview(name, args, result),
        });
        const stepArtifact = await recordProcessArtifact({
          tool: name,
          result,
          step: { ...step, sequence: processSteps.length },
        });
        if (stepArtifact) {
          step.artifactId = stepArtifact.id;
          step.artifactTitle = stepArtifact.title;
        }
        for (const previous of processSteps) {
          if (
            previous.id !== step.id
            && previous.type === 'tool'
            && previous.name === name
            && previous.status === 'error'
          ) {
            previous.superseded = true;
            emit({
              type: 'process_step',
              step: { ...previous },
            });
          }
        }
        emit({
          type: 'process_step',
          step: { ...step },
        });
        emit({
          type: 'tool_result',
          step: { ...step },
          name,
          durationMs: step.durationMs,
          summary: description.detail,
          rowCount: result?.rowCount ?? result?.rows?.length ?? null,
        });
        if (result?.sql) {
          emit({
            type: 'sql',
            tool: name,
            datasetId: result?.dataset?.id ?? args.datasetId ?? null,
            rowCount: result?.rows?.length ?? 0,
            sql: result.sql,
          });
        }
        return result;
      } catch (error) {
        Object.assign(step, {
          status: 'error',
          detail: error.message,
          durationMs: Date.now() - startedAt,
          error: error.message,
          review: buildToolReview(name, args, {}),
        });
        const failedArtifact = await recordProcessArtifact({
          tool: name,
          error,
          step: { ...step, sequence: processSteps.length },
        });
        if (failedArtifact) {
          step.artifactId = failedArtifact.id;
          step.artifactTitle = failedArtifact.title;
        }
        emit({
          type: 'process_step',
          step: { ...step },
        });
        emit({
          type: 'tool_error',
          step: { ...step },
          name,
          durationMs: step.durationMs,
          message: error.message,
        });
        throw error;
      }
    };
}
