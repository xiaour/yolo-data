export function dockerPersistedStateScript(dataDirectory, sourcePassword) {
  return `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import crypto from 'node:crypto';
    import { DatabaseSync } from 'node:sqlite';
    import { DatasourceCrypto } from './src/datasourceCrypto.js';
    const directory = ${JSON.stringify(dataDirectory)};
    const keyFilePath = directory + '/.datasource-key';
    const database = new DatabaseSync(directory + '/platform.db', { readOnly: true });
    try {
      const row = database.prepare('SELECT encrypted_password AS password FROM data_sources WHERE code = ?').get('docker_smoke');
      assert.ok(row);
      assert.equal(new DatasourceCrypto({ keyFilePath }).decrypt(row.password), ${JSON.stringify(sourcePassword)});
      console.log(JSON.stringify({ ciphertext: row.password,
        keyHash: crypto.createHash('sha256').update(fs.readFileSync(keyFilePath)).digest('hex') }));
    } finally { database.close(); }
  `;
}
