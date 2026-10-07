import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PlatformDatabase } from '../src/database.js';
import { SkillRegistry, REQUIRED_TOOLS } from '../src/skills.js';

function createDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metric-ask-skills-'));
  return new PlatformDatabase(path.join(directory, 'test.db'));
}

test('skill registry selects agent instructions and keeps required tools', () => {
  const database = createDatabase();
  const registry = new SkillRegistry(database);
  const theme = database.listThemes().find((item) => item.name === '经营总览');
  const skills = registry.listForTheme({
    ...theme,
    skillCodes: ['trend_analysis'],
  });
  assert.ok(skills.some((skill) => skill.code === 'trend_analysis'));

  const tools = [
    { type: 'function', function: { name: 'search_indicators' } },
    { type: 'function', function: { name: 'get_indicator' } },
    { type: 'function', function: { name: 'compile_query_contract' } },
    { type: 'function', function: { name: 'execute_query_contract' } },
    { type: 'function', function: { name: 'list_workspace_artifacts' } },
    { type: 'function', function: { name: 'transform_workspace_artifact' } },
    { type: 'function', function: { name: 'execute_analysis_code' } },
    { type: 'function', function: { name: 'search_user_memory' } },
    { type: 'function', function: { name: 'unregistered_tool' } },
  ];
  const enabledTools = registry.filterTools(tools, skills);
  assert.deepEqual(
    enabledTools.map((tool) => tool.function.name),
    REQUIRED_TOOLS,
  );
  assert.ok(registry.buildInstructions(skills).some((line) => line.includes('趋势')));
});

test('theme skill assignments can be replaced independently', () => {
  const database = createDatabase();
  const theme = database.listThemes().find((item) => item.name === '财务分析');
  database.replaceThemeSkills(theme.id, [
    'indicator_search',
    'indicator_definition',
    'indicator_query',
    'period_comparison',
  ]);
  assert.deepEqual(database.getTheme(theme.id).skillCodes.sort(), [
    'indicator_definition',
    'indicator_query',
    'indicator_search',
    'period_comparison',
  ]);
});

test('agent model, dataset and example configuration persist on the theme', () => {
  const database = createDatabase();
  const theme = database.listThemes().find((item) => item.name === '经营总览');
  const updated = database.saveTheme({
    ...theme,
    llmConfig: {
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      temperature: 0.2,
      maxToolRounds: 8,
    },
    datasetIds: ['1'],
    semanticValueConfig: {
      enabled: true,
      autoDiscover: false,
      fields: {
        'INDICATOR:2:business_type_name': true,
        'INDICATOR:2:customer_name': false,
      },
    },
    examples: ['近7天销售额趋势'],
  }, theme.id);

  assert.equal(updated.llmConfig.model, 'deepseek-reasoner');
  assert.deepEqual(updated.datasetIds, ['1']);
  assert.equal(updated.semanticValueConfig.autoDiscover, false);
  assert.equal(
    updated.semanticValueConfig.fields['INDICATOR:2:business_type_name'],
    true,
  );
  assert.deepEqual(updated.examples, ['近7天销售额趋势']);
});
