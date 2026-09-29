import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function loadOrCreateKey(filePath, configuredKey) {
  if (configuredKey) {
    return crypto.createHash('sha256').update(String(configuredKey)).digest();
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    const existing = Buffer.from(fs.readFileSync(filePath, 'utf8').trim(), 'base64');
    if (existing.length === 32) {
      return existing;
    }
  }
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(filePath, generated.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  return generated;
}

export class DatasourceCrypto {
  constructor({ keyFilePath, secretKey = '' }) {
    this.key = loadOrCreateKey(keyFilePath, secretKey);
  }

  encrypt(plainText) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(String(plainText ?? ''), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `ENC:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  decrypt(cipherText) {
    const value = String(cipherText ?? '');
    if (!value.startsWith('ENC:')) {
      return value;
    }
    const [, ivText, tagText, encryptedText] = value.split(':');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(ivText, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagText, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedText, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
