import { columnKey, columnLabel, formatValue, resolveMetric, resolveBreakdownDimension, temporalPeriods, formatTemporalPeriod } from './naturalAnswerColumns.js';

const RANKING_PATTERN = /排名|排行|榜单|最高|最低|最多|最少|top\s*\d*|前\s*\d+/i;
const FULL_BREAKDOWN_LIMIT = 15;
function sentence(text) {
  const value = String(text ?? '').trim();
  return value && !/[。！？]$/.test(value) ? `${value}。` : value;
}

function emphasizeFirstNumber(text) {
  return String(text ?? '').replace(/(\d[\d,.]*(?:\.\d+)?%?)/, '**$1**');
}

function composeBreakdown({ question, rows, columns, contract }) {
  const metricColumn = resolveMetric(columns, contract);
  const dimension = resolveBreakdownDimension(columns, contract);
  if (!metricColumn || !dimension || rows.length < 2) {
    return '';
  }
  const metricKey = columnKey(metricColumn);
  const dimensionKey = columnKey(dimension);
  const sorted = [...rows]
    .filter((row) => Number.isFinite(Number(row?.[metricKey])))
    .sort((left, right) => (
      /最低|最少/.test(String(question ?? ''))
        ? Number(left[metricKey]) - Number(right[metricKey])
        : Number(right[metricKey]) - Number(left[metricKey])
    ));
  if (sorted.length < 2) {
    return '';
  }
  const metricLabel = columnLabel(metricColumn) || metricKey;
  const dimensionLabel = columnLabel(dimension) || dimensionKey;
  const render = (row) => `**${String(row?.[dimensionKey] ?? '')}** ${formatValue(row?.[metricKey], metricColumn)}`;
  if (RANKING_PATTERN.test(String(question ?? ''))) {
    const [first, second] = sorted;
    const direction = /最低|最少/.test(String(question ?? '')) ? '最低' : '最高';
    return `**${String(first?.[dimensionKey] ?? '')}**的${metricLabel}${direction}，为 **${formatValue(
      first?.[metricKey],
      metricColumn,
    )}**${second ? `；**${String(second?.[dimensionKey] ?? '')}**次之，为 **${formatValue(
      second?.[metricKey],
      metricColumn,
    )}**` : ''}。`;
  }
  const top = sorted.slice(0, sorted.length <= FULL_BREAKDOWN_LIMIT ? sorted.length : 3);
  const rest = sorted.slice(top.length);
  const restText = rest.length > 0
    ? `，其余 ${rest.length} 个${dimensionLabel}合计 **${formatValue(
      rest.reduce((sum, row) => sum + Number(row[metricKey]), 0),
      metricColumn,
    )}**`
    : '';
  return `按${dimensionLabel}看，${metricLabel}分别为${top.map(render).join('、')}${restText}。`;
}

function composeComparison({ comparisons, analysisLines, movementLines }) {
  if (comparisons.length === 0) {
    return '';
  }
  const statements = comparisons.map((item) => sentence(item.statement));
  const details = comparisons.flatMap((item) => item.details ?? []).map(sentence);
  const decomposition = analysisLines.length > 0 ? analysisLines : movementLines;
  // 同一维度在多指标比较时可能产生完全相同的解释句。保留一次即可，
  // 避免回答像把同一段分析复制了两遍。
  return [...new Set([...statements, ...details, ...decomposition].filter(Boolean))]
    .join('\n');
}

export function composeNaturalAnswer({
  question = '',
  columns = [],
  rows = [],
  contract = null,
  totals = [],
  comparisons = [],
  analysisLines = [],
  movementLines = [],
  trend = '',
  vocabularyResolver = null,
}) {
  if (rows.length === 0) {
    return '按当前条件未返回数据，也没有自动调整时间范围或指标。';
  }
  const comparisonText = composeComparison({ comparisons, analysisLines, movementLines });
  if (comparisonText) {
    return comparisonText;
  }
  if (analysisLines.length > 0) {
    return analysisLines.map(sentence).join('\n');
  }
  const vocabulary = vocabularyResolver?.({ question }) ?? {};
  const wantsTrend = vocabulary.trend || /趋势|走势|变化/.test(String(question ?? ''))
    || Boolean(contract?.timeGrain);
  if (wantsTrend && trend) {
    return [
      totals.length > 0 ? `${totals.join('；')}。` : '',
      sentence(trend),
    ].filter(Boolean).join('\n');
  }
  const naturalQuestion = vocabulary.ranking || vocabulary.direction === 'ASC'
    ? `${question} ${vocabulary.ranking ? '排名' : ''} ${vocabulary.direction === 'ASC' ? '最低' : ''}`
    : question;
  const breakdown = composeBreakdown({
    question: naturalQuestion,
    rows,
    columns,
    contract,
  });
  if (breakdown) {
    const periods = temporalPeriods(columns, rows, contract);
    if (wantsTrend && periods.length === 1) {
      const grain = String(contract?.timeGrain ?? '').toUpperCase();
      const grainLabel = grain === 'MONTH'
        ? '月'
        : grain === 'QUARTER'
          ? '季度'
          : grain === 'YEAR'
            ? '年'
            : '期';
      return `当前结果只覆盖 ${formatTemporalPeriod(periods[0], grain)} 一个${grainLabel}，无法形成跨${grainLabel}趋势；以下先给出该时间范围内的结构。\n${breakdown}`;
    }
    return breakdown;
  }
  if (totals.length > 0) {
    return `${emphasizeFirstNumber(totals.join('；'))}。`;
  }
  if (movementLines.length > 0) {
    return movementLines.map(sentence).join('\n');
  }
  return `共查到 ${rows.length} 行，明细见下方。`;
}
