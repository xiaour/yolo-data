#!/usr/bin/env node
// 平台数据库配置助手：供 start.sh 在启动前检查/补齐平台库连接信息。
//
// 用法：
//   node scripts/platform-db-setup.mjs probe          检查配置是否完整，必要时测试连通性
//   node scripts/platform-db-setup.mjs test           用当前配置做一次连接测试
//   node scripts/platform-db-setup.mjs save           把 PLATFORM_DB_* 环境变量写回 yolo-conf.yaml
//
// probe 退出码：
//   0  可直接启动（sqlite，或 mysql 配置完整且可连通）
//   10 mysql 配置不完整（缺地址/库名/账号/口令）
//   20 mysql 配置完整但连不上
//
// 配置优先级与 src/configFile.js 一致：非空环境变量覆盖 yolo-conf.yaml。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { loadEnvFile } from '../src/envFile.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const confPath = path.resolve(projectRoot, 'yolo-conf.yaml');
loadEnvFile({ projectRoot });

function readConf() {
  try {
    return parse(fs.readFileSync(confPath, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

function pick(envKey, fallback) {
  const fromEnv = String(process.env[envKey] ?? '').trim();
  if (fromEnv) return fromEnv;
  return String(fallback ?? '').trim();
}

export function resolvePlatformDb(conf = readConf()) {
  const block = conf.platformDatabase ?? {};
  const mysql = block.mysql ?? {};
  const backend = (pick('PLATFORM_DB_BACKEND', block.backend) || 'sqlite').toLowerCase();
  return {
    backend,
    host: pick('PLATFORM_DB_HOST', mysql.host),
    port: pick('PLATFORM_DB_PORT', mysql.port) || '3306',
    database: pick('PLATFORM_DB_NAME', mysql.database),
    user: pick('PLATFORM_DB_USER', mysql.user),
    password: pick('PLATFORM_DB_PASSWORD', mysql.password),
  };
}

export function missingFields(db) {
  const missing = [];
  if (!db.host) missing.push('地址');
  if (!db.database) missing.push('库名');
  if (!db.user) missing.push('账号');
  if (!db.password) missing.push('密码');
  return missing;
}

async function testConnection(db) {
  const mysql = (await import('mysql2/promise')).default;
  const hardTimeout = (ms) => new Promise((_, reject) => {
    // unref：超时后不因为该定时器拖住进程退出
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(`连接超时（${ms}ms）`), { code: 'ETIMEDOUT' }));
    }, ms);
    timer.unref?.();
  });
  const conn = await Promise.race([
    mysql.createConnection({
      host: db.host,
      port: Number(db.port) || 3306,
      user: db.user,
      password: db.password,
      database: db.database,
      connectTimeout: 8000,
    }),
    hardTimeout(12_000),
  ]);
  try {
    await conn.query('SELECT 1');
  } finally {
    await conn.end().catch(() => {});
  }
}

function describe(db) {
  return `${db.user}@${db.host}:${db.port}/${db.database}`;
}

async function probe() {
  const db = resolvePlatformDb();
  console.log(`backend=${db.backend}`);
  if (db.backend !== 'mysql') {
    console.log('平台库使用本地 SQLite，无需配置数据库连接。');
    return 0;
  }
  const missing = missingFields(db);
  if (missing.length > 0) {
    console.log(`平台库为 MySQL，但缺少：${missing.join('、')}`);
    return 10;
  }
  try {
    await testConnection(db);
    console.log(`平台库连接正常：${describe(db)}`);
    return 0;
  } catch (error) {
    console.log(`平台库连接失败：${describe(db)} — ${error.code || error.message}`);
    return 20;
  }
}

async function test() {
  const db = resolvePlatformDb();
  if (db.backend !== 'mysql') {
    console.log('当前不是 MySQL 平台库，无需测试。');
    return 0;
  }
  try {
    await testConnection(db);
    console.log(`连接成功：${describe(db)}`);
    return 0;
  } catch (error) {
    console.error(`连接失败：${error.code || error.message}`);
    return 1;
  }
}

// 行内改写，保留注释与其它配置不动。
function save() {
  const db = resolvePlatformDb();
  if (db.backend !== 'mysql') {
    console.error('save 仅用于 MySQL 平台库。');
    return 1;
  }
  const lines = fs.readFileSync(confPath, 'utf8').split('\n');
  const blockStart = lines.findIndex((line) => /^platformDatabase:\s*$/.test(line));
  if (blockStart === -1) {
    console.error('yolo-conf.yaml 中未找到 platformDatabase 配置块。');
    return 1;
  }
  let blockEnd = lines.length;
  for (let i = blockStart + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i]) && !lines[i].startsWith('#')) { blockEnd = i; break; }
  }
  const mysqlStart = lines.findIndex((line, i) => i > blockStart && i < blockEnd && /^\s{2}mysql:\s*$/.test(line));
  if (mysqlStart === -1) {
    console.error('platformDatabase 下未找到 mysql 配置块。');
    return 1;
  }
  let mysqlEnd = blockEnd;
  for (let i = mysqlStart + 1; i < blockEnd; i += 1) {
    if (/^\s{0,3}\S/.test(lines[i]) && !/^\s*#/.test(lines[i])) { mysqlEnd = i; break; }
  }

  const quote = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
  const desired = [
    ['host', quote(db.host)],
    ['port', String(Number(db.port) || 3306)],
    ['database', quote(db.database)],
    ['user', quote(db.user)],
    ['password', quote(db.password)],
  ];

  for (const [key, value] of desired) {
    const idx = lines.findIndex((line, i) => i > mysqlStart && i < mysqlEnd && new RegExp(`^\\s{4}${key}:`).test(line));
    if (idx === -1) {
      lines.splice(mysqlStart + 1, 0, `    ${key}: ${value}`);
      mysqlEnd += 1;
    } else {
      lines[idx] = `    ${key}: ${value}`;
    }
  }

  const backendIdx = lines.findIndex((line, i) => i > blockStart && i < blockEnd && /^\s{2}backend:/.test(line));
  if (backendIdx === -1) {
    lines.splice(blockStart + 1, 0, '  backend: mysql');
  } else {
    lines[backendIdx] = '  backend: mysql';
  }

  fs.writeFileSync(confPath, lines.join('\n'));
  console.log(`已写入 yolo-conf.yaml：${describe(db)}`);
  return 0;
}

const mode = process.argv[2];
if (mode === 'probe') {
  // 显式退出：mysql2 失败后可能残留句柄，会把进程拖住十几秒
  process.exit(await probe());
} else if (mode === 'test') {
  process.exit(await test());
} else if (mode === 'save') {
  process.exit(save());
} else {
  console.error('用法：node scripts/platform-db-setup.mjs <probe|test|save>');
  process.exit(2);
}
