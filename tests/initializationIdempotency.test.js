import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApplication } from '../src/application.js';
import { PlatformDatabase } from '../src/database.js';

const temporaryDirectory = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('platform bootstrap never rewrites existing records or restores removed bindings', (t) => {
  const directory = temporaryDirectory('yolo-bootstrap-once-');
  const file = path.join(directory, 'platform.db');
  const first = new PlatformDatabase(file, { seedBootstrapResources: true });

  const admin = first.getUserByUsername('admin');
  const theme = first.listThemes().find((item) => item.name === '经营总览');
  const model = first.listModels().find((item) => item.name === 'DeepSeek 默认模型');
  const source = first.getDataSourceByCode('bootstrap_business_doris');
  const dataset = first.getBusinessDatasetByCode('bootstrap_sales_performance_template');
  const skill = first.getSkill('dimension_breakdown');

  first.saveUser({ ...admin, displayName: '自定义管理员', attributes: { owner: true } }, admin.id);
  first.saveTheme({
    ...theme,
    description: '自定义主题说明',
    llmConfig: { temperature: 0.37, maxToolRounds: 9 },
    skillCodes: [],
  }, theme.id);
  first.saveModel({ ...model, baseUrl: 'https://custom.example/v1', timeoutMs: 12345 }, model.id);
  first.saveDataSource({ ...source, host: 'custom-db.example', status: 1 }, source.id);
  first.saveBusinessDataset({
    ...dataset,
    description: '自定义数据集说明',
    config: { ...dataset.config, maxRows: 77 },
  }, dataset.id);
  first.db.prepare(`UPDATE skills SET name = ?, instruction = ? WHERE code = ?`).run(
    '自定义维度分析', '保留管理员维护的内容', skill.code,
  );
  first.db.prepare(
    'DELETE FROM user_theme_grants WHERE user_id = ? AND theme_id = ?',
  ).run(admin.id, theme.id);
  first.close();

  const reopened = new PlatformDatabase(file, { seedBootstrapResources: true });
  t.after(async () => {
    await reopened.closeAsync();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.deepEqual(reopened.bootstrapState, { createdUserIds: [], createdThemeIds: [] });
  assert.equal(reopened.getUser(admin.id).displayName, '自定义管理员');
  assert.equal(reopened.getTheme(theme.id).description, '自定义主题说明');
  assert.deepEqual(reopened.getTheme(theme.id).llmConfig, { temperature: 0.37, maxToolRounds: 9 });
  assert.deepEqual(reopened.getTheme(theme.id).skillCodes, []);
  assert.equal(reopened.getModel(model.id).baseUrl, 'https://custom.example/v1');
  assert.equal(reopened.getDataSource(source.id).host, 'custom-db.example');
  assert.equal(reopened.getBusinessDataset(dataset.id).config.maxRows, 77);
  assert.equal(reopened.getSkill(skill.code).instruction, '保留管理员维护的内容');
  assert.equal(reopened.db.prepare(`SELECT COUNT(*) AS count FROM user_theme_grants
    WHERE user_id = ? AND theme_id = ?`).get(admin.id, theme.id).count, 0);
});

test('application startup imports only missing external skills and preserves theme configuration', async (t) => {
  const directory = temporaryDirectory('yolo-application-once-');
  const skillRoot = path.join(directory, 'skills', 'audit');
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), `---
name: startup-audit
code: startup-audit
description: initial description
---
initial instruction
`);
  const config = {
    projectRoot: directory,
    dbPath: path.join(directory, 'platform.db'),
    port: 0,
    skillDirectories: [path.dirname(skillRoot)],
    deepseek: { apiKey: '', model: '', baseUrl: '', timeoutMs: 5000, maxToolRounds: 3 },
    bootstrapDatasource: { enabled: false, demo: { enabled: false } },
  };

  const first = await createApplication(config);
  await first.init();
  const theme = first.database.listThemes()[0];
  first.database.saveTheme({
    ...theme,
    llmConfig: { temperature: 0.42, maxToolRounds: 7 },
    skillCodes: [],
  }, theme.id);
  first.database.db.prepare(`UPDATE skills SET description = ?, instruction = ?
    WHERE code = ?`).run('管理员说明', '管理员指令', 'external:startup-audit');
  first.memoryMaintenance.stop();
  await first.database.closeAsync();

  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), `---
name: startup-audit
code: startup-audit
description: changed on disk
---
changed instruction
`);
  const second = await createApplication(config);
  t.after(async () => {
    second.memoryMaintenance.stop();
    await second.database.closeAsync();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await second.init();

  const persistedTheme = second.database.getTheme(theme.id);
  const persistedSkill = second.database.getSkill('external:startup-audit');
  assert.deepEqual(persistedTheme.llmConfig, { temperature: 0.42, maxToolRounds: 7 });
  assert.deepEqual(persistedTheme.skillCodes, []);
  assert.equal(persistedSkill.description, '管理员说明');
  assert.equal(persistedSkill.instruction, '管理员指令');
});
