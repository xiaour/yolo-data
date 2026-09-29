import { extractSkillGuidance, SkillAdapter } from './skillAdapter.js';

const REQUIRED_TOOLS = [
  'search_indicators',
  'get_indicator',
  'compile_query_contract',
  'execute_query_contract',
  'list_workspace_artifacts',
  'transform_workspace_artifact',
  'execute_analysis_code',
];
const TOOL_SKILL_ALIASES = {
  compile_query_contract: 'indicator_definition',
  execute_query_contract: 'indicator_query',
};

function normalizeSkillCodes(skillCodes, availableSkills) {
  const available = new Map(availableSkills.map((skill) => [skill.code, skill]));
  const selected = [...new Set((skillCodes ?? []).map((code) => String(code)))];
  for (const skill of availableSkills) {
    if (skill.kind === 'TOOL' && REQUIRED_TOOLS.includes(skill.toolName)) {
      selected.push(skill.code);
    }
  }
  return [...new Set(selected)]
    .map((code) => available.get(code))
    .filter(Boolean);
}

export class SkillRegistry {
  constructor(database, { skillDirectories = [] } = {}) {
    this.database = database;
    this.adapter = new SkillAdapter({
      directories: skillDirectories,
    });
    this.lastSync = null;
  }

  refreshExternalSkills() {
    const discovered = this.adapter.discover();
    if (discovered.roots.length === 0) {
      this.lastSync = {
        syncedAt: new Date().toISOString(),
        count: this.listSkills().filter((skill) => skill.source === 'SKILL_MD').length,
        roots: [],
        configuredRoots: discovered.configuredRoots,
        warnings: discovered.warnings,
        skipped: true,
      };
      return this.lastSync;
    }
    const count = this.database.syncExternalSkills(discovered.skills);
    this.lastSync = {
      syncedAt: new Date().toISOString(),
      count,
      roots: discovered.roots,
      configuredRoots: discovered.configuredRoots,
      warnings: discovered.warnings,
      skipped: false,
    };
    return this.lastSync;
  }

  listSkills() {
    return this.database.listSkills();
  }

  listForTheme(theme) {
    const available = this.listSkills();
    return normalizeSkillCodes(theme?.skillCodes ?? [], available);
  }

  buildInstructions(skills, phase = null) {
    if (phase) {
      return this.buildPhaseInstructions(skills, phase)
        .map((item) => item.guidance)
        .filter(Boolean);
    }
    return (skills ?? [])
      .map((skill) => skill.instruction)
      .filter(Boolean);
  }

  buildPhaseInstructions(skills, phase) {
    const normalizedPhase = String(phase ?? '').toUpperCase();
    return (skills ?? [])
      .filter((skill) => (
        String(skill.source ?? '').toUpperCase() === 'SKILL_MD'
        && (skill.phaseTags ?? []).map(String).map((item) => item.toUpperCase())
          .includes(normalizedPhase)
      ))
      .map((skill) => {
        const full = this.database.getSkill(skill.code) ?? skill;
        const guidance = extractSkillGuidance({
          ...full,
          body: full.content ?? '',
        }, normalizedPhase);
        return {
          code: skill.code,
          name: skill.name,
          phase: normalizedPhase,
          sourcePath: skill.sourcePath ?? null,
          guidance,
        };
      })
      .filter((item) => item.guidance);
  }

  auditPlanningContext({
    skills,
    question,
    theme,
    businessDatasets = [],
    primaryBusinessDatasetId = null,
  }) {
    const guidance = this.buildPhaseInstructions(skills, 'PRE_PLAN');
    const checks = [
      {
        id: 'source-of-truth',
        level: businessDatasets.length > 0 ? 'PASS' : 'WARN',
        message: businessDatasets.length > 0
          ? `已绑定 ${businessDatasets.length} 个业务数据集，取数源已确定`
          : '当前主题未绑定业务数据集，将使用指标语义查询',
      },
      {
        id: 'row-grain',
        level: question ? 'PASS' : 'WARN',
        message: '已在规划前记录问题对象、分组维度和聚合粒度',
      },
    ];
    for (const item of guidance) {
      const extracted = String(item.guidance)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[-*]\s+|^\d+[.)、]\s+/.test(line))
        .map((line) => line.replace(/^[-*]\s+|^\d+[.)、]\s+/, '').trim())
        .filter(Boolean)
        .slice(0, 4);
      for (const check of extracted) {
        checks.push({
          id: `${item.code}:${checks.length + 1}`,
          level: 'INFO',
          sourceSkill: item.code,
          message: check,
        });
      }
    }
    return {
      phase: 'PRE_PLAN',
      status: guidance.length > 0 ? 'READY' : 'SKIPPED',
      skillCount: guidance.length,
      question,
      theme: theme?.name ?? '',
      primaryBusinessDatasetId,
      guidance,
      checks,
    };
  }

  validateQueryResult({
    skills,
    question,
    semanticParse,
    dataset,
    indicator,
    data,
  }) {
    const guidance = this.buildPhaseInstructions(skills, 'POST_EXECUTE');
    const contract = semanticParse?.queryContract ?? null;
    const hasResult = Array.isArray(data?.rows);
    const checks = [
      {
        id: 'source-resolved',
        level: dataset || indicator ? 'PASS' : 'ERROR',
        message: dataset
          ? `结果来源：业务数据集 ${dataset.name}`
          : indicator
            ? `结果来源：指标 ${indicator.name}`
            : '未识别到结果来源',
      },
      {
        id: 'query-contract',
        level: contract ? 'PASS' : 'WARN',
        message: contract
          ? '查询契约和条件账本已保留'
          : '当前结果没有查询契约元数据',
      },
      {
        id: 'time-window',
        level: semanticParse?.dateInfo?.startDate
          && semanticParse?.dateInfo?.endDate
          ? 'PASS'
          : 'INFO',
        message: semanticParse?.dateInfo
          ? `时间范围：${semanticParse.dateInfo.startDate ?? '-'} 至 ${semanticParse.dateInfo.endDate ?? '-'}`
          : '结果未声明时间范围',
      },
      {
        id: 'result-shape',
        level: hasResult && data.rows.length > 0 ? 'PASS' : 'WARN',
        message: hasResult
          ? `返回 ${data.rows.length} 行、${data.columns?.length ?? 0} 列`
          : '未读取到结构化结果',
      },
    ];
    for (const item of guidance) {
      const extracted = String(item.guidance)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[-*]\s+|^\d+[.)、]\s+/.test(line))
        .map((line) => line.replace(/^[-*]\s+|^\d+[.)、]\s+/, '').trim())
        .filter(Boolean)
        .slice(0, 4);
      for (const check of extracted) {
        checks.push({
          id: `${item.code}:${checks.length + 1}`,
          level: 'INFO',
          sourceSkill: item.code,
          message: check,
        });
      }
    }
    const status = checks.some((check) => check.level === 'ERROR')
      ? 'FAILED'
      : checks.some((check) => check.level === 'WARN')
        ? 'WARNING'
        : 'PASS';
    return {
      phase: 'POST_EXECUTE',
      status,
      question,
      skillCount: guidance.length,
      guidance,
      checks,
    };
  }

  filterTools(toolDefinitions, skills) {
    const enabledTools = new Set(
      (skills ?? [])
        .filter((skill) => skill.kind === 'TOOL' && skill.toolName)
        .map((skill) => skill.toolName),
    );
    for (const requiredTool of REQUIRED_TOOLS) {
      enabledTools.add(requiredTool);
    }
    return (toolDefinitions ?? []).filter(
      (definition) => enabledTools.has(definition.function?.name),
    );
  }

  resolveToolSkill(skills, toolName) {
    const target = TOOL_SKILL_ALIASES[toolName] ?? toolName;
    return (skills ?? []).find(
      (skill) => skill.kind === 'TOOL' && skill.toolName === target,
    ) ?? null;
  }
}

export { REQUIRED_TOOLS, TOOL_SKILL_ALIASES };
