const GOAL_TYPES = new Set([
  'SUMMARY',
  'DETAIL',
  'BREAKDOWN',
  'COMPOSITION',
  'RANKING',
  'TREND',
  'PERIOD_COMPARISON',
  'ATTRIBUTION',
  'MULTI_STAGE',
]);

function uniqueStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
}

function metricReference(metricFields, requested) {
  const target = String(requested ?? '').trim();
  if (!target) return '';
  const matched = (metricFields ?? []).find((metric) => (
    [metric.outputField, metric.field, metric.requested, metric.matchedAlias]
      .filter(Boolean)
      .some((value) => String(value) === target)
  ));
  return matched?.outputField || matched?.field || '';
}

function dimensionReference(dimensionFields, requested) {
  const target = String(requested ?? '').trim();
  if (!target) return '';
  const matched = (dimensionFields ?? []).find((dimension) => (
    [dimension.field, dimension.requested, dimension.matchedAlias]
      .filter(Boolean)
      .some((value) => String(value) === target)
  ));
  return matched?.field || '';
}

export function normalizeAnalysisGoals(goals = []) {
  return (goals ?? []).map((goal, index) => {
    const type = String(goal?.type ?? '').trim().toUpperCase();
    if (!GOAL_TYPES.has(type)) return null;
    return {
      id: String(goal?.id ?? `goal-${index + 1}`).trim(),
      type,
      measure: String(goal?.measure ?? goal?.metric ?? '').trim(),
      groupBy: uniqueStrings(goal?.groupBy ?? goal?.dimensions),
      outputField: String(goal?.outputField ?? '').trim(),
      label: String(goal?.label ?? goal?.name ?? '').trim(),
      direction: String(goal?.direction ?? 'DESC').trim().toUpperCase() === 'ASC'
        ? 'ASC'
        : 'DESC',
      limit: Number.isFinite(Number(goal?.limit)) ? Number(goal.limit) : null,
      conditionIds: uniqueStrings(goal?.conditionIds),
      ruleSource: String(goal?.ruleSource ?? '').trim(),
    };
  }).filter(Boolean);
}

function goalsFromDerivedMetrics(derivedMetrics, dimensionFields) {
  return (derivedMetrics ?? []).flatMap((metric, index) => {
    if (metric.type !== 'SHARE_OF_TOTAL') return [];
    return [{
      id: `derived-goal-${index + 1}`,
      type: 'COMPOSITION',
      measure: metric.left?.field ?? '',
      groupBy: (dimensionFields ?? [])
        .filter((dimension) => dimension.isTime !== true)
        .map((dimension) => dimension.field),
      outputField: metric.outputField,
      label: metric.name,
      direction: 'DESC',
      limit: null,
      conditionIds: metric.conditionIds ?? [],
      ruleSource: metric.ruleSource ?? '',
    }];
  });
}

export function compileAnalysisGoals({
  goals = [],
  metricFields = [],
  dimensionFields = [],
  derivedMetrics = [],
  issues = [],
} = {}) {
  const normalized = normalizeAnalysisGoals(goals);
  const effectiveGoals = normalized.length > 0
    ? normalized
    : goalsFromDerivedMetrics(derivedMetrics, dimensionFields);
  const compiledGoals = [];
  const compiledDerived = [...(derivedMetrics ?? [])];

  for (const goal of effectiveGoals) {
    const measure = goal.measure
      ? metricReference(metricFields, goal.measure)
      : '';
    const groupBy = goal.groupBy.map((field) => (
      dimensionReference(dimensionFields, field)
    )).filter(Boolean);

    if (goal.measure && !measure) {
      issues.push({
        level: 'ERROR',
        code: 'ANALYSIS_GOAL_MEASURE_UNRESOLVED',
        phase: 'PLAN',
        message: `分析目标 ${goal.id} 引用的度量无法绑定: ${goal.measure}`,
      });
    }
    if (goal.groupBy.length !== groupBy.length) {
      issues.push({
        level: 'ERROR',
        code: 'ANALYSIS_GOAL_GRAIN_UNRESOLVED',
        phase: 'PLAN',
        message: `分析目标 ${goal.id} 的分组粒度未完整绑定: ${goal.groupBy.join('、')}`,
      });
    }
    if (['BREAKDOWN', 'COMPOSITION', 'RANKING'].includes(goal.type) && groupBy.length === 0) {
      issues.push({
        level: 'ERROR',
        code: 'ANALYSIS_GOAL_GRAIN_REQUIRED',
        phase: 'PLAN',
        message: `分析目标 ${goal.id}（${goal.type}）必须绑定至少一个分组维度。`,
      });
    }
    if (goal.type === 'COMPOSITION' && !measure) {
      issues.push({
        level: 'ERROR',
        code: 'ANALYSIS_GOAL_MEASURE_REQUIRED',
        phase: 'PLAN',
        message: `分析目标 ${goal.id}（COMPOSITION）必须绑定一个度量。`,
      });
    }

    const compiled = { ...goal, measure, groupBy };
    compiledGoals.push(compiled);
    if (goal.type !== 'COMPOSITION' || !measure || groupBy.length === 0) continue;

    const existing = compiledDerived.find((metric) => (
      metric.type === 'SHARE_OF_TOTAL'
      && metric.left?.field === measure
    ));
    if (existing) {
      compiled.outputField = existing.outputField;
      continue;
    }
    const outputField = goal.outputField || `${measure}_share`;
    compiled.outputField = outputField;
    compiledDerived.push({
      name: goal.label || '占比',
      type: 'SHARE_OF_TOTAL',
      outputField,
      outputFormat: 'PERCENT',
      precision: 6,
      expression: null,
      operands: [{ field: measure, aggregator: null, source: 'BASE' }],
      left: { field: measure, aggregator: null, source: 'BASE' },
      right: null,
      conditionIds: goal.conditionIds,
      ruleSource: goal.ruleSource || 'analysisGoal:COMPOSITION',
    });
  }

  for (const metric of compiledDerived) {
    if (
      metric.type === 'RATIO'
      && metric.left?.field
      && metric.left.field === metric.right?.field
    ) {
      issues.push({
        level: 'ERROR',
        code: 'RATIO_IDENTICAL_OPERANDS',
        phase: 'PLAN',
        message: '比率的分子和分母不能是同一个结果列；若要计算分组值占总值的比例，请提交 COMPOSITION 分析目标。',
      });
    }
  }

  return {
    goals: compiledGoals,
    derivedMetrics: compiledDerived,
  };
}

export { GOAL_TYPES };
