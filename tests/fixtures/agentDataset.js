import { createApplication } from '../../src/application.js';

// Keep context, permissions, compilation, SQL execution and audit real. Only the
// network pool is replaced by SQLite, using the same generated SELECT and binds.
export async function createAgentApplication(config) {
  const application = await createApplication(config);
  return configureAgentDataset(application);
}

export function configureAgentDataset(application) {
  const { database } = application;
  const source = database.saveDataSource({ code: 'agent_sales', name: '销售测试库',
    dbType: 'MYSQL', host: 'localhost', port: 3306, databaseName: 'main', username: 'test',
    encryptedPassword: '', options: { readonly: true } });
  const dataset = database.saveBusinessDataset({ code: 'agent_sales', name: '销售经营分析',
    datasourceId: source.id, schemaName: 'main', primaryTable: 'agent_sales',
    config: { autoLatestDateRange: false, policyFieldMap: { region: 'region' } } });
  database.replaceDatasetFields(dataset.id, [
    { fieldName: 'date', displayName: '日期', role: 'TIME', semanticType: 'DATE', dataType: 'date', aggregator: 'NONE' },
    { fieldName: 'region', displayName: '区域', role: 'DIMENSION', semanticType: 'STRING', dataType: 'varchar', aggregator: 'NONE' },
    { fieldName: 'channel', displayName: '渠道', role: 'DIMENSION', semanticType: 'STRING', dataType: 'varchar', aggregator: 'NONE' },
    { fieldName: 'sales_amount', displayName: '销售额', role: 'METRIC', semanticType: 'NUMBER', dataType: 'decimal', aggregator: 'SUM' },
    { fieldName: 'order_count', displayName: '订单量', role: 'METRIC', semanticType: 'NUMBER', dataType: 'integer', aggregator: 'SUM' },
  ].map(field => ({ ...field, allowedOperators: ['=', 'IN', 'BETWEEN'] })));
  database.db.exec('CREATE TABLE agent_sales (date TEXT, region TEXT, channel TEXT, sales_amount REAL, order_count INTEGER)');
  const insert = database.db.prepare('INSERT INTO agent_sales VALUES (?, ?, ?, ?, ?)');
  for (let day = 0; day < 7; day += 1) {
    const date = new Date(Date.now() - day * 86400000).toISOString().slice(0, 10);
    for (const region of ['华东', '华南']) for (const channel of ['线上', '门店']) {
      insert.run(date, region, channel, region === '华东' ? 100 + day : 99999, 10 + day);
    }
  }
  database.db.function('DATE_FORMAT', (value) => String(value).slice(0, 10));
  const statements = [];
  application.businessDatasets.getPoolById = () => ({ query: async (request, values) => {
    const sql = typeof request === 'string' ? request : request.sql;
    const bindings = values ?? request.values ?? [];
    statements.push({ sql, values: bindings });
    const statement = database.db.prepare(sql);
    return [statement.all(...bindings), statement.columns()];
  } });
  const user = database.getUserByUsername('east_manager');
  database.grantDatasetAccess(user.id, dataset.id, true);
  const theme = database.listThemes().find(item => item.name === '经营总览');
  database.saveTheme({ ...theme, indicatorIds: [], businessDatasetIds: [dataset.id],
    primaryBusinessDatasetId: dataset.id, semanticPolicy: {},
    systemPrompt: '销售额对应 sales_amount，订单量对应 order_count，均使用 SUM；日期为 date，区域为 region，渠道为 channel。' }, theme.id);
  application.testDataset = dataset;
  application.testStatements = statements;
  return application;
}
