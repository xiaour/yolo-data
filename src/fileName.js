const INVALID_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const LEADING_FILLERS =
  /^(请你|请|帮我|麻烦|看一下|看看|提供给我|提供|查询|查一下|统计一下|统计|分析一下|分析|给我|输出|生成)+/;
const DELIVERY_INSTRUCTION =
  /(?:并|然后|再)?(?:整理|生成|输出|导出|下载|制作|保存)(?:成|为)?(?:(?:一份|一个|一张)?(?:excel|excel表|xlsx|csv|表格|文件|报告|图表|图))?(?:给到我|给我|发给我|即可|谢谢)?.*$/i;
const QUESTION_TAIL = /(?:是多少|多少|是什么|怎么样|如何|请告知|告诉我)$/;

function compact(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[，。；：、“”‘’（）【】《》·•]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildSessionFileName(question, {
  fallback = '问数工作区',
  maxLength = 48,
} = {}) {
  let value = compact(question);
  for (let index = 0; index < 3; index += 1) {
    const next = value
      .replace(LEADING_FILLERS, '')
      .replace(/^[\s，。；：、/\\|_-]+/, '')
      .trim();
    if (next === value) {
      break;
    }
    value = next;
  }
  value = value.replace(INVALID_FILE_CHARS, '_').replace(/\s+/g, '_');
  value = value.replace(/[_\-—]+$/g, '').replace(/^[_\-—]+/g, '');
  if (!value) {
    return fallback;
  }
  const characters = [...value];
  return characters.length <= maxLength
    ? value
    : characters.slice(0, maxLength).join('').replace(/[_\-—]+$/g, '');
}

export function buildArtifactTitle(question, {
  fallback = '问数产物',
  maxLength = 28,
} = {}) {
  const firstSentence = String(question ?? '').split(/[。！？!?；;\n]/, 1)[0];
  let value = compact(firstSentence);
  for (let index = 0; index < 3; index += 1) {
    const next = value
      .replace(LEADING_FILLERS, '')
      .replace(/^[\s，。；：、/\\|_-]+/, '')
      .trim();
    if (next === value) {
      break;
    }
    value = next;
  }
  value = value
    .replace(DELIVERY_INSTRUCTION, '')
    .replace(QUESTION_TAIL, '')
    .replace(INVALID_FILE_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[的及和与\s]+$/g, '')
    .trim();
  if (!value) {
    return fallback;
  }
  const characters = [...value];
  if (characters.length <= maxLength) {
    return value;
  }
  return characters
    .slice(0, maxLength)
    .join('')
    .replace(/[的及和与\s]+$/g, '');
}

export function buildArtifactFileName({
  workspaceName,
  artifactTitle,
  extension,
}) {
  const artifactName = compact(artifactTitle).replace(INVALID_FILE_CHARS, '_');
  const workspaceLabel = compact(workspaceName).replace(INVALID_FILE_CHARS, '_');
  const name = artifactName || workspaceLabel || '问数结果';
  const safeName = [...String(name)]
    .slice(0, 96)
    .join('')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `${safeName}.${String(extension ?? '').replace(/^\./, '')}`;
}

export { INVALID_FILE_CHARS };
