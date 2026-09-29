import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SKIPPED_DIRECTORIES = new Set(['node_modules', '__pycache__', '.git']);

function parseScalar(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return '';
  }
  if (
    (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    return text.slice(1, -1)
      .split(',')
      .map((item) => parseScalar(item))
      .filter(Boolean);
  }
  return text;
}

function parseFrontmatter(source) {
  const match = String(source ?? '').match(
    /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/,
  );
  if (!match) {
    return { metadata: {}, body: String(source ?? '') };
  }
  const metadata = {};
  let currentKey = null;
  let currentBlock = [];
  let blockStyle = '';

  const flush = () => {
    if (!currentKey) {
      return;
    }
    const lines = currentBlock.map((line) => line.trim()).filter(Boolean);
    metadata[currentKey] = blockStyle === '|'
      ? lines.join('\n')
      : lines.join(' ');
    currentKey = null;
    currentBlock = [];
    blockStyle = '';
  };

  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      continue;
    }
    const topLevel = line.match(/^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/);
    if (topLevel) {
      flush();
      const [, key, value = ''] = topLevel;
      if (value === '>' || value === '|') {
        currentKey = key;
        blockStyle = value;
      } else if (value === '') {
        metadata[key] = {};
      } else {
        metadata[key] = parseScalar(value);
      }
      continue;
    }
    if (currentKey) {
      currentBlock.push(rawLine.replace(/^\s+/, ''));
    }
  }
  flush();
  return {
    metadata,
    body: String(source ?? '').slice(match[0].length),
  };
}

function slugify(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'unnamed-skill';
}

function inferPhaseTags(skill) {
  const primaryDescription = String(skill.description ?? '')
    .split(/[.。!！?？]/)
    .map((item) => item.trim())
    .find(Boolean) ?? '';
  const identity = [
    skill.name,
    primaryDescription,
  ].join('\n').toLowerCase();
  const headings = markdownSections(skill.body)
    .slice(0, 20)
    .map((section) => section.title)
    .join('\n')
    .toLowerCase();
  const tags = new Set();
  if (
    /audit|data meaning|row grain|time semantics|source of truth|口径|粒度|数据含义|源数据/.test(identity)
  ) {
    tags.add('PRE_PLAN');
  }
  if (
    /orchestrat|workflow|method|analysis plan|data science|data analysis|分析方法|分析计划|工作流/.test(identity)
  ) {
    tags.add('PLAN');
  }
  if (
    /validat|verify|verification|claim|结果验证|结论核验/.test(identity)
  ) {
    tags.add('POST_EXECUTE');
  }
  if (tags.size === 0) {
    if (/audit|ground truth|source and lineage|time semantics/.test(headings)) {
      tags.add('PRE_PLAN');
    }
    if (/workflow|method|lifecycle|analysis plan/.test(headings)) {
      tags.add('PLAN');
    }
    if (/validate|verification|quality check|evidence contract/.test(headings)) {
      tags.add('POST_EXECUTE');
    }
  }
  if (tags.size === 0) {
    tags.add('PLAN');
  }
  return [...tags];
}

function markdownSections(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const sections = [];
  let current = { title: '', content: [] };
  for (const line of lines) {
    if (/^#{1,4}\s+/.test(line)) {
      if (current.title || current.content.length > 0) {
        sections.push({
          title: current.title,
          content: current.content.join('\n').trim(),
        });
      }
      current = {
        title: line.replace(/^#{1,4}\s+/, '').trim(),
        content: [],
      };
    } else {
      current.content.push(line);
    }
  }
  if (current.title || current.content.length > 0) {
    sections.push({
      title: current.title,
      content: current.content.join('\n').trim(),
    });
  }
  return sections.filter((section) => section.title || section.content);
}

function phaseKeywords(phase) {
  if (phase === 'PRE_PLAN') {
    return [
      'audit', 'source', 'lineage', 'meaning', 'grain', 'time', 'relationship',
      'ground truth', 'contract', 'scope', 'assumption', '口径', '粒度',
      '时间', '来源', '关系', '审计', '范围',
    ];
  }
  if (phase === 'POST_EXECUTE') {
    return [
      'validate', 'verification', 'verify', 'claim', 'evidence', 'quality',
      'reproduc', 'handoff', 'boundary', 'constraint', '验证', '证据',
      '质量', '复现', '结论', '边界',
    ];
  }
  return [
    'workflow', 'loop', 'plan', 'method', 'baseline', 'analysis', 'decision',
    '分析', '计划', '方法', '基线', '决策',
  ];
}

export function extractSkillGuidance(skill, phase, limit = 1800) {
  const sections = markdownSections(skill.body);
  const keywords = phaseKeywords(phase);
  const scored = sections
    .map((section, index) => {
      const text = `${section.title}\n${section.content}`.toLowerCase();
      const score = keywords.reduce(
        (sum, keyword) => sum + (text.includes(keyword) ? 1 : 0),
        0,
      );
      return { ...section, index, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = scored
    .filter((section) => section.score > 0)
    .slice(0, 3);
  if (selected.length === 0) {
    selected.push(...scored.slice(0, 2));
  }
  const text = selected.map((section) => (
    section.title ? `## ${section.title}\n${section.content}` : section.content
  )).join('\n\n').trim();
  return text.length > limit ? `${text.slice(0, limit)}\n...` : text;
}

export function parseSkillDocument(source, sourcePath = '') {
  const { metadata, body } = parseFrontmatter(source);
  const fallbackName = sourcePath
    ? path.basename(path.dirname(sourcePath))
    : 'unnamed-skill';
  const name = String(metadata.name ?? fallbackName).trim() || fallbackName;
  const description = String(metadata.description ?? '').trim();
  const skill = {
    name,
    description,
    body: String(body ?? '').trim(),
    compatibility: String(metadata.compatibility ?? '').trim(),
    version: String(metadata.version ?? metadata['short-description'] ?? '').trim(),
    metadata,
  };
  const explicitPhases = Array.isArray(metadata.phases)
    ? metadata.phases
    : String(metadata.phases ?? '')
      .split(/[,，\s]+/)
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean);
  const phaseTags = explicitPhases.length > 0
    ? [...new Set(explicitPhases)]
    : inferPhaseTags(skill);
  const code = `external:${slugify(metadata.code ?? name)}`;
  const phaseGuides = Object.fromEntries(
    ['PRE_PLAN', 'PLAN', 'POST_EXECUTE']
      .filter((phase) => phaseTags.includes(phase))
      .map((phase) => [phase, extractSkillGuidance(skill, phase)]),
  );
  return {
    code,
    name,
    description: description || `External Skill: ${name}`,
    category: 'EXTERNAL',
    kind: 'INSTRUCTION',
    toolName: null,
    instruction: description || `External Skill: ${name}`,
    defaultEnabled: false,
    source: 'SKILL_MD',
    sourcePath: sourcePath ? path.resolve(sourcePath) : null,
    metadata: {
      ...metadata,
      compatibility: skill.compatibility,
      version: skill.version,
    },
    phaseTags,
    phaseGuides,
    content: skill.body,
    contentHash: crypto.createHash('sha256').update(source).digest('hex'),
  };
}

function listSkillFiles(root, files, depth = 0) {
  if (depth > 5 || files.length >= 500) {
    return;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= 500) {
      break;
    }
    if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      listSkillFiles(target, files, depth + 1);
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      files.push(target);
    }
  }
}

export class SkillAdapter {
  constructor({ directories = [], maxSkills = 200 } = {}) {
    this.directories = [...new Set(
      directories.map((directory) => path.resolve(String(directory))),
    )];
    this.maxSkills = maxSkills;
  }

  discover() {
    const files = [];
    const warnings = [];
    const scannedRoots = [];
    for (const directory of this.directories) {
      if (!fs.existsSync(directory)) {
        continue;
      }
      scannedRoots.push(directory);
      const directoryFiles = [];
      listSkillFiles(directory, directoryFiles);
      files.push(...directoryFiles);
    }
    const skills = [];
    const seen = new Set();
    for (const filePath of files.slice(0, this.maxSkills)) {
      try {
        const source = fs.readFileSync(filePath, 'utf8');
        const skill = parseSkillDocument(source, filePath);
        if (seen.has(skill.code)) {
          warnings.push(`Skill code duplicated: ${skill.code} (${filePath})`);
          continue;
        }
        seen.add(skill.code);
        skills.push(skill);
      } catch (error) {
        warnings.push(`Skill parse failed: ${filePath}: ${error.message}`);
      }
    }
    return {
      skills,
      warnings,
      roots: scannedRoots,
      configuredRoots: this.directories,
    };
  }
}
