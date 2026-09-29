import { randomUUID } from 'node:crypto';

function uniqueStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value)).filter(Boolean))];
}

function safeLimit(value) {
  return Math.max(1, Math.min(Number(value) || 200, 2000));
}

function normalizeFilters(filters) {
  return (filters ?? []).map((filter) => ({
    bizName: String(filter.bizName ?? filter.dimension ?? filter.field ?? '').trim(),
    operator: String(filter.operator ?? 'IN').trim().toUpperCase(),
    value: filter.value,
    source: filter.source ?? 'AGENT',
    scope: String(filter.scope ?? 'ROW').trim().toUpperCase() === 'AGGREGATE'
      ? 'AGGREGATE'
      : 'ROW',
  })).filter((filter) => filter.bizName);
}

export class SemanticCompiler {
  compile({
    question,
    indicator,
    metrics,
    dimensions,
    filters,
    dateInfo,
    limit,
    source = 'LLM',
  }) {
    const plan = {
      id: randomUUID(),
      intent: 'METRIC_QUERY',
      question: String(question ?? '').trim(),
      source,
      indicator: {
        id: String(indicator.id),
        name: indicator.name,
        bizName: indicator.bizName ?? '',
      },
      metrics: uniqueStrings(metrics),
      dimensions: uniqueStrings(dimensions),
      agentFilters: normalizeFilters(filters),
      policyFilters: [],
      filters: normalizeFilters(filters),
      dateInfo: dateInfo ?? {
        dateMode: 'RECENT',
        unit: 7,
        period: 'DAY',
      },
      limit: safeLimit(limit),
      execution: {
        adapter: 'supersonic-indicator',
        operation: 'queryIndicator',
        rawSqlAllowed: false,
      },
      createdAt: new Date().toISOString(),
    };
    return plan;
  }

  validate(plan, {
    indicator,
    allowedDimensions,
    scope,
  }) {
    const issues = [];
    const metricCandidates = new Set((indicator.metrics ?? []).flatMap((metric) => [
      metric.metricBizName,
      metric.bizName,
      metric.metricName,
      metric.name,
    ]).filter(Boolean).map(String));
    const dimensionCandidates = new Set((indicator.dimensions ?? []).flatMap((dimension) => [
      dimension.dimensionBizName,
      dimension.bizName,
      dimension.dimensionName,
      dimension.name,
    ]).filter(Boolean).map(String));
    const scopedDimensions = new Set((allowedDimensions ?? []).map(String));
    const scopedDimensionByAlias = new Map();
    for (const dimension of indicator.dimensions ?? []) {
      const canonical = String(
        dimension.dimensionBizName ?? dimension.bizName ?? '',
      );
      for (const alias of [
        dimension.dimensionBizName,
        dimension.bizName,
        dimension.dimensionName,
        dimension.name,
      ].filter(Boolean).map(String)) {
        scopedDimensionByAlias.set(alias, canonical);
      }
    }

    if (!indicator || String(indicator.id) !== String(plan.indicator.id)) {
      issues.push({
        level: 'ERROR',
        code: 'INDICATOR_MISMATCH',
        message: '查询计划中的指标与已校验指标不一致',
      });
    }
    if (
      !scope?.unrestrictedIndicators
      && !scope?.allowedIndicatorIds?.includes(String(plan.indicator.id))
    ) {
      issues.push({
        level: 'ERROR',
        code: 'INDICATOR_NOT_ALLOWED',
        message: '当前用户无权访问计划中的指标',
      });
    }
    if (plan.metrics.length === 0) {
      issues.push({
        level: 'ERROR',
        code: 'METRIC_REQUIRED',
        message: '查询计划未选择任何指标字段',
      });
    }
    for (const metric of plan.metrics) {
      if (!metricCandidates.has(metric)) {
        issues.push({
          level: 'ERROR',
          code: 'METRIC_NOT_FOUND',
          message: `指标字段不在指标定义中: ${metric}`,
        });
      }
    }
    for (const dimension of plan.dimensions) {
      if (!dimensionCandidates.has(dimension)) {
        issues.push({
          level: 'ERROR',
          code: 'DIMENSION_NOT_FOUND',
          message: `维度不在指标定义中: ${dimension}`,
        });
      }
      const scopedDimension = scopedDimensionByAlias.get(dimension) ?? dimension;
      if (scopedDimensions.size > 0 && !scopedDimensions.has(scopedDimension)) {
        issues.push({
          level: 'ERROR',
          code: 'DIMENSION_NOT_ALLOWED',
          message: `当前主题未授权维度: ${dimension}`,
        });
      }
    }
    for (const filter of plan.agentFilters) {
      if (!dimensionCandidates.has(filter.bizName)) {
        issues.push({
          level: 'ERROR',
          code: 'FILTER_FIELD_NOT_FOUND',
          message: `过滤字段不在指标定义中: ${filter.bizName}`,
        });
      }
      const scopedFilter = scopedDimensionByAlias.get(filter.bizName) ?? filter.bizName;
      if (scopedDimensions.size > 0 && !scopedDimensions.has(scopedFilter)) {
        issues.push({
          level: 'ERROR',
          code: 'FILTER_FIELD_NOT_ALLOWED',
          message: `当前主题未授权过滤字段: ${filter.bizName}`,
        });
      }
    }
    for (const policy of scope?.rowPolicies ?? []) {
      if (!dimensionCandidates.has(policy.dimension)) {
        issues.push({
          level: 'WARN',
          code: 'POLICY_DIMENSION_UNAVAILABLE',
          message: `系统行权限字段未出现在指标定义中: ${policy.dimension}`,
        });
      }
    }

    return {
      valid: !issues.some((issue) => issue.level === 'ERROR'),
      issues,
      checkedAt: new Date().toISOString(),
      checks: [
        '指标白名单',
        '指标字段',
        '维度白名单',
        '过滤字段',
        '用户行级权限字段',
      ],
    };
  }

  bindPermissions(plan, scope) {
    const requested = new Map(
      plan.agentFilters.map((filter) => [filter.bizName, filter]),
    );
    const policyFilters = [];
    for (const policy of scope?.rowPolicies ?? []) {
      const filter = {
        bizName: policy.dimension,
        operator: policy.operator,
        value: policy.values,
        source: 'POLICY',
        policyId: policy.id,
      };
      requested.set(policy.dimension, filter);
      policyFilters.push(filter);
    }
    return {
      ...plan,
      policyFilters,
      filters: [...requested.values()],
    };
  }

  compileDatasetQuery({
    question,
    dataset,
    metrics,
    dimensions,
    filters,
    dateRange,
    order,
    limit,
    source = 'LLM',
  }) {
    return {
      id: randomUUID(),
      intent: 'DATASET_QUERY',
      question: String(question ?? '').trim(),
      source,
      dataset: {
        id: Number(dataset.id),
        code: dataset.code,
        name: dataset.name,
        schemaName: dataset.schemaName,
        tableName: dataset.primaryTable,
      },
      metrics: (metrics ?? []).map((metric) => (
        typeof metric === 'string' ? { field: metric } : metric
      )),
      dimensions: uniqueStrings(dimensions),
      agentFilters: normalizeFilters(filters),
      policyFilters: [],
      filters: normalizeFilters(filters),
      dateRange: dateRange ?? null,
      order: order ?? [],
      limit: Math.max(1, Math.min(Number(limit) || 200, 1000)),
      execution: {
        adapter: 'doris-dataset',
        operation: 'queryBusinessDataset',
        rawSqlAllowed: false,
      },
      createdAt: new Date().toISOString(),
    };
  }

  validateDatasetPlan(plan, { fields, scope }) {
    const issues = [];
    const fieldsByName = new Map((fields ?? []).map((field) => [field.fieldName, field]));
    if (!scope?.isAdmin && !scope?.allowedDatasetIds?.includes(String(plan.dataset.id))) {
      issues.push({
        level: 'ERROR',
        code: 'DATASET_NOT_ALLOWED',
        message: '当前用户无权访问计划中的业务数据集',
      });
    }
    if (plan.metrics.length === 0 && plan.dimensions.length === 0) {
      issues.push({
        level: 'ERROR',
        code: 'FIELDS_REQUIRED',
        message: '业务数据集查询至少需要一个指标或维度',
      });
    }
    for (const metric of plan.metrics) {
      const field = fieldsByName.get(metric.field);
      if (!field) {
        issues.push({
          level: 'ERROR',
          code: 'DATASET_METRIC_NOT_FOUND',
          message: `业务数据集指标字段不存在: ${metric.field}`,
        });
      } else if (
        field.role !== 'METRIC'
        && !['COUNT', 'COUNT_DISTINCT'].includes(
          String(metric.aggregator ?? field.aggregator ?? 'SUM').toUpperCase(),
        )
      ) {
        issues.push({
          level: 'ERROR',
          code: 'DATASET_FIELD_NOT_METRIC',
          message: `字段不是指标字段: ${metric.field}`,
        });
      }
    }
    for (const dimension of plan.dimensions) {
      const field = fieldsByName.get(dimension);
      if (!field) {
        issues.push({
          level: 'ERROR',
          code: 'DATASET_DIMENSION_NOT_FOUND',
          message: `业务数据集维度不存在: ${dimension}`,
        });
      } else if (field.role === 'METRIC') {
        issues.push({
          level: 'ERROR',
          code: 'DATASET_FIELD_NOT_DIMENSION',
          message: `指标字段不能作为直接分组维度: ${dimension}`,
        });
      }
    }
    for (const filter of plan.agentFilters) {
      if (!fieldsByName.has(filter.bizName)) {
        issues.push({
          level: 'ERROR',
          code: 'DATASET_FILTER_NOT_FOUND',
          message: `业务数据集过滤字段不存在: ${filter.bizName}`,
        });
      }
    }
    return {
      valid: !issues.some((issue) => issue.level === 'ERROR'),
      issues,
      checkedAt: new Date().toISOString(),
      checks: [
        '数据集授权',
        '指标字段',
        '维度字段',
        '过滤字段',
        '只读查询边界',
      ],
    };
  }

  bindDatasetPermissions(plan, scope, fieldMap = {}, valueMap = {}) {
    const requested = new Map(
      plan.agentFilters.map((filter) => [
        filter.bizName,
        {
          field: filter.bizName,
          operator: filter.operator,
          value: filter.value,
          source: 'AGENT',
        },
      ]),
    );
    const policyFilters = [];
    for (const policy of scope?.rowPolicies ?? []) {
      const targetField = fieldMap[policy.dimension] ?? policy.dimension;
      const mappedValues = policy.values.map(
        (value) => valueMap[targetField]?.[value] ?? value,
      );
      const filter = {
        field: targetField,
        operator: policy.operator,
        value: mappedValues,
        source: 'POLICY',
        policyId: policy.id,
      };
      requested.set(policy.dimension, filter);
      policyFilters.push(filter);
    }
    return {
      ...plan,
      policyFilters,
      filters: [...requested.values()],
    };
  }

  buildDatasetEvidence(plan, result, {
    rowPolicyCount,
    columnPolicyCount,
    generatedSql,
  }) {
    return {
      planId: plan.id,
      indicator: null,
      dataset: plan.dataset,
      metrics: plan.metrics.map((metric) => metric.field),
      dimensions: plan.dimensions,
      filters: plan.filters,
      policyFilters: plan.policyFilters,
      dateInfo: plan.dateRange,
      execution: {
        adapter: 'doris-dataset',
        endpoint: 'Doris SQL SELECT',
        rowCount: result.rows.length,
        columnCount: result.columns.length,
        rawSqlExposed: false,
        generatedSql,
      },
      security: {
        rowPolicyCount,
        columnPolicyCount,
      },
      resultPreview: {
        columns: result.columns,
        rows: result.rows.slice(0, 10),
      },
      rawResultStatus: 'SUCCESS',
      generatedAt: new Date().toISOString(),
    };
  }

  buildDatasetSemanticParse({ plan, validation, evidence, runtime }) {
    return {
      planId: plan.id,
      intent: plan.intent,
      question: plan.question,
      status: validation.valid ? 'VALIDATED' : 'REJECTED',
      sourceType: 'BUSINESS_DATASET',
      matchedDataset: plan.dataset,
      metrics: plan.metrics.map((metric) => metric.field),
      dimensions: plan.dimensions,
      filters: plan.filters.map((filter) => ({
        ...filter,
        origin: filter.source === 'POLICY' ? '系统权限' : '用户问题',
      })),
      dateInfo: plan.dateRange,
      validation,
      execution: evidence.execution,
      security: evidence.security,
      runtime,
      evidence: [
        {
          label: '业务数据集',
          value: `${plan.dataset.name} (${plan.dataset.schemaName}.${plan.dataset.tableName})`,
        },
        {
          label: '指标字段',
          value: plan.metrics.map((metric) => metric.field).join(', ') || '无',
        },
        {
          label: '分析维度',
          value: plan.dimensions.join(', ') || '汇总',
        },
        {
          label: '执行适配器',
          value: evidence.execution.adapter,
        },
        {
          label: '返回结果',
          value: `${evidence.execution.rowCount} 行 / ${evidence.execution.columnCount} 列`,
        },
      ],
    };
  }

  buildEvidence(plan, {
    indicator,
    rawResult,
    secureResult,
    rowPolicyCount,
    columnPolicyCount,
  }) {
    const rows = secureResult?.rows ?? [];
    const columns = secureResult?.columns ?? [];
    return {
      planId: plan.id,
      indicator: {
        id: plan.indicator.id,
        name: indicator.name,
      },
      metrics: plan.metrics,
      dimensions: plan.dimensions,
      filters: plan.filters,
      policyFilters: plan.policyFilters,
      dateInfo: plan.dateInfo,
      execution: {
        adapter: 'supersonic-indicator',
        endpoint: '/api/semantic/query/metric',
        rowCount: rows.length,
        columnCount: columns.length,
        rawSqlExposed: false,
      },
      security: {
        rowPolicyCount,
        columnPolicyCount,
      },
      resultPreview: {
        columns: columns.slice(0, 20),
        rows: rows.slice(0, 10),
      },
      rawResultStatus: rawResult?.errorMsg ? 'ERROR' : 'SUCCESS',
      generatedAt: new Date().toISOString(),
    };
  }

  buildSemanticParse({ plan, validation, evidence, runtime }) {
    return {
      planId: plan.id,
      intent: plan.intent,
      question: plan.question,
      status: validation.valid ? 'VALIDATED' : 'REJECTED',
      matchedIndicator: evidence.indicator,
      metrics: plan.metrics,
      dimensions: plan.dimensions,
      filters: plan.filters.map((filter) => ({
        ...filter,
        origin: filter.source === 'POLICY' ? '系统权限' : '用户问题',
      })),
      dateInfo: plan.dateInfo,
      validation,
      execution: evidence.execution,
      security: evidence.security,
      runtime,
      evidence: [
        { label: '指标', value: `${evidence.indicator.name} (${evidence.indicator.id})` },
        { label: '指标字段', value: plan.metrics.join(', ') },
        { label: '分析维度', value: plan.dimensions.join(', ') || '汇总' },
        {
          label: '时间范围',
          value: JSON.stringify(plan.dateInfo),
        },
        {
          label: '执行适配器',
          value: evidence.execution.adapter,
        },
        {
          label: '返回结果',
          value: `${evidence.execution.rowCount} 行 / ${evidence.execution.columnCount} 列`,
        },
      ],
    };
  }
}
