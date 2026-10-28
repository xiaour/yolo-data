export function composeAnswerMessage({
  deterministicMessage = '',
  semanticFastPathError = null,
  clarificationExhausted = false,
  harnessContent = '',
  carryForwardSummary = '',
  datasetName = '',
  analysisText = '',
  validationWarnings = [],
  clarification = null,
}) {
  const baseMessage = deterministicMessage
    || (semanticFastPathError ? `本轮无法完成数据集查询：${semanticFastPathError.message}` : '')
    || (clarificationExhausted
      ? '本轮归因问题已达到澄清上限，系统不会继续逐项反问。请补齐主题提示词中的归因公式、同期规则或候选归因维度后重新执行。'
      : harnessContent)
    || carryForwardSummary
    || (datasetName ? `已完成「${datasetName}」业务数据查询。` : '查询已完成。');
  const finalMessage = clarification
    ? clarification.prompt
    : [
      baseMessage,
      analysisText,
      validationWarnings.length > 0
        ? `**结果验证提示**\n${validationWarnings.join('\n')}`
        : '',
    ].filter(Boolean).join('\n\n');
  return { baseMessage, finalMessage };
}
