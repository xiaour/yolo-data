import { resolveThemeBusinessDatasetsAsync } from '../themeDatasets.js';

// 开场建议的唯一数据来源：主题可见数据集字段、主题绑定指标与用户自己的会话历史。
// 数据集口径复用 agent 的解析方法，保证「建议卡片」和「实际能查的范围」一致。
export async function collectThemeSemantics({ theme, user, application, database }) {
  const metricNames = [];
  const dimensionNames = [];
  let datasetName = '';
  const { businessDatasets } = await resolveThemeBusinessDatasetsAsync({
    database,
    businessDatasets: application.businessDatasets,
    user,
    theme,
  });
  // Independent dataset field lookups are commonly remote-store queries; run
  // them together instead of making the first paint wait on each in sequence.
  const fieldsByDataset = await Promise.all(businessDatasets.map((dataset) =>
    application.businessDatasets.getDatasetFieldsAsync(Number(dataset.id), true)));
  for (const [index, dataset] of businessDatasets.entries()) {
    const datasetId = Number(dataset.id);
    if (!datasetId) {
      continue;
    }
    if (!datasetName) {
      datasetName = dataset.name ?? '';
    }
    for (const field of fieldsByDataset[index]) {
      const label = String(field?.displayName || field?.fieldName || '').trim();
      if (!label) {
        continue;
      }
      if (field.role === 'METRIC') {
        metricNames.push(label);
      } else if (field.role === 'DIMENSION') {
        dimensionNames.push(label);
      }
    }
  }
  for (const indicatorId of theme?.indicatorIds ?? []) {
    const indicator = database.localIndicators?.getAsync
      ? await database.localIndicators.getAsync(indicatorId)
      : database.localIndicators?.get?.(indicatorId);
    const label = String(indicator?.bizName || indicator?.name || '').trim();
    if (label) {
      metricNames.push(label);
    }
    for (const dimension of indicator?.dimensions ?? []) {
      const dimensionLabel = String(dimension?.bizName || dimension?.name || '').trim();
      if (dimensionLabel) {
        dimensionNames.push(dimensionLabel);
      }
    }
  }
  return { metricNames, dimensionNames, datasetName };
}

