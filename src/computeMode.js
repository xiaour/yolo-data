export const COMPUTE_MODES = Object.freeze({
  FAST: 'fast',
  AUTO: 'auto',
  DEEP: 'deep',
});

const DEEP_ANALYSIS_TERMS = [
  '为什么', '原因', '归因', '机会', '机会点', '诊断', '分析报告', '深入分析',
  '下降', '增长驱动', '贡献', '同期对比', '同比', '环比', '异常', '趋势解读',
];

export function normalizeComputeMode(value, fallback = COMPUTE_MODES.AUTO) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return Object.values(COMPUTE_MODES).includes(normalized) ? normalized : fallback;
}

function needsDeepAnalysis({ question, analysisRequest, analysisMode, conversationContext, codexThreadId }) {
  if (String(codexThreadId ?? '').trim()) return 'durable_codex_session';
  if (analysisRequest?.taskKind === 'ANALYSIS') return 'analysis_task';
  if (analysisMode?.mode === 'ATTRIBUTION') return 'attribution';
  if (DEEP_ANALYSIS_TERMS.some((term) => String(question ?? '').includes(term))) {
    return 'complex_analysis_language';
  }
  if (conversationContext?.mode === 'FOLLOW_UP') return 'multi_turn_context';
  return '';
}

export class ComputeModeRouter {
  constructor({ codexHarness = null, defaultMode = COMPUTE_MODES.AUTO } = {}) {
    this.codexHarness = codexHarness;
    this.defaultMode = normalizeComputeMode(defaultMode);
  }

  codexAvailable() {
    return Boolean(this.codexHarness?.isAvailable?.());
  }

  select({ requestedMode, fastHarness, question, analysisRequest, analysisMode, conversationContext, codexThreadId }) {
    // Runtime choice is owned by YOLO. Keep accepting the legacy request field
    // during rollout, but never allow a client preference to override routing.
    normalizeComputeMode(requestedMode, this.defaultMode);
    const requested = COMPUTE_MODES.AUTO;
    const deepReason = needsDeepAnalysis({
      question, analysisRequest, analysisMode, conversationContext, codexThreadId,
    });
    if (deepReason && this.codexAvailable()) {
      return { requested, resolved: COMPUTE_MODES.DEEP, reason: deepReason, harness: this.codexHarness };
    }
    return {
      requested,
      resolved: COMPUTE_MODES.FAST,
      reason: deepReason ? 'codex_unavailable_fallback' : 'simple_query',
      harness: fastHarness,
    };
  }
}

