const TIME_ZONE = 'Asia/Shanghai';
const TO_DATE_ENDING_PATTERN =
  '(?:至今|至今天|至今日|至昨天|至昨日|截至今天|截至今日|截至昨天|截至昨日|截止到今天|截止到今日|截止到昨天|截止到昨日|截至目前|到现在|以来|累计)';

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function normalizeYear(value) {
  const year = Number(value);
  if (!Number.isFinite(year)) {
    return null;
  }
  if (String(value).length <= 2) {
    return year >= 70 ? 1900 + year : 2000 + year;
  }
  return year;
}

function parseDateOnly(value) {
  const text = String(value ?? '').trim();
  const match = text.match(
    /^(\d{2}|\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2})日?)?$/,
  );
  if (!match) {
    return null;
  }
  const year = normalizeYear(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3] ?? 1);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return formatDate(date);
}

function todayInTimeZone(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

function startOfMonth(value, monthOffset = 0) {
  const date = new Date(`${value}T00:00:00Z`);
  return formatDate(new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + monthOffset,
    1,
  )));
}

function endOfMonth(value, monthOffset = 0) {
  return shiftDays(startOfMonth(value, monthOffset + 1), -1);
}

function startOfQuarter(value, quarterOffset = 0) {
  const date = new Date(`${value}T00:00:00Z`);
  const quarterStartMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return formatDate(new Date(Date.UTC(
    date.getUTCFullYear(),
    quarterStartMonth + quarterOffset * 3,
    1,
  )));
}

function endOfQuarter(value, quarterOffset = 0) {
  return shiftDays(startOfQuarter(value, quarterOffset + 1), -1);
}

function shiftMonthKeepingDay(value, monthOffset) {
  const date = new Date(`${value}T00:00:00Z`);
  const targetMonth = date.getUTCMonth() + monthOffset;
  const targetYear = date.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return formatDate(new Date(Date.UTC(
    targetYear,
    normalizedMonth,
    Math.min(date.getUTCDate(), lastDay),
  )));
}

function startOfWeek(value) {
  const date = new Date(`${value}T00:00:00Z`);
  const weekday = date.getUTCDay() || 7;
  return shiftDays(value, 1 - weekday);
}

function parseCountToken(value) {
  const text = String(value ?? '').trim();
  if (/^\d+$/.test(text)) {
    return Number(text);
  }
  const digits = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (text === '十') {
    return 10;
  }
  if (text === '半') {
    return 0.5;
  }
  if (text.includes('十')) {
    const [tens, ones] = text.split('十');
    const tensValue = tens ? digits[tens] : 1;
    const onesValue = ones ? digits[ones] : 0;
    return Number.isFinite(tensValue) && Number.isFinite(onesValue)
      ? tensValue * 10 + onesValue
      : null;
  }
  return digits[text] ?? null;
}

function parseCalendarToDate(question, now) {
  const text = String(question ?? '');
  const businessEnd = shiftDays(todayInTimeZone(now), -1);
  const definitions = [
    {
      pattern: new RegExp(
        `(?<![\\d年月])(?:本|这个|当)?月(?:初|1日|1号|一号|一日)?(?:起)?${TO_DATE_ENDING_PATTERN}`,
      ),
      start: () => startOfMonth(businessEnd),
    },
    {
      pattern: new RegExp(
        `(?<![\\d周星期])(?:本|这|当)?(?:周|星期)(?:初)?(?:起)?${TO_DATE_ENDING_PATTERN}`,
      ),
      start: () => startOfWeek(businessEnd),
    },
    {
      pattern: new RegExp(
        `(?<![\\d季度])(?:本|这|当)?(?:季度|季)(?:初)?(?:起)?${TO_DATE_ENDING_PATTERN}`,
      ),
      start: () => startOfQuarter(businessEnd),
    },
    {
      pattern: new RegExp(
        `(?<!\\d)(?:本|今|当)?(?:年|年度)(?:初)?(?:起)?${TO_DATE_ENDING_PATTERN}`,
      ),
      start: () => `${businessEnd.slice(0, 4)}-01-01`,
    },
  ];
  for (const definition of definitions) {
    const match = text.match(definition.pattern);
    if (match) {
      return range(definition.start(), businessEnd, match[0]);
    }
  }
  return null;
}

function parseExplicitDateToDate(question, now) {
  const match = String(question ?? '').match(
    new RegExp(
      `(?:自|从)?\\s*((?:\\d{2,4}年)?\\d{1,2}月\\d{1,2}[日号]?)\\s*(?:起)?\\s*${TO_DATE_ENDING_PATTERN}`,
    ),
  );
  if (!match) {
    return null;
  }
  const currentYear = todayInTimeZone(now).slice(0, 4);
  const source = /\d{2,4}年/.test(match[1])
    ? match[1]
    : `${currentYear}-${match[1]}`;
  const start = parseDateOnly(source);
  if (!start) {
    return null;
  }
  return range(start, shiftDays(todayInTimeZone(now), -1), match[0].trim());
}

function range(startDate, endDate, expression, anchor = 'BUSINESS_T_MINUS_1') {
  return {
    dateMode: 'BETWEEN',
    startDate,
    endDate,
    unit: null,
    period: null,
    dateList: [],
    detectWord: expression,
    expression,
    anchor,
  };
}

function parseExplicitDateRange(question) {
  const datePattern = String.raw`\d{2,4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?`;
  const match = question.match(new RegExp(
    `(${datePattern})\\s*(?:到|至|~|—|－)\\s*(${datePattern})`,
  ));
  if (!match) {
    return null;
  }
  const startDate = parseDateOnly(match[1]);
  const endDate = parseDateOnly(match[2]);
  if (!startDate || !endDate) {
    return null;
  }
  return range(startDate, endDate, match[0], 'EXPLICIT');
}

function parsePartiallyQualifiedDateRange(question) {
  const match = question.match(
    /(\d{2}|\d{4})年(\d{1,2})月(\d{1,2})[日号]?\s*(?:到|至|~|—|－|-)\s*(?!\d{2,4}年)(?:(\d{1,2})月)?(\d{1,2})[日号]?/,
  );
  if (!match) {
    return null;
  }
  const year = normalizeYear(match[1]);
  const startMonth = Number(match[2]);
  const startDay = Number(match[3]);
  const endMonth = Number(match[4] ?? startMonth);
  const endDay = Number(match[5]);
  const start = parseDateOnly(`${year}-${startMonth}-${startDay}`);
  const end = parseDateOnly(`${year}-${endMonth}-${endDay}`);
  if (!start || !end) {
    return null;
  }
  return range(start, end, match[0], 'EXPLICIT');
}

function parseYearMonthRange(question) {
  const match = question.match(
    /(\d{2}|\d{4})年(\d{1,2})月?\s*(?:到|至|~|—|－|-)\s*(?:(\d{2}|\d{4})年)?(\d{1,2})月?/,
  );
  if (!match) {
    return null;
  }
  const startYear = normalizeYear(match[1]);
  const startMonth = Number(match[2]);
  const endYear = normalizeYear(match[3] ?? match[1]);
  const endMonth = Number(match[4]);
  const start = parseDateOnly(`${startYear}-${startMonth}-01`);
  const endStart = parseDateOnly(`${endYear}-${endMonth}-01`);
  if (!start || !endStart) {
    return null;
  }
  return range(start, endOfMonth(endStart), match[0], 'EXPLICIT');
}

function parseExplicitMonthRange(question) {
  const match = question.match(
    /(\d{2}|\d{4})年(\d{1,2})月?\s*(?:到|至|~|—|－|-)\s*(?:(\d{2}|\d{4})年)?(\d{1,2})月/,
  );
  if (!match) {
    return null;
  }
  const startYear = normalizeYear(match[1]);
  const startMonth = Number(match[2]);
  const endYear = normalizeYear(match[3] ?? match[1]);
  const endMonth = Number(match[4]);
  const start = parseDateOnly(`${startYear}-${startMonth}-01`);
  const endStart = parseDateOnly(`${endYear}-${endMonth}-01`);
  if (!start || !endStart) {
    return null;
  }
  return range(start, endOfMonth(endStart), match[0], 'EXPLICIT');
}

function parseExplicitMonth(question, now = new Date()) {
  const compact = question.match(/(?<!\d)(\d{2}|\d{4})(\d{2})月/);
  const yearMonth = question.match(/(\d{2}|\d{4})[-/.年](\d{1,2})月/);
  const bareMonth = question.match(
    /(?<!\d)(\d{1,2})月份?(?!\s*(?:\d|[~～到至—－-]))/,
  );
  const businessEnd = shiftDays(todayInTimeZone(now), -1);
  const match = compact
    ? { expression: compact[0], year: compact[1], month: compact[2] }
    : yearMonth
      ? {
        expression: yearMonth[0],
        year: yearMonth[1],
        month: yearMonth[2],
      }
      : bareMonth
        ? {
          expression: bareMonth[0],
          year: businessEnd.slice(0, 4),
          month: bareMonth[1],
        }
        : null;
  if (!match || /日/.test(match.expression)) {
    return null;
  }
  const year = normalizeYear(match.year);
  const month = Number(match.month);
  const monthStart = parseDateOnly(`${year}-${month}-01`);
  if (!monthStart) {
    return null;
  }
  const endDate = year === Number(businessEnd.slice(0, 4))
    && month === Number(businessEnd.slice(5, 7))
    ? businessEnd
    : endOfMonth(monthStart);
  return range(
    monthStart,
    endDate,
    match.expression,
    'EXPLICIT',
  );
}

function parseExplicitYear(question, now = new Date()) {
  const match = String(question ?? '').match(
    /(?<!\d)(\d{2,4})年(?!\s*(?:\d{1,2}(?:月|[日号])?|上半年|下半年|Q[1-4]))/i,
  );
  if (!match) {
    return null;
  }
  const year = normalizeYear(match[1]);
  const businessEnd = shiftDays(todayInTimeZone(now), -1);
  if (year === Number(businessEnd.slice(0, 4))) {
    return range(`${year}-01-01`, businessEnd, `${year}年至今`);
  }
  return range(`${year}-01-01`, `${year}-12-31`, `${year}年`);
}

export function buildPreviousAlignedWindow(window) {
  if (!window?.startDate || !window?.endDate) {
    return null;
  }
  const start = new Date(`${window.startDate}T00:00:00Z`);
  const end = new Date(`${window.endDate}T00:00:00Z`);
  const sameMonth = window.startDate.slice(0, 7) === window.endDate.slice(0, 7);
  const days = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
  if (!Number.isFinite(days) || days <= 0) {
    return null;
  }
  const previousEnd = sameMonth
    ? shiftMonthKeepingDay(window.endDate, -1)
    : shiftDays(window.startDate, -1);
  const previousStart = sameMonth
    ? shiftMonthKeepingDay(window.startDate, -1)
    : shiftDays(previousEnd, -(days - 1));
  return {
    ...window,
    id: `${window.id ?? 'window'}-previous`,
    label: `${window.label || window.sourceText || '本期'}对比期`,
    expression: `${window.expression || window.sourceText || '本期'}对比期`,
    startDate: previousStart,
    endDate: previousEnd,
    ruleSource: window.ruleSource || '平台按同期天数等长对齐',
    derived: true,
  };
}

function parseExplicitDay(question) {
  const match = question.match(/\d{2,4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/);
  if (!match) {
    return null;
  }
  const date = parseDateOnly(match[0]);
  return date ? range(date, date, match[0], 'EXPLICIT') : null;
}

function parseYearlessDateRange(question, now) {
  const match = question.match(
    /(\d{1,2})月(\d{1,2})[日号]?\s*(?:到|至|~|—|－|-)\s*(?:(\d{1,2})月)?(\d{1,2})[日号]?/,
  );
  if (!match) {
    return null;
  }
  const year = Number(todayInTimeZone(now).slice(0, 4));
  const startMonth = Number(match[1]);
  const startDay = Number(match[2]);
  const endMonth = Number(match[3] ?? match[1]);
  const endDay = Number(match[4]);
  const start = parseDateOnly(`${year}-${startMonth}-${startDay}`);
  const end = parseDateOnly(`${year}-${endMonth}-${endDay}`);
  if (!start || !end) {
    return null;
  }
  return range(start, end, match[0], 'EXPLICIT');
}

function parseMonthToDate(question, now) {
  const text = String(question ?? '');
  const yearMonth = text.match(
    new RegExp(
      `(\\d{2,4})年(\\d{1,2})月(?:(\\d{1,2})[日号]?)?\\s*(?:起)?\\s*${TO_DATE_ENDING_PATTERN}`,
    ),
  );
  const monthOnly = text.match(
    new RegExp(
      `(?<![\\d年])(\\d{1,2})月(?:(\\d{1,2})[日号]?)?\\s*(?:起)?\\s*${TO_DATE_ENDING_PATTERN}`,
    ),
  );
  const match = yearMonth
    ? {
      expression: yearMonth[0],
      year: normalizeYear(yearMonth[1]),
      month: Number(yearMonth[2]),
      day: Number(yearMonth[3] ?? 1),
    }
    : monthOnly
      ? {
        expression: monthOnly[0],
        year: null,
        month: Number(monthOnly[1]),
        day: Number(monthOnly[2] ?? 1),
      }
      : null;
  if (!match) {
    return null;
  }
  const businessEnd = shiftDays(todayInTimeZone(now), -1);
  const currentYear = Number(businessEnd.slice(0, 4));
  const currentMonth = Number(businessEnd.slice(5, 7));
  const year = match.year ?? currentYear;
  const start = parseDateOnly(`${year}-${match.month}-${match.day}`);
  if (!start) {
    return null;
  }
  const endDate = year < currentYear
    || (year === currentYear && match.month < currentMonth)
    ? endOfMonth(start)
    : year === currentYear && match.month === currentMonth
      ? businessEnd
      : null;
  return endDate && start <= endDate
    ? range(start, endDate, match.expression)
    : null;
}

export function resolveRecentDateInfo(dateInfo, now = new Date()) {
  const businessEnd = shiftDays(todayInTimeZone(now), -1);
  const unit = Math.max(1, Number(dateInfo?.unit) || 1);
  const period = String(dateInfo?.period ?? 'DAY').toUpperCase();
  let startDate;
  if (period === 'WEEK') {
    startDate = shiftDays(businessEnd, -(unit * 7 - 1));
  } else if (period === 'MONTH') {
    startDate = startOfMonth(businessEnd, -(unit - 1));
  } else if (period === 'QUARTER') {
    startDate = startOfQuarter(businessEnd, -(unit - 1));
  } else if (period === 'YEAR') {
    startDate = `${Number(businessEnd.slice(0, 4)) - unit + 1}-01-01`;
  } else {
    startDate = shiftDays(businessEnd, -(unit - 1));
  }
  return range(
    startDate,
    businessEnd,
    dateInfo?.detectWord || dateInfo?.expression || `最近${unit}${period}`,
  );
}

export function parseTemporalExpression(question, now = new Date()) {
  const text = String(question ?? '').replace(/\s+/g, ' ');
  const calendarToDate = parseCalendarToDate(text, now);
  if (calendarToDate) {
    return calendarToDate;
  }
  const explicitDateToDate = parseExplicitDateToDate(text, now);
  if (explicitDateToDate) {
    return explicitDateToDate;
  }
  const monthToDate = parseMonthToDate(text, now);
  if (monthToDate) {
    return monthToDate;
  }
  const yearMonthRange = parseYearMonthRange(text);
  if (yearMonthRange) {
    return yearMonthRange;
  }
  const monthRange = parseExplicitMonthRange(text);
  if (monthRange) {
    return monthRange;
  }
  const partiallyQualifiedRange = parsePartiallyQualifiedDateRange(text);
  if (partiallyQualifiedRange) {
    return partiallyQualifiedRange;
  }
  const explicitRange = parseExplicitDateRange(text);
  if (explicitRange) {
    return explicitRange;
  }
  const explicitDay = parseExplicitDay(text);
  if (explicitDay) {
    return explicitDay;
  }
  const explicitMonth = parseExplicitMonth(text, now);
  if (explicitMonth) {
    return explicitMonth;
  }
  const explicitYear = parseExplicitYear(text, now);
  if (explicitYear) {
    return explicitYear;
  }
  const yearlessRange = parseYearlessDateRange(text, now);
  if (yearlessRange) {
    return yearlessRange;
  }
  const businessToday = todayInTimeZone(now);
  const businessEnd = shiftDays(businessToday, -1);
  if (/昨天/.test(text)) {
    return range(businessEnd, businessEnd, '昨天');
  }
  if (/今天|今日/.test(text)) {
    return range(businessToday, businessToday, '今天', 'EXPLICIT');
  }
  const recent = text.match(
    /(?:最近|近|过去|前)\s*(\d+|[一二两三四五六七八九十半]+)\s*(?:个)?(?:自然)?\s*(天|日|周|星期|月|季度|季|年)/,
  );
  if (recent) {
    let unit = parseCountToken(recent[1]);
    let period = {
      天: 'DAY',
      日: 'DAY',
      周: 'WEEK',
      星期: 'WEEK',
      月: 'MONTH',
      季度: 'QUARTER',
      季: 'QUARTER',
      年: 'YEAR',
    }[recent[2]];
    if (unit === 0.5) {
      if (period === 'YEAR') {
        unit = 6;
        period = 'MONTH';
      } else if (period === 'QUARTER') {
        unit = 45;
        period = 'DAY';
      } else if (period === 'MONTH') {
        unit = 15;
        period = 'DAY';
      } else if (period === 'WEEK') {
        unit = 3;
        period = 'DAY';
      } else {
        unit = 1;
      }
    }
    if (unit && period) {
      return resolveRecentDateInfo({
        unit,
        period,
        detectWord: recent[0],
      }, now);
    }
  }
  if (/上周|上星期/.test(text)) {
    const start = shiftDays(startOfWeek(businessEnd), -7);
    return range(start, shiftDays(start, 6), '上周');
  }
  if (/本周|这周|本星期|这个星期|当周/.test(text)) {
    return range(startOfWeek(businessEnd), businessEnd, '本周');
  }
  if (/上个月|上月/.test(text)) {
    return range(
      startOfMonth(businessEnd, -1),
      endOfMonth(businessEnd, -1),
      '上个月',
    );
  }
  if (/本月|这个月|当月/.test(text)) {
    return range(startOfMonth(businessEnd), businessEnd, '本月');
  }
  if (/上个季度|上季度|上一季度/.test(text)) {
    return range(
      startOfQuarter(businessEnd, -1),
      endOfQuarter(businessEnd, -1),
      '上季度',
    );
  }
  if (/本季度|这个季度|当季度|本季|当季/.test(text)) {
    return range(startOfQuarter(businessEnd), businessEnd, '本季度');
  }
  if (/去年/.test(text)) {
    const year = Number(businessEnd.slice(0, 4)) - 1;
    return range(`${year}-01-01`, `${year}-12-31`, '去年');
  }
  if (/今年|本年|本年度|当年度|当年|今年以来|年初至今|本年至今/.test(text)) {
    return range(`${businessEnd.slice(0, 4)}-01-01`, businessEnd, '今年以来');
  }
  return null;
}

const TEMPORAL_MENTION_PATTERN = new RegExp([
  `(?:自|从)?(?:\\d{2,4}年)?\\d{1,2}月(?:\\d{1,2}[日号]?)?\\s*(?:起)?\\s*${TO_DATE_ENDING_PATTERN}`,
  `(?<![\\d年月])(?:本|这个|当)?月(?:初|1日|1号|一号|一日)?(?:起)?${TO_DATE_ENDING_PATTERN}`,
  `(?<![\\d周星期])(?:本|这|当)?(?:周|星期)(?:初)?(?:起)?${TO_DATE_ENDING_PATTERN}`,
  `(?<![\\d季度])(?:本|这|当)?(?:季度|季)(?:初)?(?:起)?${TO_DATE_ENDING_PATTERN}`,
  `(?<!\\d)(?:本|今|当)?(?:年|年度)(?:初)?(?:起)?${TO_DATE_ENDING_PATTERN}`,
  String.raw`\d{2,4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}[日号]?)?\s*(?:到|至|~|—|－|-)\s*\d{2,4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}[日号]?)?`,
  String.raw`\d{2,4}年\d{1,2}月?\s*(?:到|至|~|—|－|-)\s*(?:\d{2,4}年)?\d{1,2}月?`,
  String.raw`\d{1,2}月\d{1,2}[日号]?\s*(?:到|至|~|—|－|-)\s*(?:\d{1,2}月)?\d{1,2}[日号]?`,
  String.raw`\d{2,4}[-/.年]\d{1,2}[-/.月]\d{1,2}[日号]?`,
  String.raw`(?<!\d)\d{4}(?:0[1-9]|1[0-2])(?!\d)`,
  String.raw`(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?!\d)`,
  String.raw`(?<!\d)\d{2,4}年\d{1,2}月?`,
  String.raw`(?<!\d)\d{2,4}[-/.]\d{1,2}月?`,
  String.raw`(?<!\d)\d{2,4}年(?!\s*\d{1,2})`,
  String.raw`(?<!\d)\d{1,2}月份?(?!\s*(?:\d|[~～到至—－-]))`,
  String.raw`(?:最近|近|过去|前)\s*(?:\d+|[一二两三四五六七八九十]+)\s*(?:个)?(?:自然)?\s*(?:天|日|周|星期|月|季度|季|年)`,
  String.raw`本月|这个月|当月|上月|上个月|本周|这周|本星期|这个星期|当周|上周|上星期|今天|今日|昨天|今年|本年|本年度|当年度|当年|去年|本季度|这个季度|当季度|本季|当季|上季度`,
].join('|'), 'g');

export function extractTemporalMentions(question, now = new Date()) {
  const text = String(question ?? '').replace(/\s+/g, ' ');
  const mentions = [];
  for (const match of text.matchAll(TEMPORAL_MENTION_PATTERN)) {
    const expression = match[0];
    const start = Number(match.index);
    const end = start + expression.length;
    const previous = mentions.at(-1);
    if (previous && start < previous.end && end > previous.start) {
      if (expression.length <= previous.expression.length) {
        continue;
      }
      mentions.pop();
    }
    const dateInfo = parseTemporalExpression(expression, now);
    if (!dateInfo) {
      continue;
    }
    mentions.push({
      expression,
      start,
      end,
      dateInfo: {
        ...dateInfo,
        detectWord: expression,
        expression,
      },
    });
  }
  return mentions;
}

export { TIME_ZONE, todayInTimeZone };
