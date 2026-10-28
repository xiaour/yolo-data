/**
 * Dataset tool adapters for the agent runtime. Dependencies are supplied by the
 * current turn so handlers do not reach into Agent internals or shared state.
 */
export function createAgentDatasetToolHandlers({
  businessDatasets,
  datasetService,
  getBusinessDatasetDefinition,
  runBusinessDatasetQuery,
  startWorkflowStage,
  completeWorkflowStage,
}) {
  return {
    async listBusinessDatasets() {
      startWorkflowStage('SEMANTIC_DISCOVERY', '检索业务数据集');
      completeWorkflowStage('SEMANTIC_DISCOVERY', {
        summary: `发现 ${businessDatasets.length} 个可访问业务数据集`,
        detail: businessDatasets.map((dataset) => dataset.name).join('、'),
      });
      return {
        datasets: await Promise.all(businessDatasets.map(async (dataset) => ({
          id: dataset.id,
          code: dataset.code,
          name: dataset.name,
          description: dataset.description,
          schemaName: dataset.schemaName,
          tableName: dataset.primaryTable,
          fieldCount: dataset.fieldCount,
          fields: (await datasetService.getDatasetFieldsAsync(dataset.id, true))
            .map((field) => ({
              name: field.fieldName,
              displayName: field.displayName,
              role: field.role,
              semanticType: field.semanticType,
              aggregator: field.aggregator,
              description: field.description,
            })),
        }))),
      };
    },
    getBusinessDatasetDefinition,
    runBusinessDatasetQuery,
  };
}
