import { readArtifactText, readArtifactTextAsync } from './analysisArtifactReader.js';
// ANALYSIS_CODE 产物读取与契约校验；分析方法仍由沙箱代码实现。

import {
  ANALYSIS_RESULT_FILE,
  summarizeAnalysisReport,
  summarizeAnalysisResult,
  validateAnalysisResult,
} from './analysisContract.js';

// 失败也返回完整形状，调用方无需区分字段是否缺失。
function fail(code, message) {
  return {
    file: ANALYSIS_RESULT_FILE,
    valid: false,
    issues: [{ code, level: 'error', message }],
    claims: [],
    normalized: null,
    report: '',
    summary: '',
  };
}

// 沙箱一轮可能产生多个输出文件，只认契约约定名字的那一个。
function findAnalysisOutput(outputs) {
  return (outputs ?? []).find((output) => (
    String(output?.fileName ?? '').toLowerCase() === ANALYSIS_RESULT_FILE
  )) ?? null;
}

// outputs 里没有契约产物时返回 null：表示"本轮没有可校验的分析结果"，
// 与"有产物但校验不通过"是两回事，调用方据此区分是否要告警。
function validateAnalysisContent(content, { requireReport = false } = {}) {
  if (!content) {
    return fail(
      'ANALYSIS-UNREADABLE',
      `无法读取 ${ANALYSIS_RESULT_FILE} 内容，无法完成契约校验。`,
    );
  }
  let payload = null;
  try {
    payload = JSON.parse(content);
  } catch (error) {
    return fail(
      'ANALYSIS-INVALID-JSON',
      `${ANALYSIS_RESULT_FILE} 不是合法 JSON：${error.message}`,
    );
  }
  const validation = validateAnalysisResult(payload, { requireReport });
  return {
    file: ANALYSIS_RESULT_FILE,
    valid: validation.valid,
    issues: validation.issues,
    claims: validation.claims,
    normalized: validation.normalized,
    report: validation.valid ? summarizeAnalysisReport(validation) : '',
    summary: validation.valid ? summarizeAnalysisResult(validation) : '',
  };
}

export function validateAnalysisOutputs({ workspace, outputs, userId = undefined,
  requireReport = false }) {
  const target = findAnalysisOutput(outputs);
  return target
    ? validateAnalysisContent(readArtifactText(workspace, target.artifactId, userId), { requireReport })
    : null;
}

export async function validateAnalysisOutputsAsync({ workspace, outputs, userId = undefined,
  requireReport = false }) {
  const target = findAnalysisOutput(outputs);
  return target
    ? validateAnalysisContent(
      await readArtifactTextAsync(workspace, target.artifactId, userId),
      { requireReport },
    )
    : null;
}
