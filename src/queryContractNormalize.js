// 查询契约的输入规整：把时间信息、时间窗口、同比计算与后处理配置归一成
// 契约里的稳定结构，并提供字符串去重与排序工具。契约的构建与结果的
// 稳定化见 queryContract.js。

export function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), 'zh-CN', {
    numeric: true,
    sensitivity: 'base',
  });
}

export function uniqueSortedStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))]
    .sort(compareText);
}

export function uniqueStrings(values) {
  return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
}

export function normalizeDateInfo(dateInfo) {
  if (!dateInfo) {
    return {
      dateMode: 'ALL',
      startDate: null,
      endDate: null,
      unit: null,
      period: null,
      dateField: null,
    };
  }
  const dateMode = String(dateInfo.dateMode ?? 'ALL').toUpperCase();
  const period = String(dateInfo.period ?? '').toUpperCase();
  return {
    dateMode,
    startDate: dateInfo.startDate ?? null,
    endDate: dateInfo.endDate ?? null,
    unit: dateMode === 'RECENT' ? Number(dateInfo.unit) || null : null,
    period: dateMode === 'RECENT' && period ? period : null,
    dateField: dateInfo.dateField ?? null,
    label: dateInfo.label ?? dateInfo.detectWord ?? dateInfo.expression ?? null,
    expression: dateInfo.expression ?? dateInfo.detectWord ?? null,
  };
}

export function normalizeTimeWindows(timeWindows) {
  return (timeWindows ?? []).map((window) => normalizeDateInfo(window));
}

export function normalizeCalculation(calculation) {
  return {
    type: String(calculation?.type ?? 'NONE').toUpperCase(),
    baseWindowIndex: Number.isInteger(calculation?.baseWindowIndex)
      ? calculation.baseWindowIndex
      : null,
    compareWindowIndex: Number.isInteger(calculation?.compareWindowIndex)
      ? calculation.compareWindowIndex
      : null,
    description: String(calculation?.description ?? ''),
    timeGrain: ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'].includes(
      String(calculation?.timeGrain ?? '').toUpperCase(),
    )
      ? String(calculation.timeGrain).toUpperCase()
      : null,
  };
}

export function normalizePostProcessing(postProcessing) {
  return postProcessing && typeof postProcessing === 'object'
    ? JSON.parse(JSON.stringify(postProcessing))
    : null;
}
