import { DatasourceCrypto } from './datasourceCrypto.js';
import {
  normalizeLikePattern,
  resolveFilterScope,
} from './querySemantics.js';

// The MySQL driver is only required when a MySQL/Doris data source is actually
// used. Loading it lazily keeps the platform runnable (and testable) in
// "detached from database" mode without the optional dependency installed.
let mysql = null;
let mysqlLoadError = null;
try {
  mysql = (await import('mysql2/promise')).default;
} catch (error) {
  mysqlLoadError = error;
}

function requireMysql() {
  if (!mysql) {
    const error = new Error(
      'mysql2 驱动未安装：MySQL/Doris 数据源需要先执行 npm install mysql2',
    );
    error.cause = mysqlLoadError;
    throw error;
  }
  return mysql;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FILTER_OPERATORS = new Set([
  'IN',
  'NOT_IN',
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'LIKE',
  'BETWEEN',
  'IS_NULL',
  'IS_NOT_NULL',
]);
const TIME_GRAINS = new Set(['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR']);

function quoteIdentifier(value) {
  const text = String(value ?? '');
  if (!IDENTIFIER.test(text)) {
    throw new Error(`invalid SQL identifier: ${text}`);
  }
  return `\`${text}\``;
}

export function buildTimeGrainExpression(fieldName, timeGrain) {
  const column = quoteIdentifier(fieldName);
  switch (String(timeGrain ?? '').toUpperCase()) {
    case 'DAY':
      return `DATE_FORMAT(${column}, '%Y-%m-%d')`;
    case 'WEEK':
      return `DATE_FORMAT(DATE_SUB(DATE(${column}), INTERVAL WEEKDAY(${column}) DAY), '%Y-%m-%d')`;
    case 'MONTH':
      return `DATE_FORMAT(${column}, '%Y-%m')`;
    case 'QUARTER':
      return `CONCAT(YEAR(${column}), '-Q', QUARTER(${column}))`;
    case 'YEAR':
      return `DATE_FORMAT(${column}, '%Y')`;
    default:
      return column;
  }
}

function normalizeDataType(columnType) {
  const type = String(columnType ?? '').toLowerCase();
  if (/date|time/.test(type)) {
    return 'DATE';
  }
  if (/int|decimal|double|float|number|bigint|smallint|tinyint/.test(type)) {
    return 'NUMBER';
  }
  if (/bool/.test(type)) {
    return 'BOOLEAN';
  }
  return 'STRING';
}

function inferField(column) {
  const name = String(column.columnName ?? '');
  const comment = String(column.columnComment ?? '').trim();
  const semanticType = normalizeDataType(column.dataType);
  const lower = name.toLowerCase();
  const timeField = semanticType === 'DATE' || /(^|_)(date|time|day|month|year)($|_)/.test(lower);
  const metricField = semanticType === 'NUMBER'
    && /amount|amt|qty|quantity|cost|profit|price|rate|tax|count|fee|income|revenue/.test(lower);
  const identifier = /(^|_)(id|code|no|number)($|_)/.test(lower);
  const role = timeField
    ? 'TIME'
    : metricField
      ? 'METRIC'
      : identifier
        ? 'IDENTIFIER'
        : 'DIMENSION';
  const aggregator = role !== 'METRIC'
    ? 'NONE'
    : /rate|ratio/.test(lower)
      ? 'AVG'
      : 'SUM';
  const allowedOperators = semanticType === 'STRING'
    ? ['IN', 'NOT_IN', '=', '!=', 'LIKE']
    : ['IN', 'NOT_IN', '=', '!=', '>', '>=', '<', '<=', 'BETWEEN'];
  return {
    fieldName: name,
    displayName: comment || name,
    dataType: column.columnType,
    semanticType,
    role,
    aggregator,
    description: comment,
    allowedOperators,
    ordinalPosition: Number(column.ordinalPosition ?? 0),
    enabled: true,
  };
}

function normalizeDatasetFilters(filters, fieldsByName) {
  return (filters ?? []).map((filter) => {
    const field = fieldsByName.get(String(filter.field ?? filter.bizName ?? ''));
    if (!field) {
      throw new Error(`dataset filter field not found: ${filter.field ?? filter.bizName}`);
    }
    const operator = String(filter.operator ?? 'IN').toUpperCase();
    if (!FILTER_OPERATORS.has(operator)) {
      throw new Error(`unsupported dataset filter operator: ${operator}`);
    }
    if (
      field.allowedOperators.length > 0
      && !field.allowedOperators.includes(operator)
    ) {
      throw new Error(`operator ${operator} is not allowed for field ${field.fieldName}`);
    }
    const scope = resolveFilterScope({
      field,
      operator,
      sourceText: filter.sourceText,
    });
    return {
      field,
      operator,
      value: operator === 'LIKE'
        ? normalizeLikePattern(filter.value, filter.sourceText)
        : filter.value,
      scope: filter.scope === 'AGGREGATE' ? 'AGGREGATE' : scope,
    };
  });
}

export class BusinessDatasetService {
  constructor({ database, crypto, config }) {
    this.database = database;
    this.crypto = crypto;
    this.config = config;
    this.pools = new Map();
  }

  listDataSources() {
    return this.database.listDataSources();
  }

  listDatasets({ userId = null, includeDisabled = false } = {}) {
    return this.database.listBusinessDatasets({ userId, includeDisabled });
  }

  getDataset(datasetId) {
    return this.database.getBusinessDataset(datasetId);
  }

  getDatasetFields(datasetId, enabledOnly = false) {
    return this.database.listDatasetFields(datasetId, { enabledOnly });
  }

  saveDataSource(payload, id = null) {
    const encryptedPassword = payload.password
      ? this.crypto.encrypt(payload.password)
      : payload.encryptedPassword;
    const source = this.database.saveDataSource({
      ...payload,
      encryptedPassword,
    }, id);
    this.closePool(source.code);
    return source;
  }

  async testDataSource(sourceOrId) {
    const source = typeof sourceOrId === 'object'
      ? sourceOrId
      : this.database.getDataSource(sourceOrId);
    if (!source) {
      throw new Error('data source not found');
    }
    const pool = this.createPool(source);
    try {
      await pool.query('SELECT 1');
      return this.database.updateDataSourceTest(source.id, {
        ok: true,
        message: '连接成功',
      });
    } catch (error) {
      return this.database.updateDataSourceTest(source.id, {
        ok: false,
        message: error.message,
      });
    } finally {
      await pool.end().catch(() => {});
    }
  }

  createPool(source) {
    return requireMysql().createPool({
      host: source.host,
      port: Number(source.port),
      user: source.username,
      password: source.encryptedPassword
        ? this.crypto.decrypt(source.encryptedPassword)
        : '',
      database: source.databaseName || undefined,
      waitForConnections: true,
      connectionLimit: 4,
      maxIdle: 2,
      idleTimeout: 60_000,
      queueLimit: 20,
      charset: 'utf8mb4',
      timezone: '+08:00',
      dateStrings: true,
      multipleStatements: false,
      connectTimeout: 10_000,
    });
  }

  getPool(source) {
    if (!this.pools.has(source.code)) {
      this.pools.set(source.code, this.createPool(source));
    }
    return this.pools.get(source.code);
  }

  closePool(code) {
    const pool = this.pools.get(code);
    if (pool) {
      pool.end().catch(() => {});
      this.pools.delete(code);
    }
  }

  async listDatabases(sourceId) {
    const source = this.database.getDataSource(sourceId);
    const [rows] = await this.getPool(source).query('SHOW DATABASES');
    return rows.map((row) => Object.values(row)[0]);
  }

  async listTables(sourceId, schemaName) {
    const source = this.database.getDataSource(sourceId);
    const [rows] = await this.getPool(source).query({
      sql: `
        SELECT table_name AS tableName, table_type AS tableType,
               table_comment AS tableComment, table_rows AS approxRows
        FROM information_schema.tables
        WHERE table_schema = ?
        ORDER BY table_rows DESC, table_name
      `,
      values: [schemaName],
    });
    return rows;
  }

  async listColumns(sourceId, schemaName, tableName) {
    const source = this.database.getDataSource(sourceId);
    const [rows] = await this.getPool(source).query({
      sql: `
        SELECT ordinal_position AS ordinalPosition, column_name AS columnName,
               data_type AS dataType, column_type AS columnType,
               is_nullable AS isNullable, column_comment AS columnComment
        FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ?
        ORDER BY ordinal_position
      `,
      values: [schemaName, tableName],
    });
    return rows;
  }

  async createDataset(payload) {
    const source = this.database.getDataSource(payload.datasourceId);
    if (!source) {
      throw new Error('data source not found');
    }
    const columns = await this.listColumns(
      source.id,
      payload.schemaName,
      payload.primaryTable,
    );
    if (columns.length === 0) {
      throw new Error('table has no columns or does not exist');
    }
    const dataset = this.database.saveBusinessDataset(payload);
    const fields = columns.map(inferField);
    this.database.replaceDatasetFields(dataset.id, fields);
    return this.getDataset(dataset.id);
  }

  async syncDatasetFields(datasetId) {
    const dataset = this.database.getBusinessDataset(datasetId);
    if (!dataset) {
      throw new Error('dataset not found');
    }
    const columns = await this.listColumns(
      dataset.datasourceId,
      dataset.schemaName,
      dataset.primaryTable,
    );
    return this.database.replaceDatasetFields(
      dataset.id,
      columns.map(inferField),
    );
  }

  async sampleDataset(datasetId, limit = 20) {
    const dataset = this.database.getBusinessDataset(datasetId);
    if (!dataset) {
      throw new Error('dataset not found');
    }
    const fields = this.database.listDatasetFields(dataset.id, { enabledOnly: true });
    const selected = fields.slice(0, 20);
    if (selected.length === 0) {
      throw new Error('dataset has no enabled fields');
    }
    const sql = `SELECT ${
      selected.map((field) => quoteIdentifier(field.fieldName)).join(', ')
    } FROM ${quoteIdentifier(dataset.schemaName)}.${quoteIdentifier(dataset.primaryTable)} LIMIT ?`;
    const [rows, fieldPackets] = await this.getPoolById(dataset.datasourceId).query({
      sql,
      values: [Math.max(1, Math.min(Number(limit) || 20, 100))],
      timeout: 15_000,
    });
    return {
      columns: fieldPackets.map((field) => field.name),
      rows,
    };
  }

  async listDistinctFieldValues(datasetId, fieldName, { limit = 200 } = {}) {
    const dataset = this.database.getBusinessDataset(datasetId);
    if (!dataset) {
      throw new Error('dataset not found');
    }
    const field = this.database
      .listDatasetFields(dataset.id, { enabledOnly: true })
      .find((item) => item.fieldName === fieldName);
    if (!field) {
      throw new Error(`dataset field not found: ${fieldName}`);
    }
    const column = quoteIdentifier(field.fieldName);
    const sql = `SELECT DISTINCT ${column} AS value FROM ${
      quoteIdentifier(dataset.schemaName)
    }.${quoteIdentifier(dataset.primaryTable)} WHERE ${column} IS NOT NULL LIMIT ?`;
    const [rows] = await this.getPoolById(dataset.datasourceId).query({
      sql,
      values: [Math.max(1, Math.min(Number(limit) || 200, 500))],
      timeout: 20_000,
    });
    return [...new Set(rows
      .map((row) => String(row?.value ?? '').trim())
      .filter(Boolean))];
  }

  getPoolById(datasourceId) {
    const source = this.database.getDataSource(datasourceId);
    if (!source) {
      throw new Error('data source not found');
    }
    return this.getPool(source);
  }

  buildQuery(datasetId, request) {
    const dataset = this.database.getBusinessDataset(datasetId);
    if (!dataset) {
      throw new Error('dataset not found');
    }
    const fields = this.database.listDatasetFields(dataset.id, { enabledOnly: true });
    const fieldsByName = new Map(fields.map((field) => [field.fieldName, field]));
    const dimensions = [...new Set((request.dimensions ?? []).map(String))]
      .map((name) => fieldsByName.get(name))
      .filter(Boolean);
    const requestedTimeGrain = String(request.timeGrain ?? '').toUpperCase();
    const dimensionSelections = dimensions.map((dimension) => ({
      field: dimension,
      expression: dimension.role === 'TIME' && TIME_GRAINS.has(requestedTimeGrain)
        ? buildTimeGrainExpression(dimension.fieldName, requestedTimeGrain)
        : quoteIdentifier(dimension.fieldName),
    }));
    const metrics = (request.metrics ?? []).map((item) => {
      const fieldName = typeof item === 'string' ? item : item.field;
      const field = fieldsByName.get(String(fieldName));
      if (!field) {
        throw new Error(`dataset metric field not found: ${fieldName}`);
      }
      const aggregator = String(item?.aggregator ?? field.aggregator ?? 'SUM').toUpperCase();
      if (!['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNT_DISTINCT'].includes(aggregator)) {
        throw new Error(`unsupported aggregator: ${aggregator}`);
      }
      return { field, aggregator };
    });
    if (metrics.length === 0 && dimensions.length === 0) {
      throw new Error('dataset query requires metrics or dimensions');
    }
    const filters = normalizeDatasetFilters(request.filters, fieldsByName);
    const selectParts = [];
    for (const dimension of dimensionSelections) {
      selectParts.push(
        `${dimension.expression} AS ${quoteIdentifier(dimension.field.fieldName)}`,
      );
    }
    for (const metric of metrics) {
      const expression = metric.aggregator === 'COUNT_DISTINCT'
        ? `COUNT(DISTINCT ${quoteIdentifier(metric.field.fieldName)})`
        : `${metric.aggregator}(${quoteIdentifier(metric.field.fieldName)})`;
      selectParts.push(`${expression} AS ${quoteIdentifier(metric.field.fieldName)}`);
    }
    const whereParts = [];
    const havingParts = [];
    const whereValues = [];
    const havingValues = [];
    const metricSelectionByField = new Map(
      metrics.map((metric) => [metric.field.fieldName, metric]),
    );
    const filterExpression = (filter) => {
      const selectedMetric = metricSelectionByField.get(filter.field.fieldName);
      const aggregateFilter = filter.scope === 'AGGREGATE'
        || filter.field.role === 'METRIC';
      if (!aggregateFilter) {
        return quoteIdentifier(filter.field.fieldName);
      }
      const aggregator = selectedMetric?.aggregator
        ?? String(filter.field.aggregator ?? 'SUM').toUpperCase();
      return aggregator === 'COUNT_DISTINCT'
        ? `COUNT(DISTINCT ${quoteIdentifier(filter.field.fieldName)})`
        : `${aggregator}(${quoteIdentifier(filter.field.fieldName)})`;
    };
    const appendFilter = (filter) => {
      const aggregateFilter = filter.scope === 'AGGREGATE'
        || filter.field.role === 'METRIC';
      const parts = aggregateFilter ? havingParts : whereParts;
      const filterValues = aggregateFilter ? havingValues : whereValues;
      const expression = filterExpression(filter);
      if (filter.operator === 'IS_NULL' || filter.operator === 'IS_NOT_NULL') {
        parts.push(`${expression} ${filter.operator.replaceAll('_', ' ')}`);
        return;
      }
      if (filter.operator === 'IN' || filter.operator === 'NOT_IN') {
        const list = Array.isArray(filter.value) ? filter.value : [filter.value];
        if (list.length === 0) {
          parts.push('1 = 0');
          return;
        }
        parts.push(`${expression} ${filter.operator.replaceAll('_', ' ')} (${list.map(() => '?').join(', ')})`);
        filterValues.push(...list);
        return;
      }
      if (filter.operator === 'BETWEEN') {
        const list = Array.isArray(filter.value) ? filter.value : [];
        if (list.length !== 2) {
          throw new Error(`BETWEEN requires two values for ${filter.field.fieldName}`);
        }
        parts.push(`${expression} BETWEEN ? AND ?`);
        filterValues.push(list[0], list[1]);
        return;
      }
      parts.push(`${expression} ${filter.operator} ?`);
      filterValues.push(filter.value);
    };
    for (const filter of filters) {
      appendFilter(filter);
    }
    const dateRange = request.dateRange ?? null;
    if (dateRange) {
      const dateField = dateRange.field
        ? fieldsByName.get(String(dateRange.field))
        : fields.find((field) => field.role === 'TIME');
      if (!dateField || dateField.role !== 'TIME') {
        throw new Error('dataset time field not found');
      }
      const column = quoteIdentifier(dateField.fieldName);
      if (dateRange.startDate) {
        whereParts.push(`${column} >= ?`);
        whereValues.push(dateRange.startDate);
      }
      if (dateRange.endDate) {
        whereParts.push(`${column} <= ?`);
        whereValues.push(dateRange.endDate);
      }
    }
    const groupBy = dimensions.length > 0 && metrics.length > 0
      ? ` GROUP BY ${dimensionSelections.map((dimension) => dimension.expression).join(', ')}`
      : '';
    const orderParts = [];
    const groupedTimeDimension = dimensionSelections.find(
      (dimension) => dimension.field.role === 'TIME',
    );
    for (const order of request.order ?? []) {
      const field = fieldsByName.get(String(order.field));
      if (!field) {
        continue;
      }
      const dimensionSelection = dimensionSelections.find(
        (dimension) => dimension.field.fieldName === field.fieldName,
      );
      const orderExpression = dimensionSelection?.expression
        ?? (field.role === 'TIME' ? groupedTimeDimension?.expression : null)
        ?? quoteIdentifier(field.fieldName);
      orderParts.push(
        `${orderExpression} ${String(order.direction).toUpperCase() === 'ASC' ? 'ASC' : 'DESC'}`,
      );
    }
    const orderBy = orderParts.length > 0 ? ` ORDER BY ${orderParts.join(', ')}` : '';
    const having = havingParts.length > 0
      ? ` HAVING ${havingParts.join(' AND ')}`
      : '';
    const limit = Math.max(
      1,
      Math.min(
        Number(request.limit) || 200,
        request.analysisPipeline ? 50000 : 1000,
      ),
    );
    const sql = `SELECT ${selectParts.join(', ')} FROM ${
      quoteIdentifier(dataset.schemaName)
    }.${quoteIdentifier(dataset.primaryTable)}${
      whereParts.length ? ` WHERE ${whereParts.join(' AND ')}` : ''
    }${groupBy}${having}${orderBy} LIMIT ?`;
    const values = [...whereValues, ...havingValues];
    values.push(limit);
    return {
      dataset,
      sql,
      values,
      dimensions,
      timeGrain: TIME_GRAINS.has(requestedTimeGrain) ? requestedTimeGrain : null,
      metrics,
      filters,
      limit,
    };
  }

  async executeQuery({
    datasetId,
    request,
    userId,
    sessionId,
  }) {
    const dataset = this.database.getBusinessDataset(datasetId);
    if (!dataset) {
      throw new Error('dataset not found');
    }
    const fields = this.database.listDatasetFields(dataset.id, { enabledOnly: true });
    const effectiveRequest = { ...request };
    if (
      !effectiveRequest.dateRange
      && dataset.config?.autoLatestDateRange !== false
    ) {
      const timeField = fields.find((field) => field.role === 'TIME');
      if (timeField) {
        const [rows] = await this.getPoolById(dataset.datasourceId).query({
          sql: `SELECT MAX(${quoteIdentifier(timeField.fieldName)}) AS maxDate FROM ${
            quoteIdentifier(dataset.schemaName)
          }.${quoteIdentifier(dataset.primaryTable)}`,
          timeout: 15_000,
        });
        const maxDate = rows[0]?.maxDate;
        if (maxDate) {
          const endDate = maxDate instanceof Date
            ? maxDate.toISOString().slice(0, 10)
            : String(maxDate).slice(0, 10);
          const end = new Date(`${endDate}T00:00:00Z`);
          const start = new Date(end);
          start.setUTCDate(
            start.getUTCDate() - Number(dataset.config?.autoRangeDays || 30) + 1,
          );
          effectiveRequest.dateRange = {
            field: timeField.fieldName,
            startDate: start.toISOString().slice(0, 10),
            endDate,
          };
        }
      }
    }
    const compiled = this.buildQuery(datasetId, effectiveRequest);
    const startedAt = Date.now();
    try {
      const [rows, fieldPackets] = await this.getPoolById(compiled.dataset.datasourceId).query({
        sql: compiled.sql,
        values: compiled.values,
        timeout: 20_000,
      });
      const latencyMs = Date.now() - startedAt;
      this.database.logDatasetQuery({
        userId,
        sessionId,
        datasetId: compiled.dataset.id,
        sqlText: compiled.sql,
        rowCount: rows.length,
        latencyMs,
        success: true,
      });
      return {
        columns: fieldPackets.map((field) => {
          const definition = fields.find((item) => item.fieldName === field.name);
          const groupedTimeDimension = Boolean(
            compiled.timeGrain && definition?.role === 'TIME',
          );
          const numeric = definition?.role === 'METRIC'
            || definition?.semanticType === 'NUMBER'
            || /decimal|int|double|float|bigint/i.test(String(field.type));
          return {
            name: definition?.displayName ?? field.name,
            bizName: field.name,
            showType: numeric && !groupedTimeDimension ? 'NUMBER' : 'CATEGORY',
            type: groupedTimeDimension
              ? 'STRING'
              : definition?.dataType ?? String(field.type),
            unit: definition?.unit ?? '',
          };
        }),
        rows,
        sql: compiled.sql,
        dataset: compiled.dataset,
        dimensions: compiled.dimensions,
        metrics: compiled.metrics,
        filters: compiled.filters,
        limit: compiled.limit,
        truncated: rows.length >= compiled.limit,
        latencyMs,
      };
    } catch (error) {
      this.database.logDatasetQuery({
        userId,
        sessionId,
        datasetId: compiled.dataset.id,
        sqlText: compiled.sql,
        rowCount: 0,
        latencyMs: Date.now() - startedAt,
        success: false,
        errorMessage: error.message,
      });
      throw error;
    }
  }

  async bootstrap(config) {
    if (!config.enabled || !config.host || !config.username || !config.password) {
      return null;
    }
    let source = this.database.getDataSourceByCode('doris_dev');
    if (!source) {
      source = this.saveDataSource({
        code: 'doris_dev',
        name: 'Doris 开发测试库',
        dbType: 'DORIS',
        host: config.host,
        port: config.port,
        databaseName: config.database,
        username: config.username,
        password: config.password,
        options: {
          readonly: true,
          maxRows: 1000,
          queryTimeoutMs: 20_000,
        },
      });
    }
    await this.testDataSource(source);
    const datasetDefinitions = [
      {
        code: 'sales_performance',
        name: '销售经营分析',
        description: '基于 BI 销售明细宽表的销售、成本、毛利和客户商品分析',
        table: config.salesTable,
        requireDateRange: true,
        autoLatestDateRange: true,
        autoRangeDays: 30,
      },
      {
        code: 'product_master',
        name: '商品主数据',
        description: '商品、品牌、分类、供应商和存储条件主数据',
        table: config.goodsTable,
        requireDateRange: false,
        autoLatestDateRange: false,
      },
    ].filter((item) => item.table);
    const created = [];
    for (const definition of datasetDefinitions) {
      let dataset = this.database.getBusinessDatasetByCode(definition.code);
      if (!dataset) {
        dataset = await this.createDataset({
          code: definition.code,
          name: definition.name,
          description: definition.description,
          datasourceId: source.id,
          schemaName: config.database,
          primaryTable: definition.table,
          config: {
            readonly: true,
            maxRows: 1000,
            queryTimeoutMs: 20_000,
            requireDateRange: definition.requireDateRange,
            autoLatestDateRange: definition.autoLatestDateRange,
            autoRangeDays: definition.autoRangeDays,
            policyFieldMap: dataset.config?.policyFieldMap ?? {},
            policyValueMap: dataset.config?.policyValueMap ?? {},
          },
        });
      } else {
        dataset = this.database.saveBusinessDataset({
          ...dataset,
          config: {
            ...dataset.config,
            readonly: true,
            maxRows: 1000,
            queryTimeoutMs: 20_000,
            requireDateRange: definition.requireDateRange,
            autoLatestDateRange: definition.autoLatestDateRange,
            autoRangeDays: definition.autoRangeDays,
            policyFieldMap: definition.policyFieldMap ?? {},
            policyValueMap: definition.policyValueMap ?? {},
          },
        }, dataset.id);
        await this.syncDatasetFields(dataset.id);
      }
      created.push(this.getDataset(dataset.id));
    }
    return created;
  }

  async close() {
    await Promise.all([...this.pools.values()].map((pool) => pool.end().catch(() => {})));
    this.pools.clear();
  }
}

export { inferField, quoteIdentifier, FILTER_OPERATORS };
