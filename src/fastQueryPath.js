import { buildSemanticFastPathDraft } from './fastPathDraft.js';

export { buildSemanticFastPathDraft };

/**
 * Resolve a prompt-defined metric synonym across the datasets available to a
 * theme. When no primary dataset is configured, only return an automatic
 * choice if exactly one dataset has a complete, eligible semantic match.
 */
export async function resolveSemanticFastPathCandidate({
  question,
  theme,
  datasets = [],
  preferredDatasetId = null,
  loadDatasetFields,
  now = new Date(),
} = {}) {
  const preferred = datasets.find((dataset) => (
    preferredDatasetId != null
    && String(dataset.id) === String(preferredDatasetId)
  ));
  const candidatesToCheck = preferred ? [preferred] : datasets;
  const eligible = [];
  const errors = [];

  for (const dataset of candidatesToCheck) {
    try {
      const datasetFields = await loadDatasetFields(dataset);
      const fastPath = buildSemanticFastPathDraft({
        question,
        theme,
        datasetFields,
        now,
      });
      if (fastPath.eligible) eligible.push({ dataset, fastPath });
    } catch (error) {
      errors.push({ datasetId: dataset.id, error });
    }
  }

  return {
    candidate: eligible.length === 1 ? eligible[0] : null,
    ambiguous: eligible.length > 1,
    eligibleDatasetIds: eligible.map(({ dataset }) => dataset.id),
    errors,
  };
}
