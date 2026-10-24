import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlatformDatabase } from '../src/database.js';
import { SkillRepository } from '../src/skillRepository.js';
import { SkillRegistry } from '../src/skills.js';

const code = 'yolo-core-skill.business_vocabulary';

for (const asyncOnly of [false, true]) {
  test(`disabled core resolver stays disabled with ${asyncOnly ? 'async-only' : 'SQLite'} storage`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-status-'));
    const database = new PlatformDatabase(path.join(directory, 'test.db'));
    t.after(async () => { await database.closeAsync(); fs.rmSync(directory, { recursive: true, force: true }); });
    const repository = new SkillRepository(database.db, database);
    const fail = () => { throw new Error('sync fallback forbidden'); };
    const store = asyncOnly ? {
      isAsyncPlatformStore: true,
      listSkillsAsync: options => repository.listSkillsAsync(options),
      getSkillAsync: target => repository.getSkillAsync(target),
      listSkills: fail, getSkill: fail,
    } : database;
    const registry = new SkillRegistry(store);
    const theme = { skillCodes: [code] };
    assert.ok((await registry.listForThemeAsync(theme)).some(skill => skill.code === code));
    database.db.prepare('UPDATE skills SET status = 0 WHERE code = ?').run(code);
    assert.ok(database.getSkill(code), 'disabled identity remains persisted');
    const selected = await registry.listForThemeAsync(theme);
    assert.equal(selected.some(skill => skill.code === code), false);
    assert.equal(registry.resolveCoreSkill('business_vocabulary', { question: '前5名' }, selected), null);
    database.db.prepare('UPDATE skills SET status = 1 WHERE code = ?').run(code);
    assert.equal(registry.resolveCoreSkill('business_vocabulary', { question: '前5名' },
      await registry.listForThemeAsync(theme)).topN, 5);
    database.db.prepare('DELETE FROM skills WHERE code = ?').run(code);
    const fallback = (await registry.listForThemeAsync(theme)).find(skill => skill.code === code);
    assert.equal(fallback.source, 'BUILTIN');
    assert.equal(registry.resolveCoreSkill('business_vocabulary', { question: '前5名' }, [fallback]).topN, 5);
  });
}

