import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyConfigFile } from '../src/configFile.js';
import { loadConfig } from '../src/config.js';
import { DatasourceCrypto } from '../src/datasourceCrypto.js';
import { dockerEnvironmentArgs } from './fixtures/dockerEnvironment.js';
import { dockerPersistedStateScript } from './fixtures/dockerPersistedState.js';

test('compose defaults to session auth on the loopback interface', () => {
  const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');

  assert.match(compose, /AUTH_MODE:\s*\$\{AUTH_MODE:-session\}/);
  assert.match(compose, /HOST_BIND:-127\.0\.0\.1/);
  assert.doesNotMatch(compose, /AUTH_MODE:\s*dev/);
});

test('Docker persisted-state probe reads and closes a real SQLite database', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-docker-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourcePassword = 'disposable-datasource-password';
  const cipher = new DatasourceCrypto({ keyFilePath: path.join(directory, '.datasource-key') });
  const ciphertext = cipher.encrypt(sourcePassword);
  const database = new DatabaseSync(path.join(directory, 'platform.db'));
  try {
    database.exec('CREATE TABLE data_sources (code TEXT, encrypted_password TEXT)');
    database.prepare('INSERT INTO data_sources VALUES (?, ?)').run('docker_smoke', ciphertext);
  } finally { database.close(); }
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    dockerPersistedStateScript(directory, sourcePassword)], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
  });
  const state = JSON.parse(output);
  assert.equal(state.ciphertext, ciphertext);
  assert.match(state.keyHash, /^[a-f0-9]{64}$/);
});

test('Docker acceptance environment overrides packaged database and demo settings', () => {
  for (const password of ['docker-acceptance-password', 'different-bootstrap-password']) {
    const args = dockerEnvironmentArgs(password);
    const target = Object.fromEntries(args.filter((_, index) => index % 2 === 1)
      .map(value => { const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)]; }));
    applyConfigFile({ filePath: new URL('../yolo-conf.yaml', import.meta.url), target });
    const config = loadConfig(target);
    assert.equal(config.platformDatabase.backend, 'sqlite');
    assert.equal(config.platformDatabase.path, '/app/data/platform.db');
    assert.equal(config.bootstrapDatasource.enabled, false);
    assert.equal(config.bootstrapDatasource.demo.enabled, false);
    assert.equal(config.authMode, 'session');
    assert.equal(target.DEFAULT_USER_PASSWORD, password);
  }
});

test('Docker acceptance boots with packaged configuration and a fresh encryption key', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-docker-boot-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const args = dockerEnvironmentArgs('docker-acceptance-password');
  const environment = Object.fromEntries(args.filter((_, index) => index % 2 === 1)
    .map(value => { const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)]; }));
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { loadConfig } from './src/config.js';
    import { createApplication } from './src/application.js';
    globalThis.fetch = () => { throw new Error('Docker acceptance must not call an external API'); };
    const config = loadConfig();
    config.datasourceSecretKeyPath = path.join(path.dirname(config.dbPath), '.datasource-key');
    const application = await createApplication(config);
    try {
      await application.init();
      assert.equal(config.platformDatabase.seedResources, false);
      assert.equal(config.deepseek.apiKey, 'docker-acceptance-unused');
      assert.equal(config.deepseek.baseUrl, 'http://127.0.0.1:9/v1');
      assert.deepEqual(await application.businessDatasets.listDataSourcesAsync(), []);
      assert.equal((await application.currentHealth()).status, 'ok');
    } finally {
      application.memoryMaintenance.stop();
      await application.database.closeAsync();
    }
  `], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, ...environment,
      PLATFORM_DB_PATH: path.join(directory, 'platform.db'),
      YOLO_CONF_FILE: fileURLToPath(new URL('../yolo-conf.yaml', import.meta.url)),
    },
  });
});
