import { buildCacheKey, RuntimeCache } from './runtimeCache.js';
import { buildThemeColumnRules } from './themePresentationRules.js';
import {
  buildOnlineTemplateRules,
  mergeDeterministicFallbacks,
} from './presentationFallbacks.js';

const PRESENTATION_TYPES = new Set([
  'amount',
  'quantity',
  'percent',
  'number',
]);

const PRESENTATION_BASES = new Set([
  'THEME_PROMPT',
  'ONLINE_METADATA',
  'RESULT_EVIDENCE',
]);

const PRESENTATION_SYSTEM_PROMPT = [
  'You compile a presentation contract for query results.',
  'Return JSON only. Do not return Markdown, explanations, or formatted values.',
  'Never return strings such as "47万", "8.4%", or other rendered cell values.',
  'The JSON shape must be {"fields":{"<field>":{"type":"amount|quantity|percent|number","unit":"","displayScale":1,"xlsxScale":1,"decimals":2,"prefix":"","suffix":"","basis":"THEME_PROMPT|ONLINE_METADATA|RESULT_EVIDENCE","reason":""}}}.',
  'displayScale converts a raw value to the value shown in chat, page tables, Markdown, and CSV.',
  'xlsxScale converts a raw value to the numeric value stored in an XLSX cell.',
  'A displayScale of 0.0001 turns a raw 470000 into a displayed 47; use the scale the theme prompt declares.',
  'For a decimal fraction 0.084 displayed as 8.4%, use type percent, unit %, displayScale 100, xlsxScale 1, and decimals 1.',
  'For a value 8.4 already expressed as percentage points, use type percent, unit %, displayScale 1, xlsxScale 0.01, and decimals 1.',
  'Online structured formatting metadata is authoritative when it conflicts with a theme prompt.',
  'Use the theme prompt only when it gives an explicit unit, scale, percentage interpretation, precision, prefix, or suffix rule.',
  'Use result samples only to disambiguate an explicit rule; do not invent a display rule from the field name or magnitude.',
  'Omit a field when no explicit presentation rule exists. Omission means render the raw value without projection.',
  'Do not output fields that were not provided in the evidence.',
].join('\n');

function columnKey(column) {
  return String(column?.bizName ?? column?.nameEn ?? column?.name ?? '').trim();
}

function columnLabel(column) {
  return String(column?.childName ?? column?.name ?? columnKey(column)).trim();
}

function isNumericColumn(column) {
  return String(column?.showType ?? '').toUpperCase() === 'NUMBER'
    || ['NUMBER', 'DECIMAL', 'DOUBLE', 'FLOAT', 'INTEGER', 'BIGINT']
      .includes(String(column?.type ?? '').toUpperCase());
}

function numericValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatDecimal(value, decimals) {
  return Number(value).toLocaleString('zh-CN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function cleanText(value, maxLength = 48) {
  const characters = [];
  for (const character of String(value ?? '').trim()) {
    const code = character.charCodeAt(0);
    if (code >= 32 && code !== 127) {
      characters.push(character);
    }
    if (characters.length >= maxLength) {
      break;
    }
  }
  return characters.join('');
}

function hasAsciiDigit(value) {
  for (const character of String(value ?? '')) {
    const code = character.charCodeAt(0);
    if (code >= 48 && code <= 57) {
      return true;
    }
  }
  return false;
}

function normalizePositiveScale(value, fallback = 1) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1_000_000_000_000) {
    const fallbackNumber = Number(fallback);
    return Number.isFinite(fallbackNumber) && fallbackNumber > 0
      ? fallbackNumber
      : 1;
  }
  return number;
}

function normalizeDecimals(value, fallback = 2) {
  const number = Number(value);
  return Number.isInteger(number)
    ? Math.max(0, Math.min(6, number))
    : fallback;
}

function canonicalNumberFormat(type, decimals) {
  if (type === 'percent') {
    return decimals > 0 ? `0.${'0'.repeat(decimals)}%` : '0%';
  }
  return decimals > 0 ? `#,##0.${'0'.repeat(decimals)}` : '#,##0';
}

function normalizePresentationBasis(value) {
  const basis = String(value ?? '').trim().toUpperCase();
  return PRESENTATION_BASES.has(basis) ? basis : 'RESULT_EVIDENCE';
}

function cloneContract(contract) {
  return JSON.parse(JSON.stringify(contract));
}

export function normalizeFieldRule(rule, {
  source = 'MODEL_PRESENTATION_CONTRACT',
  defaultBasis = null,
} = {}) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    return null;
  }
  const type = String(rule.type ?? '').trim().toLowerCase();
  if (!PRESENTATION_TYPES.has(type)) {
    return null;
  }
  const decimals = normalizeDecimals(rule.decimals);
  const displayScale = normalizePositiveScale(rule.displayScale);
  const xlsxScale = normalizePositiveScale(rule.xlsxScale, displayScale);
  const prefix = cleanText(rule.prefix, 8);
  const suffix = cleanText(rule.suffix, 8);
  if (hasAsciiDigit(prefix) || hasAsciiDigit(suffix)) {
    return null;
  }
  const unit = type === 'percent'
    ? '%'
    : cleanText(rule.unit, 16);
  return {
    type,
    unit,
    displayScale,
    xlsxScale,
    decimals,
    numberFormat: canonicalNumberFormat(type, decimals),
    prefix,
    suffix,
    source,
    basis: normalizePresentationBasis(rule.basis ?? defaultBasis),
    reason: cleanText(rule.reason, 180),
  };
}

function emptyPresentationContract(warnings = []) {
  return {
    version: 1,
    source: 'RAW',
    fields: {},
    meta: {
      planner: 'NONE',
      generatedByModel: false,
      provider: null,
      model: null,
      fieldCount: 0,
      evidenceFieldCount: 0,
      rejectedFields: [],
      warnings,
    },
  };
}

export function normalizePresentationContract(contract, {
  allowedFields = null,
  provider = null,
  model = null,
  evidenceFieldCount = null,
  generatedByModel = null,
  warnings = [],
} = {}) {
  const fields = {};
  const rejectedFields = [];
  const allowed = allowedFields == null
    ? null
    : new Set(allowedFields.map((field) => String(field)));
  for (const [key, rule] of Object.entries(contract?.fields ?? {})) {
    const field = String(key);
    if (allowed && !allowed.has(field)) {
      rejectedFields.push({
        field,
        reason: 'FIELD_NOT_IN_RESULT',
      });
      continue;
    }
    const normalized = normalizeFieldRule(rule);
    if (normalized) {
      fields[field] = normalized;
    } else {
      rejectedFields.push({
        field,
        reason: 'INVALID_PRESENTATION_RULE',
      });
    }
  }
  const contractMeta = contract?.meta ?? {};
  const contractWarnings = Array.isArray(contractMeta.warnings)
    ? contractMeta.warnings
    : [];
  const isModelContract = generatedByModel === true
    || contractMeta.generatedByModel === true;
  return {
    version: 1,
    source: isModelContract ? 'MODEL_PRESENTATION_CONTRACT' : 'RAW',
    fields,
    meta: {
      planner: isModelContract ? 'MODEL' : 'NONE',
      generatedByModel: isModelContract,
      provider: provider ?? contractMeta.provider ?? null,
      model: model ?? contractMeta.model ?? null,
      fieldCount: Object.keys(fields).length,
      evidenceFieldCount: Number.isInteger(Number(evidenceFieldCount))
        ? Number(evidenceFieldCount)
        : Number(contractMeta.evidenceFieldCount) || 0,
      rejectedFields,
      warnings: [...contractWarnings, ...warnings],
    },
  };
}

function extractJson(text) {
  const content = String(text ?? '').trim();
  if (!content) {
    return null;
  }
  const candidates = [];
  if (content.startsWith('```')) {
    const firstLineEnd = content.indexOf('\n');
    const closingFence = content.lastIndexOf('```');
    if (firstLineEnd >= 0 && closingFence > firstLineEnd) {
      candidates.push(content.slice(firstLineEnd + 1, closingFence).trim());
    }
  }
  candidates.push(content);
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start >= 0 && end > start) {
    candidates.push(content.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next JSON candidate.
    }
  }
  return null;
}

export function buildPresentationEvidence(rawResult) {
  const columns = rawResult?.columns ?? [];
  const rows = rawResult?.resultList ?? rawResult?.rows ?? [];
  return {
    columns,
    rows,
    onlineFormattedRows: Array.isArray(rawResult?.formattedResultList)
      ? rawResult.formattedResultList
      : [],
    onlineTemplates: rawResult?.formatTemplates
      && typeof rawResult.formatTemplates === 'object'
      ? rawResult.formatTemplates
      : {},
  };
}

export class PresentationPlanner {
  constructor({
    ttlMs = 30 * 60_000,
    maxEntries = 256,
  } = {}) {
    this.cache = new RuntimeCache({
      defaultTtlMs: ttlMs,
      maxEntries,
    });
  }

  async plan({
    harness,
    prompt = '',
    question = '',
    columns = [],
    rows = [],
    presentationEvidence = null,
    metadata = {},
  }) {
    const onlineTemplates = presentationEvidence?.onlineTemplates ?? {};
    const onlineFormattedRows = presentationEvidence?.onlineFormattedRows ?? [];
    const schema = columns
      .filter(isNumericColumn)
      .map((column) => {
        const key = columnKey(column);
        const samples = rows
          .slice(0, 8)
          .map((row) => row?.[key])
          .filter((value) => value !== null && value !== undefined);
        return {
          field: key,
          label: columnLabel(column),
          dataType: column?.type ?? '',
          unit: column?.unit ?? '',
          dataFormatType: column?.dataFormatType ?? null,
          dataFormat: column?.dataFormat ?? null,
          rawSamples: samples,
          onlineFormattedSamples: onlineFormattedRows
            .slice(0, 8)
            .map((row) => row?.[key])
            .filter((value) => value !== null && value !== undefined),
          onlineTemplate: onlineTemplates[key] ?? null,
        };
      })
      .filter((field) => field.field);
    const deterministic = {
      schema,
      themeRules: buildThemeColumnRules(prompt, schema),
      onlineTemplateRules: buildOnlineTemplateRules(onlineTemplates, schema),
    };
    if (!harness?.chat || schema.length === 0) {
      return mergeDeterministicFallbacks(
        emptyPresentationContract(
          harness?.chat
            ? []
            : [{
              code: 'PRESENTATION_MODEL_NOT_AVAILABLE',
              message: '当前运行模型不支持展示契约生成，按主题提示词/在线格式展示。',
            }],
        ),
        deterministic,
      );
    }
    const cacheKey = buildCacheKey({
      version: 2,
      prompt,
      question,
      schema,
      onlineTemplates,
      onlineFormattedRows,
    });
    const cachedContract = this.cache.get('presentation-contract', cacheKey);
    if (cachedContract) {
      return cloneContract(cachedContract);
    }
    let response = null;
    try {
      response = await harness.chat([
        {
          role: 'system',
          content: PRESENTATION_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: JSON.stringify({
            question,
            themePrompt: prompt,
            fields: schema,
          }),
        },
      ], [], {
        ...metadata,
        callType: 'PRESENTATION_CONTRACT',
        question,
      });
    } catch (error) {
      return mergeDeterministicFallbacks(
        emptyPresentationContract([{
          code: 'PRESENTATION_MODEL_FAILED',
          message: `展示契约生成失败，按主题提示词/在线格式展示：${error.message}`,
        }]),
        deterministic,
      );
    }
    const planned = extractJson(
      response?.choices?.[0]?.message?.content
      ?? response?.content,
    );
    if (!planned) {
      return mergeDeterministicFallbacks(
        emptyPresentationContract([{
          code: 'PRESENTATION_CONTRACT_INVALID',
          message: '模型返回的展示契约不是有效 JSON，按主题提示词/在线格式展示。',
        }]),
        deterministic,
      );
    }
    const contract = mergeDeterministicFallbacks(normalizePresentationContract(planned, {
      allowedFields: schema.map((field) => field.field),
      provider: harness.provider ?? null,
      model: harness.model ?? null,
      evidenceFieldCount: schema.length,
      generatedByModel: true,
    }), deterministic);
    if (contract.source === 'MODEL_PRESENTATION_CONTRACT') {
      this.cache.set('presentation-contract', cacheKey, contract);
    }
    return contract;
  }
}

function appendUnit(label, rule) {
  const text = String(label ?? '').trim();
  const unit = String(rule?.unit ?? '').trim();
  if (!text || !unit) {
    return text;
  }
  const suffix = unit === '%' ? '（%）' : `（${unit}）`;
  const compact = text
    .split(' ')
    .join('')
    .split('\t')
    .join('');
  if (
    compact.includes(suffix)
    || (unit === '%' && compact.includes('%'))
    || compact.endsWith(`(${unit})`)
  ) {
    return text;
  }
  return `${text}${suffix}`;
}

export function applyResultPresentation({
  columns = [],
  rows = [],
  contract = null,
} = {}) {
  const normalized = normalizePresentationContract(contract, {
    allowedFields: columns.map(columnKey).filter(Boolean),
  });
  const presentedColumns = columns.map((column) => {
    const key = columnKey(column);
    const rule = normalized.fields[key];
    if (!rule) {
      return column;
    }
    const next = {
      ...column,
      presentationType: rule.type,
      presentationSource: rule.source,
      presentationBasis: rule.basis,
      displayScale: rule.displayScale,
      xlsxScale: rule.xlsxScale,
      displayDecimals: rule.decimals,
      numberFormat: rule.numberFormat,
      unit: rule.unit,
      prefix: rule.prefix,
      suffix: rule.suffix,
    };
    if (column?.parentName) {
      const childName = appendUnit(
        column.childName ?? column.name,
        rule,
      );
      next.childName = childName;
      next.name = `${column.parentName}·${childName}`;
    } else {
      next.name = appendUnit(column.name ?? key, rule);
    }
    return next;
  });
  return {
    contract: normalized,
    columns: presentedColumns,
    rows,
  };
}

export function formatPresentationCell(value, column) {
  const number = numericValue(value);
  if (number === null) {
    return '-';
  }
  const scaled = number * (Number(column?.displayScale) || 1);
  const text = formatDecimal(
    scaled,
    Number.isInteger(column?.displayDecimals) ? column.displayDecimals : 2,
  );
  const prefix = String(column?.prefix ?? '');
  const suffix = String(column?.suffix ?? '');
  if (column?.presentationType === 'percent') {
    return `${prefix}${text}%${
      suffix && suffix !== '%' ? suffix : ''
    }`;
  }
  return `${prefix}${text}${suffix}`;
}

export function presentationValueForColumn(value, column) {
  const number = numericValue(value);
  if (number === null) {
    return value;
  }
  const scale = Number(column?.xlsxScale) || 1;
  return number * scale;
}
