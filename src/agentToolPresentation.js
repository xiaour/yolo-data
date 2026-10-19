// Presentation of auditable tool events; independent of orchestration and storage.
export function toolStageCode(name) {
  switch (name) {
    case 'search_indicators':
    case 'list_business_datasets':
      return 'SEMANTIC_DISCOVERY';
    case 'get_indicator':
    case 'get_business_dataset_definition':
      return 'SEMANTIC_CONFIRM';
    case 'compile_query_contract':
      return 'PLAN';
    case 'query_indicator':
    case 'query_business_dataset':
    case 'execute_query_contract':
      return 'EXECUTE';
    case 'execute_analysis_code':
      return 'CODE';
    case 'list_workspace_artifacts':
    case 'transform_workspace_artifact':
      return 'ANALYZE';
    default:
      return 'EXECUTE';
  }
}

function compactReviewValue(value, limit = 800) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const text = typeof value === 'string'
    ? value
    : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function formatReviewDuration(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) {
    return '';
  }
  if (milliseconds < 1000) {
    return `${Math.max(0, Math.round(milliseconds))} ms`;
  }
  return `${(milliseconds / 1000).toFixed(2)} 秒`;
}

export function buildToolReview(name, args = {}, result = {}) {
  const facts = [];
  const addFact = (label, value) => {
    const text = compactReviewValue(value);
    if (text) {
      facts.push({ label, value: text });
    }
  };
  if (name === 'search_indicators') {
    addFact('检索词', args.keyword);
    addFact('命中', `${result.indicators?.length ?? 0} 个指标`);
  } else if (name === 'get_indicator') {
    addFact('指标', result.name);
    addFact('业务口径', result.businessCaliber);
    addFact('字段', `${result.metrics?.length ?? 0} 个指标 / ${result.dimensions?.length ?? 0} 个维度`);
    addFact(
      '默认值域',
      `${(result.dimensions ?? []).filter((item) => (item.values ?? []).length > 0).length} 个字段已初始化`,
    );
  } else if (name === 'list_business_datasets') {
    addFact('数据集', `${result.datasets?.length ?? 0} 个`);
    addFact('名称', (result.datasets ?? []).map((item) => item.name).join('、'));
  } else if (name === 'get_business_dataset_definition') {
    addFact('数据集', result.dataset?.name);
    addFact('字段', `${result.fields?.length ?? 0} 个`);
    addFact(
      '默认值域',
      `${(result.fields ?? []).filter((item) => (item.values ?? []).length > 0).length} 个字段已初始化`,
    );
  } else if (name === 'compile_query_contract') {
    addFact('契约', result.contractId ?? args.contractId);
    addFact('条件', `${args.conditions?.length ?? 0} 条`);
    addFact('指标', (args.metricFields ?? []).map((item) => item.field).join('、'));
    addFact('维度', (args.dimensionFields ?? []).map((item) => item.field).join('、'));
    addFact('过滤', `${args.filterFields?.length ?? 0} 条`);
    addFact('时间窗口', `${args.timeWindows?.length ?? 0} 个`);
    addFact('计算', args.calculation?.type ?? 'NONE');
    if (args.postProcessing) {
      const parts = [];
      if (args.postProcessing.groupValues) {
        parts.push(`值归并 ${args.postProcessing.groupValues.groups?.length ?? 0} 组`);
      }
      if (args.postProcessing.periodComparison) {
        parts.push(`同期计算 ${args.postProcessing.periodComparison.type}`);
      }
      if (args.postProcessing.pivot) {
        parts.push('透视输出');
      }
      addFact('后处理', parts.join(' / '));
    }
    if (args.analysisPipeline?.stages?.length) {
      addFact(
        '分析管线',
        `${args.analysisPipeline.stages.length} 个通用阶段：${
          args.analysisPipeline.stages.map((stage) => stage.type).join(' > ')
        }`,
      );
    }
  } else if (
    name === 'query_indicator'
    || name === 'query_business_dataset'
    || name === 'execute_query_contract'
  ) {
    addFact('数据源', result.dataset?.name ?? result.indicator?.name ?? args.indicatorId ?? args.datasetId);
    addFact('结果', `${result.rowCount ?? 0} 行 / ${result.columns?.length ?? 0} 列`);
    addFact('查询指纹', result.queryFingerprint);
  } else if (name === 'list_workspace_artifacts') {
    addFact('产物', `${result.artifacts?.length ?? 0} 个`);
    addFact('文件', (result.artifacts ?? []).map((item) => item.title).join('、'));
  } else if (name === 'transform_workspace_artifact') {
    addFact('操作', args.operation);
    addFact('结果', `${result.rowCount ?? 0} 行 / v${result.version ?? '-'}`);
  } else if (name === 'execute_analysis_code') {
    addFact('目的', args.purpose);
    addFact('运行', result.success ? '成功' : '失败');
    addFact('耗时', formatReviewDuration(result.durationMs));
    addFact('输入产物', `${result.inputArtifacts?.length ?? 0} 个`);
    addFact('输出文件', (result.outputs ?? []).map((item) => item.fileName).join('、'));
  }

  const details = {};
  if (name === 'compile_query_contract') {
    details.conditions = args.conditions ?? [];
    details.calculation = args.calculation ?? null;
    details.postProcessing = args.postProcessing ?? null;
    details.analysisPipeline = args.analysisPipeline ?? null;
  } else if (
    name === 'query_indicator'
    || name === 'query_business_dataset'
    || name === 'execute_query_contract'
  ) {
    details.contractId = args.contractId ?? null;
    details.columns = (result.columns ?? []).map((column) => column.name ?? column.bizName);
    details.rowCount = result.rowCount ?? 0;
    details.queryFingerprint = result.queryFingerprint ?? null;
  } else if (name === 'list_workspace_artifacts') {
    details.artifacts = (result.artifacts ?? []).map((item) => ({
      id: item.id,
      title: item.title,
      type: item.artifactType,
      columns: (item.columns ?? []).map((column) => column.name),
    }));
  } else if (name === 'execute_analysis_code') {
    details.runId = result.runId;
    details.inputArtifacts = result.inputArtifacts ?? [];
    details.outputs = result.outputs ?? [];
  }
  return {
    facts,
    details: Object.keys(details).length > 0 ? details : null,
    code: name === 'execute_analysis_code' ? String(args.code ?? '') : '',
    stdout: name === 'execute_analysis_code' ? String(result.stdout ?? '') : '',
    stderr: name === 'execute_analysis_code' ? String(result.stderr ?? '') : '',
  };
}

export function describeToolStep(name, args, result) {
  if (name === 'search_indicators') {
    const count = result?.indicators?.length ?? 0;
    return {
      title: '检索主题指标',
      detail: `关键词：${args.keyword || '当前问题'}，命中 ${count} 个可用指标`,
    };
  }
  if (name === 'get_indicator') {
    const valueDomainCount = (result?.dimensions ?? [])
      .filter((dimension) => (dimension.values ?? []).length > 0).length;
    return {
      title: '确认指标口径与默认值域',
      detail: `${result?.name ?? args.indicatorId}，${
        result?.metrics?.length ?? 0
      } 个指标字段，${result?.dimensions?.length ?? 0} 个可用维度，${
        valueDomainCount
      } 个字段完成默认值域初始化`,
    };
  }
  if (name === 'compile_query_contract') {
    return {
      title: result?.valid ? '编译查询契约' : '查询契约待修正',
      detail: result?.valid
        ? `契约 ${result.contractId.slice(0, 12)} 已通过，覆盖 ${
          result.coverage?.length ?? 0
        } 个问题片段`
        : (result?.issues ?? []).map((issue) => issue.message).join('；')
          || '契约未通过',
    };
  }
  if (name === 'execute_query_contract') {
    return {
      title: '执行查询契约',
      detail: `${result?.indicator?.name ?? result?.dataset?.name ?? args.contractId}，返回 ${
        result?.rowCount ?? 0
      } 行`,
    };
  }
  if (name === 'list_business_datasets') {
    return {
      title: '检索业务数据集',
      detail: `发现 ${result?.datasets?.length ?? 0} 个可访问业务数据集`,
    };
  }
  if (name === 'get_business_dataset_definition') {
    const valueDomainCount = (result?.fields ?? [])
      .filter((field) => (field.values ?? []).length > 0).length;
    return {
      title: '确认业务字段与默认值域',
      detail: `${result?.dataset?.name ?? args.datasetId}，确认 ${
        result?.fields?.length ?? 0
      } 个字段，${valueDomainCount} 个字段完成默认值域初始化`,
    };
  }
  if (name === 'query_business_dataset') {
    return {
      title: '执行业务数据集查询',
      detail: `${result?.dataset?.name ?? args.datasetId}，按 ${
        result?.dimensions?.join('、') || '汇总'
      } 分析，返回 ${result?.rowCount ?? 0} 行`,
    };
  }
  if (name === 'query_indicator') {
    const dimensions = result?.dimensions?.length
      ? result.dimensions.join('、')
      : '汇总';
    const filters = result?.filters?.length
      ? `，过滤 ${result.filters.map((filter) => (
        `${filter.bizName} ${filter.operator} ${JSON.stringify(filter.value)}`
      )).join('；')}`
      : '';
    return {
      title: '执行指标查询',
      detail: `${result?.indicator?.name ?? args.indicatorId}，按${dimensions}分析${filters}，返回 ${
        result?.rowCount ?? 0
      } 行`,
    };
  }
  if (name === 'execute_analysis_code') {
    return {
      title: '生成并执行分析代码',
      detail: `${args.purpose || '复杂数据处理'}，${
        result?.success ? '执行成功' : '执行失败'
      }，生成 ${result?.outputs?.length ?? 0} 个文件产物`,
    };
  }
  return {
    title: name,
    detail: JSON.stringify(args),
  };
}
