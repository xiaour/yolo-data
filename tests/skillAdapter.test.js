import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import { parseSkillDocument } from '../src/skillAdapter.js';
import { SkillRegistry } from '../src/skills.js';

function createSkillDirectory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-skills-'));
  const skillRoot = path.join(root, 'data-audit');
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), [
    '---',
    'name: data-audit',
    'description: >',
    '  Audit data meaning before analysis and validate final claims.',
    'version: 1.0.0',
    '---',
    '',
    '# Data Audit',
    '',
    '## Audit the data',
    '- Verify row grain before grouping.',
    '- Verify time semantics and source of truth.',
    '',
    '## Validate the result',
    '- Recompute the headline number independently.',
    '- Report unsupported claims as uncertain.',
  ].join('\n'));
  return root;
}

test('standard SKILL.md metadata and phase guidance are parsed', () => {
  const root = createSkillDirectory();
  const filePath = path.join(root, 'data-audit', 'SKILL.md');
  const skill = parseSkillDocument(fs.readFileSync(filePath, 'utf8'), filePath);

  assert.equal(skill.code, 'external:data-audit');
  assert.equal(skill.name, 'data-audit');
  assert.match(skill.description, /Audit data meaning/);
  assert.ok(skill.phaseTags.includes('PRE_PLAN'));
  assert.ok(skill.phaseTags.includes('POST_EXECUTE'));
  assert.match(skill.phaseGuides.PRE_PLAN, /row grain/);
  assert.match(skill.phaseGuides.POST_EXECUTE, /Recompute/);
});

test('skill registry syncs SKILL.md files and binds them per theme', () => {
  const root = createSkillDirectory();
  const database = new PlatformDatabase(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-db-')), 'test.db'),
  );
  const registry = new SkillRegistry(database, { skillDirectories: [root] });
  const sync = registry.refreshExternalSkills();
  const skill = registry.listSkills().find(
    (item) => item.code === 'external:data-audit',
  );
  assert.equal(sync.count, 1);
  assert.ok(skill);
  assert.equal(skill.source, 'SKILL_MD');

  const theme = database.listThemes()[0];
  database.saveTheme({
    ...theme,
    skillCodes: [...(theme.skillCodes ?? []), skill.code],
  }, theme.id);
  const enabled = registry.listForTheme(database.getTheme(theme.id));
  assert.ok(enabled.some((item) => item.code === skill.code));

  const audit = registry.auditPlanningContext({
    skills: enabled,
    question: '本月销售额是多少',
    theme: database.getTheme(theme.id),
    businessDatasets: [],
  });
  assert.equal(audit.skillCount, 1);
  assert.ok(audit.checks.some((check) => /row grain|source of truth/i.test(
    check.message,
  )));

  const validation = registry.validateQueryResult({
    skills: enabled,
    question: '本月销售额是多少',
    semanticParse: {
      dateInfo: { startDate: '2026-09-01', endDate: '2026-09-21' },
      queryContract: { dimensions: [], filters: [] },
    },
    dataset: { id: 1, name: '销售数据集' },
    data: { rows: [{ sale_amt: 1 }], columns: [{ bizName: 'sale_amt' }] },
  });
  assert.equal(validation.skillCount, 1);
  assert.notEqual(validation.status, 'FAILED');
  assert.ok(validation.checks.some((check) => check.sourceSkill === skill.code));
});

test('missing frontmatter falls back to the skill directory name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-skills-bad-'));
  const skillRoot = path.join(root, 'broken');
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Missing frontmatter\n');
  const database = new PlatformDatabase(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-db-bad-')), 'test.db'),
  );
  const registry = new SkillRegistry(database, { skillDirectories: [root] });
  const sync = registry.refreshExternalSkills();

  assert.equal(sync.count, 1);
  assert.ok(registry.listSkills().some(
    (skill) => skill.code === 'external:broken',
  ));
});
