import { callPlatformDatabase } from './platformDatabaseAccess.js';
import { buildPlanningAudit, buildQueryResultValidation } from './skillAudits.js';
import { extractSkillGuidance, SkillAdapter } from './skillAdapter.js';
import {
  CORE_SKILL_DEFINITIONS,
  CORE_RESOLVER_NAMES,
  createCoreSkillResolverRegistry,
} from './coreSkills.js';

const REQUIRED_TOOLS = [
  'search_indicators',
  'get_indicator',
  'compile_query_contract',
  'execute_query_contract',
  'list_workspace_artifacts',
  'transform_workspace_artifact',
  'execute_analysis_code',
  'search_user_memory',
  'request_clarification',
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
  constructor(database, { skillDirectories = [], coreResolvers = null } = {}) {
    this.database = database;
    this.adapter = new SkillAdapter({
      directories: skillDirectories,
    });
    this.lastSync = null;
    this.coreResolvers = coreResolvers ?? createCoreSkillResolverRegistry();
  }

  async refreshExternalSkills() {
    const discovered = this.adapter.discover();
    if (discovered.roots.length === 0) {
      const persisted = this.database.isAsyncPlatformStore
        ? await this.database.listSkillsAsync()
        : this.listSkills();
      this.lastSync = {
        syncedAt: new Date().toISOString(),
        count: persisted.filter((skill) => skill.source === 'SKILL_MD').length,
        roots: [],
        configuredRoots: discovered.configuredRoots,
        warnings: discovered.warnings,
        skipped: true,
      };
      return this.lastSync;
    }
    const count = this.database.isAsyncPlatformStore
      ? await this.database.skillRepository.syncExternalSkills(discovered.skills)
      : await this.database.syncExternalSkills(discovered.skills);
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
    const persisted = this.database.listSkills();
    const known = new Set(CORE_SKILL_DEFINITIONS
      .filter((skill) => this.database.getSkill(skill.code))
      .map((skill) => skill.code));
    return [
      ...CORE_SKILL_DEFINITIONS
        .filter((skill) => !known.has(skill.code))
        .map((skill) => ({
          ...skill,
          source: 'BUILTIN',
          status: 1,
        })),
      ...persisted,
    ];
  }

  async listSkillsAsync() {
    const persisted = await this.database.listSkillsAsync();
    const storedCore = await Promise.all(CORE_SKILL_DEFINITIONS.map((skill) =>
      callPlatformDatabase(this.database, 'getSkillAsync', 'getSkill', skill.code)));
    const known = new Set(storedCore.filter(Boolean).map((skill) => skill.code));
    return [
      ...CORE_SKILL_DEFINITIONS.filter((skill) => !known.has(skill.code)).map((skill) => ({
        ...skill, source: 'BUILTIN', status: 1,
      })),
      ...persisted,
    ];
  }

  async listForThemeAsync(theme) {
    return normalizeSkillCodes(theme?.skillCodes ?? [], await this.listSkillsAsync());
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
        ['SKILL_MD', 'UPLOAD'].includes(String(skill.source ?? '').toUpperCase())
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

  async buildPhaseInstructionsAsync(skills, phase) {
    const normalizedPhase = String(phase ?? '').toUpperCase();
    const selected = (skills ?? []).filter((skill) => (
      ['SKILL_MD', 'UPLOAD'].includes(String(skill.source ?? '').toUpperCase())
      && (skill.phaseTags ?? []).map(String).map((item) => item.toUpperCase())
        .includes(normalizedPhase)
    ));
    return Promise.all(selected.map(async (skill) => {
      const full = this.database.getSkillAsync
        ? (await this.database.getSkillAsync(skill.code) ?? skill)
        : this.database.isAsyncPlatformStore
          ? skill
          : (this.database.getSkill(skill.code) ?? skill);
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
    })).then((items) => items.filter((item) => item.guidance));
  }

  auditPlanningContext({
    skills,
    question,
    theme,
    businessDatasets = [],
    primaryBusinessDatasetId = null,
  }) {
    return this.buildPlanningAudit({
      skills,
      question,
      theme,
      businessDatasets,
      primaryBusinessDatasetId,
    }, this.buildPhaseInstructions(skills, 'PRE_PLAN'));
  }

  async auditPlanningContextAsync(args) {
    const guidance = await this.buildPhaseInstructionsAsync(args.skills, 'PRE_PLAN');
    return this.buildPlanningAudit(args, guidance);
  }

  buildPlanningAudit(args, guidance) {
    return buildPlanningAudit(args, guidance);
  }

  validateQueryResult({
    skills,
    question,
    semanticParse,
    dataset,
    indicator,
    data,
  }) {
    return this.buildQueryResultValidation({
      question,
      semanticParse,
      dataset,
      indicator,
      data,
    }, this.buildPhaseInstructions(skills, 'POST_EXECUTE'));
  }

  async validateQueryResultAsync(args) {
    const guidance = await this.buildPhaseInstructionsAsync(args.skills, 'POST_EXECUTE');
    return this.buildQueryResultValidation(args, guidance);
  }

  buildQueryResultValidation(args, guidance) {
    return buildQueryResultValidation(args, guidance);
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

  registerCoreResolver(name, resolver) {
    this.coreResolvers.register(name, resolver);
    return this;
  }

  unregisterCoreResolver(name) {
    this.coreResolvers.unregister(name);
  }

  resolveCoreSkill(name, context = {}, skills = []) {
    const definition = CORE_SKILL_DEFINITIONS.find(
      (skill) => skill.resolverName === String(name),
    );
    if (!definition || !CORE_RESOLVER_NAMES.has(String(name))) {
      return null;
    }
    const selected = (skills ?? []).find((skill) => (
      skill.code === definition.code
      && skill.status !== 0
      && skill.enabled !== false
      && (
        String(skill.source ?? 'BUILTIN').toUpperCase() === 'BUILTIN'
        || (
          String(skill.source).toUpperCase() === 'SKILL_MD'
          && String(skill.category).toUpperCase() === 'CORE'
          && String(skill.kind).toUpperCase() === 'RESOLVER'
          && skill.metadata?.resolverName === definition.resolverName
        )
      )
    ));
    if (!selected) {
      return null;
    }
    return this.coreResolvers.resolve(name, context);
  }
}

export { REQUIRED_TOOLS, TOOL_SKILL_ALIASES };
