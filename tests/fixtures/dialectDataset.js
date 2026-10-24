import { BusinessDatasetService } from '../../src/businessDatasets.js';

export function dialectDataset(dbType = 'POSTGRESQL', schemaName = 'public') {
  const source = { id: 1, code: 'test', dbType, host: 'localhost', port: 5432, databaseName: 'test', options: {} };
  const dataset = { id: 1, datasourceId: 1, dbType, schemaName, primaryTable: 'sales', config: { autoLatestDateRange: false } };
  const fields = [
    { fieldName: 'day', role: 'TIME', semanticType: 'DATE', aggregator: 'NONE' },
    { fieldName: 'region', role: 'DIMENSION', semanticType: 'STRING', aggregator: 'NONE' },
    { fieldName: 'order_id', role: 'IDENTIFIER', semanticType: 'STRING', aggregator: 'NONE' },
    { fieldName: 'amount', role: 'METRIC', semanticType: 'NUMBER', aggregator: 'SUM' },
  ].map((field) => ({ ...field, dataType: field.semanticType === 'NUMBER' ? 'numeric' : 'text', allowedOperators: [] }));
  const logs = [];
  const database = {
    isInMemory: true,
    getDataSource: () => source,
    getBusinessDataset: () => dataset,
    listDatasetFields: () => fields,
    logDatasetQuery: (log) => logs.push(log),
    updateDataSourceTest: (_id, result) => result,
  };
  const service = new BusinessDatasetService({ database, crypto: { decrypt: (value) => value }, config: {} });
  return { service, source, dataset, fields, database, logs };
}

export const dialectRequest = {
  dimensions: ['day'], timeGrain: 'MONTH',
  metrics: [
    { field: 'amount', outputField: 'east_amount', predicateFilters: [{ field: 'region', operator: '=', value: 'east' }] },
    { field: 'order_id', aggregator: 'COUNT_DISTINCT', outputField: 'orders' },
  ],
  filters: [
    { field: 'region', operator: 'IN', value: ['east', 'west'] },
    { field: 'amount', operator: '>', value: 5, scope: 'AGGREGATE' },
  ],
  dateRange: { field: 'day', startDate: '2026-01-01', endDate: '2026-03-31' },
  order: [{ field: 'day', direction: 'ASC' }], limit: 10,
};
