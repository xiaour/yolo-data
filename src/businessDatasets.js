import { DatasourceCrypto } from './datasourceCrypto.js';
import { fallbackUnlessDisabled, getActivePool, getActivePoolAsync } from './datasourcePool.js';
import { getDialect, normalizeDataSource } from './dialects/index.js';
import { classifyColumnType as normalizeDataType } from './dialects/common.js';
import {
  normalizeProfileSelection,
  profileDataset as buildDatasetProfile,
} from './datasetProfiler.js';
import {
  appendPredicateFilter,
  metricOutputField,
  normalizeDatasetFilters,
} from './scopedMetrics.js';

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

export function buildTimeGrainExpression(fieldName, timeGrain, dbType = 'MYSQL') {
  const dialect = getDialect(dbType);
  return dialect.timeGrainExpr(dialect.quoteIdentifier(fieldName), timeGrain);
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

  async listDataSourcesAsync() {
    if (this.database.isInMemory) return this.database.listDataSources();
    return this.database.dataSourceRepository.listDataSourcesAsync();
  }

  async getDataSourceAsync(sourceId) {
    if (this.database.isInMemory) return this.database.getDataSource(sourceId);
    return this.database.dataSourceRepository.getDataSourceAsync(sourceId);
  }

  async getDataSourceByCodeAsync(code) {
    if (this.database.isInMemory) return this.database.getDataSourceByCode(code);
    return this.database.dataSourceRepository.getDataSourceByCodeAsync(code);
  }

  async listDatasetsAsync({ userId = null, includeDisabled = false } = {}) {
    if (this.database.isInMemory) return this.database.listBusinessDatasets({ userId, includeDisabled });
    return this.database.listBusinessDatasetsAsync({ userId, includeDisabled });
  }

  listDatasets({ userId = null, includeDisabled = false } = {}) {
    return this.database.listBusinessDatasets({ userId, includeDisabled });
  }

  async getDatasetAsync(datasetId) {
    return (this.database.isInMemory ? false : this.database.getBusinessDatasetAsync)
      ? this.database.getBusinessDatasetAsync(datasetId)
      : this.database.getBusinessDataset(datasetId);
  }

  getDataset(datasetId) {
    return this.database.getBusinessDataset(datasetId);
  }

  getDatasetFields(datasetId, enabledOnly = false) {
    return this.database.listDatasetFields(datasetId, { enabledOnly });
  }

  async getDatasetFieldsAsync(datasetId, enabledOnly = false) {
    return (this.database.isInMemory ? false : this.database.listDatasetFieldsAsync)
      ? this.database.listDatasetFieldsAsync(datasetId, { enabledOnly })
      : this.database.listDatasetFields(datasetId, { enabledOnly });
  }

  // Enable/disable a single field. Disabled fields stay in the metadata table so
  // they can be re-enabled later, but every query/agent path reads fields with
  // enabledOnly: true, so a disabled field becomes unreachable for the agent.
  setFieldEnabled(datasetId, fieldName, enabled) {
    const dataset = this.database.getBusinessDataset(datasetId);
    if (!dataset) {
      throw Object.assign(new Error('dataset not found'), { statusCode: 404 });
    }
    const field = this.database.setDatasetFieldEnabled(dataset.id, fieldName, enabled);
    if (!field) {
      throw Object.assign(
        new Error(`dataset field not found: ${fieldName}`),
        { statusCode: 404 },
      );
    }
    const all = this.database.listDatasetFields(dataset.id);
    return {
      datasetId: dataset.id,
      field,
      summary: {
        total: all.length,
        enabled: all.filter((item) => item.enabled !== false).length,
      },
    };
  }

  async setFieldEnabledAsync(datasetId, fieldName, enabled) {
    const dataset = await this.getDatasetAsync(datasetId);
    if (!dataset) throw Object.assign(new Error('dataset not found'), { statusCode: 404 });
    const field = await this.database.setDatasetFieldEnabledAsync(dataset.id, fieldName, enabled);
    if (!field) throw Object.assign(new Error(`dataset field not found: ${fieldName}`), { statusCode: 404 });
    const all = await this.getDatasetFieldsAsync(dataset.id);
    return { datasetId: dataset.id, field, summary: { total: all.length, enabled: all.filter((item) => item.enabled !== false).length } };
  }

  saveDataSource(payload, id = null) {
    const encryptedPassword = payload.password ? this.crypto.encrypt(payload.password) : payload.encryptedPassword;
    const current = id ? this.database.getDataSource(id) : null;
    const code = String(payload.code ?? '').trim() || current?.code || this.nextSourceCode(payload.name);
    const source = this.database.saveDataSource(normalizeDataSource({ ...payload, code, encryptedPassword }), id);
    if (current && current.code !== source.code) this.closePool(current.code);
    this.closePool(source.code);
    return source;
  }

  async saveDataSourceAsync(payload, id = null) {
    const encryptedPassword = payload.password
      ? this.crypto.encrypt(payload.password)
      : payload.encryptedPassword;
    const current = id ? await this.getDataSourceAsync(id) : null;
    const code = String(payload.code ?? '').trim() || current?.code
      || await this.nextSourceCodeAsync(payload.name);
    const source = await this.database.dataSourceRepository.saveDataSourceAsync(
      normalizeDataSource({ ...payload, code, encryptedPassword }), id,
    );
    if (current && current.code !== source.code) this.closePool(current.code);
    this.closePool(source.code);
    return source;
  }

  async nextSourceCodeAsync(name) {
    const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_')
      .slice(0, 40).replace(/^_+|_+$/g, '');
    const codes = new Set((await this.listDataSourcesAsync())
      .map((item) => item.code));
    const base = slug || `ds_${Date.now().toString(36)}`;
    if (!codes.has(base)) return base;
    let suffix = 2;
    while (codes.has(`${base}_${suffix}`)) suffix += 1;
    return `${base}_${suffix}`;
  }

  nextSourceCode(name) {
    const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40).replace(/^_+|_+$/g, '');
    const codes = new Set(this.database.listDataSources().map((item) => item.code));
    const base = slug || `ds_${Date.now().toString(36)}`;
    if (!codes.has(base)) {
      return base;
    }
    let suffix = 2;
    while (codes.has(`${base}_${suffix}`)) {
      suffix += 1;
    }
    return `${base}_${suffix}`;
  }

  async testDataSource(sourceOrId) {
    const source = typeof sourceOrId === 'object'
      ? sourceOrId
      : this.database.getDataSource(sourceOrId);
    if (!source) {
      throw new Error('data source not found');
    }
    let pool;
    try {
      pool = this.createPool(source);
      await pool.query('SELECT 1');
      return this.database.updateDataSourceTest(source.id, {
        ok: true,
        message: '连接成功',
      }, source);
    } catch (error) {
      return this.database.updateDataSourceTest(source.id, {
        ok: false,
        message: error.message,
      }, source);
    } finally {
      await pool?.end().catch(() => {});
    }
  }

  async testDataSourceAsync(sourceOrId) {
    const source = typeof sourceOrId === 'object'
      ? sourceOrId
      : await this.getDataSourceAsync(sourceOrId);
    if (!source) throw new Error('data source not found');
    let pool;
    try {
      pool = this.createPool(source);
      await pool.query('SELECT 1');
      return await this.database.dataSourceRepository.updateDataSourceTestAsync(source.id,
        { ok: true, message: '连接成功' }, source);
    } catch (error) {
      return this.database.dataSourceRepository.updateDataSourceTestAsync(source.id,
        { ok: false, message: error.message }, source);
    } finally {
      await pool?.end().catch(() => {});
    }
  }

  createPool(source) {
    const password = source.encryptedPassword ? this.crypto.decrypt(source.encryptedPassword) : '';
    return getDialect(source.dbType).createPool(source, password);
  }

  getPool(source) {
    return getActivePool(this, source);
  }

  async getPoolAsync(source) {
    // Test/integration adapters may provide a custom pool factory; preserve
    // that seam while production uses the async platform repository path.
    if (this.database.isInMemory || this.getPool !== BusinessDatasetService.prototype.getPool) {
      return this.getPool(source);
    }
    return getActivePoolAsync(this, source);
  }

  closePool(code) {
    const pool = this.pools.get(code);
    if (pool) {
      pool.end().catch(() => {});
      this.pools.delete(code);
    }
  }

  async listDatabases(sourceId) {
    const source = await this.getDataSourceAsync(sourceId);
    const [rows] = await (await this.getPoolAsync(source)).query(getDialect(source.dbType).metadataSql('schemas'));
    return rows.map((row) => Object.values(row)[0]);
  }

  async listTables(sourceId, schemaName) {
    const source = await this.getDataSourceAsync(sourceId);
    const [rows] = await (await this.getPoolAsync(source)).query({
      sql: getDialect(source.dbType).metadataSql('tables'),
      values: [schemaName],
    });
    return rows;
  }

  async listColumns(sourceId, schemaName, tableName) {
    const source = await this.getDataSourceAsync(sourceId);
    const [rows] = await (await this.getPoolAsync(source)).query({
      sql: getDialect(source.dbType).metadataSql('columns'),
      values: [schemaName, tableName],
    });
    return rows;
  }

  async createDataset(payload) {
    const source = await this.getDataSourceAsync(payload.datasourceId);
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
    const dataset = await this.database.saveBusinessDatasetAsync(payload);
    const fields = columns.map(inferField);
    await this.database.replaceDatasetFieldsAsync(dataset.id, fields);
    return this.getDatasetAsync(dataset.id);
  }

  async syncDatasetFields(datasetId) {
    const dataset = await this.getDatasetAsync(datasetId);
    if (!dataset) {
      throw new Error('dataset not found');
    }
    const columns = await this.listColumns(
      dataset.datasourceId,
      dataset.schemaName,
      dataset.primaryTable,
    );
    // Keep explicit disables across a schema re-sync; new columns default to enabled.
    const previousEnabled = new Map(
      (await this.getDatasetFieldsAsync(dataset.id))
        .map((field) => [field.fieldName, field.enabled]),
    );
    return this.database.replaceDatasetFieldsAsync(
      dataset.id,
      columns.map(inferField).map((field) => (
        previousEnabled.get(field.fieldName) === false
          ? { ...field, enabled: false }
          : field
      )),
    );
  }

  async sampleDataset(datasetId, limit = 20) {
    const dataset = await this.getDatasetAsync(datasetId);
    if (!dataset) {
      throw new Error('dataset not found');
    }
    const quoteIdentifier = getDialect(dataset.dbType).quoteIdentifier;
    const fields = await this.getDatasetFieldsAsync(dataset.id, true);
    const selected = fields.slice(0, 20);
    if (selected.length === 0) {
      throw new Error('dataset has no enabled fields');
    }
    const sql = `SELECT ${
      selected.map((field) => quoteIdentifier(field.fieldName)).join(', ')
    } FROM ${quoteIdentifier(dataset.schemaName)}.${quoteIdentifier(dataset.primaryTable)} LIMIT ?`;
    const [rows, fieldPackets] = await (await this.getPoolByIdAsync(dataset.datasourceId)).query({
      sql,
      values: [Math.max(1, Math.min(Number(limit) || 20, 100))],
      timeout: 15_000,
    });
    return {
      columns: fieldPackets.map((field) => field.name),
      rows,
    };
  }

  // Reads all enabled fields (not just the first 20 used by sampleDataset) so
  // the profiler can classify wide tables as well.
  async sampleForProfiling(dataset, fields, limit = 50) {
    const quoteIdentifier = getDialect(dataset.dbType).quoteIdentifier;
    const selected = fields.slice(0, 50);
    if (selected.length === 0) {
      return { columns: [], rows: [] };
    }
    const sql = `SELECT ${
      selected.map((field) => quoteIdentifier(field.fieldName)).join(', ')
    } FROM ${quoteIdentifier(dataset.schemaName)}.${quoteIdentifier(dataset.primaryTable)} LIMIT ?`;
    const [rows, fieldPackets] = await (await this.getPoolByIdAsync(dataset.datasourceId)).query({
      sql,
      values: [Math.max(1, Math.min(Number(limit) || 50, 200))],
      timeout: 15_000,
    });
    return {
      columns: fieldPackets.map((field) => field.name),
      rows,
    };
  }

  // MIN/MAX per date-like column, so the suggested default window is based on
  // the real data span instead of an arbitrary LIMIT sample.
  async listFieldRanges(dataset, fields) {
    const quoteIdentifier = getDialect(dataset.dbType).quoteIdentifier;
    const candidates = fields
      .filter((field) => field.semanticType === 'DATE'
        || /date|time|day|month|year|日期|时间/.test(String(field.fieldName).toLowerCase()))
      .slice(0, 5);
    if (candidates.length === 0) {
      return {};
    }
    const select = candidates.flatMap((field, index) => [
      `MIN(${quoteIdentifier(field.fieldName)}) AS min_${index}`,
      `MAX(${quoteIdentifier(field.fieldName)}) AS max_${index}`,
    ]);
    const [rows] = await (await this.getPoolByIdAsync(dataset.datasourceId)).query({
      sql: `SELECT ${select.join(', ')} FROM ${
        quoteIdentifier(dataset.schemaName)
      }.${quoteIdentifier(dataset.primaryTable)}`,
      timeout: 15_000,
    });
    const ranges = {};
    candidates.forEach((field, index) => {
      ranges[field.fieldName] = {
        min: rows[0]?.[`min_${index}`] ?? null,
        max: rows[0]?.[`max_${index}`] ?? null,
      };
    });
    return ranges;
  }

  // Standalone "intelligent recognition": analyze the dataset and return
  // suggestions only. Nothing is persisted until applyDatasetProfile is called.
  async profileDataset(datasetId, { sampleSize = 50 } = {}) {
    const dataset = await this.getDatasetAsync(datasetId);
    if (!dataset) {
      throw Object.assign(new Error('dataset not found'), { statusCode: 404 });
    }
    const fields = await this.getDatasetFieldsAsync(dataset.id);
    if (fields.length === 0) {
      throw Object.assign(
        new Error('dataset has no fields; sync fields before profiling'),
        { statusCode: 400 },
      );
    }
    // Degraded mode: if the datasource is unreachable (or the platform runs
    // without a database) we still return name/type-based suggestions instead
    // of failing the whole request.
    let sample = { columns: [], rows: [] };
    let degraded = null;
    try {
      sample = await this.sampleForProfiling(dataset, fields, sampleSize);
    } catch (error) {
      degraded = fallbackUnlessDisabled(
        error,
        `未能读取样本数据，已按字段名与类型降级识别：${error.message}`,
      );
    }
    const ranges = degraded
      ? {}
      : await this.listFieldRanges(dataset, fields).catch(error => fallbackUnlessDisabled(error, {}));
    return {
      ...buildDatasetProfile({
        datasetId: dataset.id,
        fields,
        rows: sample.rows ?? [],
        ranges,
        options: { sampleSize: sample.rows?.length ?? 0, degraded },
      }),
      dataset: {
        id: dataset.id,
        name: dataset.name,
        primaryTable: dataset.primaryTable,
        config: dataset.config ?? {},
      },
    };
  }

  // Persists the accepted subset into the config surfaces the existing
  // pipeline already reads: dataset_fields.role/aggregator and
  // business_datasets.config.autoLatestDateRange/autoRangeDays.
  async applyDatasetProfile(datasetId, payload = {}) {
    const dataset = await this.getDatasetAsync(datasetId);
    if (!dataset) {
      throw Object.assign(new Error('dataset not found'), { statusCode: 404 });
    }
    const existing = await this.getDatasetFieldsAsync(dataset.id);
    const selected = normalizeProfileSelection(payload);
    const existingNames = new Set(existing.map((field) => field.fieldName));
    const unknown = selected.fields
      .filter((field) => !existingNames.has(field.fieldName))
      .map((field) => field.fieldName);
    if (unknown.length > 0) {
      throw Object.assign(
        new Error(`unknown dataset fields: ${unknown.join(', ')}`),
        { statusCode: 400 },
      );
    }
    const patchByName = new Map(selected.fields.map((field) => [field.fieldName, field]));
    const merged = existing.map((field) => {
      const patch = patchByName.get(field.fieldName);
      if (!patch) {
        return field;
      }
      return {
        ...field,
        role: patch.role,
        aggregator: patch.aggregator,
        displayName: patch.displayName ?? field.displayName,
        description: patch.description ?? field.description,
      };
    });
    const fields = await this.database.replaceDatasetFieldsAsync(dataset.id, merged);
    let saved = dataset;
    const configPatch = selected.config ?? {};
    if (Object.keys(configPatch).length > 0) {
      saved = await this.database.saveBusinessDatasetAsync({
        ...dataset,
        config: { ...(dataset.config ?? {}), ...configPatch },
      }, dataset.id);
    }
    return {
      dataset: saved,
      fields,
      applied: {
        fieldCount: selected.fields.length,
        config: configPatch,
      },
    };
  }

  async listDistinctFieldValues(datasetId, fieldName, { limit = 200 } = {}) {
    const dataset = await this.getDatasetAsync(datasetId);
    if (!dataset) {
      throw new Error('dataset not found');
    }
    const quoteIdentifier = getDialect(dataset.dbType).quoteIdentifier;
    const field = (await this.getDatasetFieldsAsync(dataset.id, true))
      .find((item) => item.fieldName === fieldName);
    if (!field) {
      throw new Error(`dataset field not found: ${fieldName}`);
    }
    const column = quoteIdentifier(field.fieldName);
    const sql = `SELECT DISTINCT ${column} AS value FROM ${
      quoteIdentifier(dataset.schemaName)
    }.${quoteIdentifier(dataset.primaryTable)} WHERE ${column} IS NOT NULL LIMIT ?`;
    const [rows] = await (await this.getPoolByIdAsync(dataset.datasourceId)).query({
      sql,
      values: [Math.max(1, Math.min(Number(limit) || 200, 500))],
      timeout: 20_000,
    });
    return [...new Set(rows
      .map((row) => String(row?.value ?? '').trim())
      .filter(Boolean))];
  }

  async getPoolByIdAsync(datasourceId) {
    if (this.getPoolById !== BusinessDatasetService.prototype.getPoolById) {
      return this.getPoolById(datasourceId);
    }
    const source = await this.getDataSourceAsync(datasourceId);
    if (!source) throw new Error('data source not found');
    return this.getPoolAsync(source);
  }

  // Compatibility seam for embedded callers; production query paths use the
  // async variant above.
  getPoolById(datasourceId) {
    const source = this.database.getDataSource(datasourceId);
    if (!source) throw new Error('data source not found');
    return this.getPool(source);
  }

  buildQuery(datasetId, request, { probeLimit = false } = {}) {
    const dataset = this.database.getBusinessDataset(datasetId);
    if (!dataset) {
      throw new Error('dataset not found');
    }
    const fields = this.database.listDatasetFields(dataset.id, { enabledOnly: true });
    return this.buildQueryFromMetadata(dataset, fields, request, { probeLimit });
  }

  async buildQueryAsync(datasetId, request, { probeLimit = false } = {}) {
    const dataset = await this.getDatasetAsync(datasetId);
    if (!dataset) {
      throw new Error('dataset not found');
    }
    const fields = await this.getDatasetFieldsAsync(dataset.id, true);
    return this.buildQueryFromMetadata(dataset, fields, request, { probeLimit });
  }

  buildQueryFromMetadata(dataset, fields, request, { probeLimit = false } = {}) {
    const dialect = getDialect(dataset.dbType);
    const quoteIdentifier = dialect.quoteIdentifier;
    const fieldsByName = new Map(fields.map((field) => [field.fieldName, field]));
    const dimensions = [...new Set((request.dimensions ?? []).map(String))]
      .map((name) => fieldsByName.get(name))
      .filter(Boolean);
    const requestedTimeGrain = String(request.timeGrain ?? '').toUpperCase();
    const dimensionSelections = dimensions.map((dimension) => ({
      field: dimension,
      expression: dimension.role === 'TIME' && TIME_GRAINS.has(requestedTimeGrain)
        ? dialect.timeGrainExpr(quoteIdentifier(dimension.fieldName), requestedTimeGrain)
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
      return {
        field,
        aggregator,
        outputField: metricOutputField(item, field.fieldName),
        predicateFilters: normalizeDatasetFilters(
          item?.predicateFilters ?? [],
          fieldsByName,
        ),
      };
    });
    if (metrics.length === 0 && dimensions.length === 0) {
      throw new Error('dataset query requires metrics or dimensions');
    }
    const filters = normalizeDatasetFilters(request.filters, fieldsByName);
    const selectValues = [];
    const selectParts = [];
    for (const dimension of dimensionSelections) {
      selectParts.push(
        `${dimension.expression} AS ${quoteIdentifier(dimension.field.fieldName)}`,
      );
    }
    for (const metric of metrics) {
      const column = quoteIdentifier(metric.field.fieldName);
      let expression;
      if (metric.predicateFilters.length === 0) {
        expression = metric.aggregator === 'COUNT_DISTINCT'
          ? dialect.countDistinct(column)
          : `${metric.aggregator}(${column})`;
      } else {
        const predicateParts = [];
        for (const filter of metric.predicateFilters) {
          appendPredicateFilter(filter, predicateParts, selectValues, quoteIdentifier);
        }
        const predicate = predicateParts.join(' AND ');
        if (metric.aggregator === 'COUNT_DISTINCT') {
          expression = dialect.countDistinct(`CASE WHEN ${predicate} THEN ${column} END`);
        } else if (metric.aggregator === 'COUNT') {
          expression = `COUNT(CASE WHEN ${predicate} THEN 1 END)`;
        } else if (metric.aggregator === 'SUM') {
          expression = `SUM(CASE WHEN ${predicate} THEN ${column} ELSE 0 END)`;
        } else {
          expression = `${metric.aggregator}(CASE WHEN ${predicate} THEN ${column} END)`;
        }
      }
      selectParts.push(`${expression} AS ${quoteIdentifier(metric.outputField)}`);
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
        ? dialect.countDistinct(quoteIdentifier(filter.field.fieldName))
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
          parts.push(filter.operator === 'NOT_IN' ? '1 = 1' : '1 = 0');
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
      const metricSelection = metricSelectionByField.get(field.fieldName);
      const orderExpression = dimensionSelection?.expression
        ?? (field.role === 'TIME' ? groupedTimeDimension?.expression : null)
        ?? (metricSelection ? quoteIdentifier(metricSelection.outputField) : null)
        ?? quoteIdentifier(field.fieldName);
      orderParts.push(
        `${orderExpression} ${String(order.direction).toUpperCase() === 'ASC' ? 'ASC' : 'DESC'}`,
      );
    }
    const orderBy = orderParts.length > 0 ? ` ORDER BY ${orderParts.join(', ')}` : '';
    const having = havingParts.length > 0
      ? ` HAVING ${havingParts.join(' AND ')}`
      : '';
    const maximumLimit = request.analysisPipeline ? 50000 : 10000;
    const probeOffset = probeLimit ? 1 : 0;
    const limit = Math.max(
      1,
      Math.min(
        (Number(request.limit) || 200) + probeOffset,
        maximumLimit + probeOffset,
      ),
    );
    const sql = `SELECT ${selectParts.join(', ')} FROM ${
      quoteIdentifier(dataset.schemaName)
    }.${quoteIdentifier(dataset.primaryTable)}${
      whereParts.length ? ` WHERE ${whereParts.join(' AND ')}` : ''
    }${groupBy}${having}${orderBy} ${dialect.limitClause()}`;
    const values = [...selectValues, ...whereValues, ...havingValues];
    values.push(limit);
    return {
      dataset,
      sql: dialect.prepareSql(sql),
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
    const dataset = await this.getDatasetAsync(datasetId);
    if (!dataset) {
      throw new Error('dataset not found');
    }
    const quoteIdentifier = getDialect(dataset.dbType).quoteIdentifier;
    const fields = await this.getDatasetFieldsAsync(dataset.id, true);
    const effectiveRequest = { ...request };
    if (
      !effectiveRequest.dateRange
      && dataset.config?.autoLatestDateRange !== false
    ) {
      const timeField = fields.find((field) => field.role === 'TIME');
      if (timeField) {
        const [rows] = await (await this.getPoolByIdAsync(dataset.datasourceId)).query({
          sql: `SELECT MAX(${quoteIdentifier(timeField.fieldName)}) AS ${quoteIdentifier('maxDate')} FROM ${
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
    const maximumLimit = effectiveRequest.analysisPipeline ? 50000 : 10000;
    const publicLimit = Math.max(
      1,
      Math.min(Number(effectiveRequest.limit) || 200, maximumLimit),
    );
    // 多取一行只用于判断「是否真的还有下一行」。恰好返回 limit 行时结果
    // 已经完整，不能把它误报成截断并阻断合计/归因。
    const compiled = await this.buildQueryAsync(datasetId, effectiveRequest, { probeLimit: true });
    const startedAt = Date.now();
    try {
      const [probeRows, fieldPackets] = await (await this.getPoolByIdAsync(compiled.dataset.datasourceId)).query({
        sql: compiled.sql,
        values: compiled.values,
        timeout: 20_000,
      });
      const truncated = probeRows.length > publicLimit;
      const rows = truncated ? probeRows.slice(0, publicLimit) : probeRows;
      const latencyMs = Date.now() - startedAt;
      await (this.database.logDatasetQueryAsync
        ? this.database.logDatasetQueryAsync({
        userId,
        sessionId,
        datasetId: compiled.dataset.id,
        sqlText: compiled.sql,
        rowCount: rows.length,
        latencyMs,
        success: true,
          })
        : this.database.logDatasetQuery({
          userId, sessionId, datasetId: compiled.dataset.id, sqlText: compiled.sql,
          rowCount: rows.length, latencyMs, success: true,
        }));
      // 指标列可能被计划重命名为自定义别名（例如 sale_amt -> sale_amt_total），
      // 仅按物理列名回查定义会丢失 METRIC/TIME 语义，导致下游把指标列当成维度，
      // 趋势/对比问题因此退化成纯表格。这里同时按指标输出别名回查定义。
      const definitionByName = new Map(
        fields.map((item) => [item.fieldName, item]),
      );
      const definitionByMetricOutput = new Map();
      for (const metric of compiled.metrics ?? []) {
        if (metric?.outputField && metric?.field) {
          definitionByMetricOutput.set(metric.outputField, metric.field);
        }
      }
      return {
        columns: fieldPackets.map((field) => {
          const definition = definitionByName.get(field.name)
            ?? definitionByMetricOutput.get(field.name)
            ?? null;
          const groupedTimeDimension = Boolean(
            compiled.timeGrain && definition?.role === 'TIME',
          );
          const numeric = definition?.role === 'METRIC'
            || definition?.semanticType === 'NUMBER'
            || /decimal|int|double|float|bigint/i.test(String(field.type));
          return {
            name: definition?.displayName ?? field.name,
            bizName: field.name,
            sourceField: definition?.fieldName ?? field.name,
            sourceLabel: definition?.displayName ?? field.name,
            showType: numeric && !groupedTimeDimension ? 'NUMBER' : 'CATEGORY',
            type: groupedTimeDimension
              ? 'STRING'
              : definition?.dataType ?? String(field.type),
            unit: definition?.unit ?? '',
            role: definition?.role ?? null,
            semanticType: definition?.semanticType ?? null,
          };
        }),
        rows,
        sql: compiled.sql,
        dataset: compiled.dataset,
        dimensions: compiled.dimensions,
        metrics: compiled.metrics,
        filters: compiled.filters,
        limit: publicLimit,
        truncated,
        latencyMs,
      };
    } catch (error) {
      await (this.database.logDatasetQueryAsync
        ? this.database.logDatasetQueryAsync({
        userId,
        sessionId,
        datasetId: compiled.dataset.id,
        sqlText: compiled.sql,
        rowCount: 0,
        latencyMs: Date.now() - startedAt,
        success: false,
        errorMessage: error.message,
          })
        : this.database.logDatasetQuery({
          userId, sessionId, datasetId: compiled.dataset.id, sqlText: compiled.sql,
          rowCount: 0, latencyMs: Date.now() - startedAt, success: false,
          errorMessage: error.message,
        }));
      throw error;
    }
  }

  async bootstrap(config = {}) {
    // 演示数据与「接真实 Doris」互斥：开了 demo 就不再要求 DORIS_BOOTSTRAP_* 连接信息。
    if (config?.demo?.enabled) {
      const { bootstrapDemoDatasets } = await import('./demo/demoBootstrap.js');
      return bootstrapDemoDatasets({
        demo: config.demo,
        businessDatasets: this,
        database: this.database,
      });
    }
    if (!config.enabled || !config.host || !config.username || !config.password) {
      return null;
    }
    let source = await this.database.getDataSourceByCodeAsync('doris_dev');
    if (!source) {
      source = await this.saveDataSourceAsync({
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
        name: '明细数据集',
        description: '按配置接入的明细数据表',
        table: config.salesTable,
        requireDateRange: true,
        autoLatestDateRange: true,
        autoRangeDays: 30,
      },
      {
        code: 'product_master',
        name: '参考数据集',
        description: '按配置接入的参考数据表',
        table: config.goodsTable,
        requireDateRange: false,
        autoLatestDateRange: false,
      },
    ].filter((item) => item.table);
    const created = [];
    for (const definition of datasetDefinitions) {
      let dataset = (await this.database.listBusinessDatasetsAsync({ includeDisabled: true }))
        .find((item) => item.code === definition.code);
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
            policyFieldMap: definition.policyFieldMap ?? {},
            policyValueMap: definition.policyValueMap ?? {},
          },
        });
      } else {
        dataset = await this.database.saveBusinessDatasetAsync({
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

export { inferField, FILTER_OPERATORS };
export { quoteIdentifier } from './scopedMetrics.js';
