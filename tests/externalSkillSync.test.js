import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlatformDatabase } from '../src/database.js';
import { SkillRepository } from '../src/skillRepository.js';

function testDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'external-skill-sync-'));
  const database = new PlatformDatabase(path.join(directory, 'test.db'));
  t.after(async () => {
    await database.closeAsync();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return database;
}

test('external skill synchronization preserves builtins while replacing the external snapshot', async t => {
  const database = testDatabase(t);
  const repository = new SkillRepository(database.db, database);
  const builtin = database.getSkill('yolo-core-skill.business_vocabulary');
  assert.ok(builtin);
  await repository.syncExternalSkills([
    { code: builtin.code, name: 'must not overwrite', instruction: 'untrusted' },
    { code: ' external:one ', name: ' First ', content: 'v1', metadata: { version: 1 }, phaseTags: ['PLAN'] },
  ]);
  assert.deepEqual(database.getSkill(builtin.code), builtin);
  const first = await repository.getSkillAsync('external:one');
  assert.equal(first.name, 'First');
  assert.deepEqual(first.metadata, { version: 1 });
  assert.deepEqual(first.phaseTags, ['PLAN']);
  await repository.syncExternalSkills([{ code: 'external:two', name: 'Second', content: 'v2' }]);
  assert.equal(await repository.getSkillAsync('external:one'), null);
  assert.equal((await repository.getSkillAsync('external:two')).content, 'v2');
  await repository.syncExternalSkills([]);
  assert.equal(await repository.getSkillAsync('external:two'), null);
  assert.deepEqual(database.getSkill(builtin.code), builtin);
});

test('external skill synchronization rolls back earlier writes when a later row fails', async t => {
  const database = testDatabase(t);
  const repository = new SkillRepository(database.db, database);
  await repository.syncExternalSkills([{ code: 'external:one', name: 'Original', content: 'v1' }]);
  database.db.exec(`CREATE TRIGGER reject_skill BEFORE INSERT ON skills
    WHEN NEW.code = 'external:fail' BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END`);
  await assert.rejects(repository.syncExternalSkills([
    { code: 'external:one', name: 'Changed', content: 'v2' },
    { code: 'external:fail', name: 'Rejected' },
  ]), /fixture rejection/);
  assert.equal((await repository.getSkillAsync('external:one')).name, 'Original');
  assert.equal((await repository.getSkillAsync('external:one')).content, 'v1');
  assert.equal(await repository.getSkillAsync('external:fail'), null);
});
