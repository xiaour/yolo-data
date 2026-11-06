import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { canRunPython, requirementsDigest } from '../scripts/python-runtime-checks.mjs';
import { verifyMysqlDriver } from '../scripts/setup-dependencies.mjs';

test('runtime probe distinguishes a runnable command, a nonzero exit and a missing executable', () => {
  assert.equal(canRunPython(process.execPath, ['-e', 'process.exit(0)']), true);
  assert.equal(canRunPython(process.execPath, ['-e', 'process.exit(4)']), false);
  assert.equal(canRunPython(path.join(os.tmpdir(), 'missing-yolo-python', 'python')), false);
});

test('requirements stamp changes with dependency file contents', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-requirements-check-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'requirements.txt');
  fs.writeFileSync(file, 'pandas==2.3.2\n');
  const before = requirementsDigest(file);
  assert.match(before, /^[a-f0-9]{64}$/);
  assert.equal(requirementsDigest(file), before);
  fs.appendFileSync(file, 'openpyxl==3.1.5\n');
  assert.notEqual(requirementsDigest(file), before);
});

test('setup driver verification loads the installed mysql2 API', async () => {
  const messages = [];
  await verifyMysqlDriver({ ok: message => messages.push(message), abort: message => assert.fail(message) });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /mysql2/);
});

test('schema generation keeps MySQL long-text fields and bounded composite index columns', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-schema-generation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'mysql-init.sql');
  const script = fileURLToPath(new URL('../scripts/generate-mysql-init.mjs', import.meta.url));
  execFileSync(process.execPath, [script, output], { stdio: 'pipe', timeout: 30000 });
  const sql = fs.readFileSync(output, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS platform_settings/);
  assert.match(sql, /value_json LONGTEXT/);
  assert.match(sql, /source_type VARCHAR\(64\)/);
  assert.match(sql, /source_id VARCHAR\(128\)/);
  assert.match(sql, /BIGINT AUTO_INCREMENT PRIMARY KEY/);
  assert.doesNotMatch(sql, /\bAUTOINCREMENT\b/);
  assert.match(sql, /SET FOREIGN_KEY_CHECKS = 1;/);
});
