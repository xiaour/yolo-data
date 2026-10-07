#!/usr/bin/env node
// One-command environment bootstrap (see README「快速开始」).
//
//   1. checks the Node.js floor
//   2. installs dependencies, including the mysql2 driver used by
//      MySQL/Doris data sources
//   3. creates .env from .env.example when it is missing
//   4. verifies that mysql2 actually loads
//
// Dependency-free on purpose so it can run before `npm install`.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 5;

const ok = (message) => console.log(`  \u2713 ${message}`);
const info = (message) => console.log(`  \u2026 ${message}`);
const warn = (message) => console.log(`  ! ${message}`);

function abort(message) {
  console.error(`\n\u2716 ${message}`);
  process.exit(1);
}

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const supported = major > MIN_NODE_MAJOR
    || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
  if (!supported) {
    abort(`需要 Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}，当前为 ${process.versions.node}`);
  }
  ok(`Node.js ${process.versions.node}`);
}

function installDependencies() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  info('安装依赖（含 MySQL/Doris 驱动 mysql2）');
  const result = spawnSync(npm, ['install'], { cwd: projectRoot, stdio: 'inherit' });
  if (result.error) {
    abort(`无法执行 npm install：${result.error.message}`);
  }
  if (result.status !== 0) {
    abort('npm install 失败，请检查网络或 npm registry 配置后重试');
  }
  ok('依赖已安装');
}

function ensureEnvFile() {
  const envPath = path.join(projectRoot, '.env');
  const examplePath = path.join(projectRoot, '.env.example');
  if (fs.existsSync(envPath)) {
    ok('.env 已存在（保持不变）');
    return;
  }
  if (!fs.existsSync(examplePath)) {
    warn('未找到 .env.example，跳过配置文件生成');
    return;
  }
  fs.copyFileSync(examplePath, envPath);
  ok('已从 .env.example 生成 .env（请按需填写密钥）');
}

async function verifyMysqlDriver() {
  try {
    const mysql = await import('mysql2/promise');
    if (typeof mysql.default?.createConnection !== 'function') {
      throw new Error('createConnection 不可用');
    }
    ok('mysql2 驱动可用（MySQL/Doris 数据源就绪）');
  } catch (error) {
    abort(
      `mysql2 驱动加载失败：${error.message}\n`
      + '  请手动执行：npm install mysql2',
    );
  }
}

// Python 沙箱是代码执行与本地文件分析的运行时依赖。这里做三件事：
// 选出一个真正能跑的解释器、把它写回 .env 的 PYTHON_BIN、缺 pandas/openpyxl 时告警。
function readEnvValue(envPath, key) {
  if (!fs.existsSync(envPath)) {
    return null;
  }
  const match = fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .map((line) => line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`)))
    .find(Boolean);
  return match ? match[1].trim() : null;
}

function writeEnvValue(envPath, key, value) {
  const text = fs.readFileSync(envPath, 'utf8');
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  const next = pattern.test(text)
    ? text.replace(pattern, line)
    : `${text.replace(/\n*$/, '\n')}${line}\n`;
  fs.writeFileSync(envPath, next, 'utf8');
}

function canRunPython(bin) {
  const result = spawnSync(bin, ['-c', 'print(1)'], { encoding: 'utf8', stdio: 'ignore' });
  return result.status === 0;
}

function resolvePythonRuntime() {
  const envPath = path.join(projectRoot, '.env');
  const configured = process.env.PYTHON_BIN || readEnvValue(envPath, 'PYTHON_BIN');
  const candidates = [...new Set([configured, 'python3', 'python'].filter(Boolean))];
  const usable = candidates.find(canRunPython);
  if (!usable) {
    warn('未找到可用的 Python 解释器：代码执行与本地文件分析不可用（其余功能不受影响）');
    return;
  }
  ok(`Python 解释器可用（${usable}）`);
  if (configured !== usable && fs.existsSync(envPath)) {
    writeEnvValue(envPath, 'PYTHON_BIN', usable);
    warn(`.env 的 PYTHON_BIN 已从「${configured ?? '未设置'}」修正为「${usable}」`);
  }
  const dependencies = spawnSync(usable, ['-c', 'import pandas, openpyxl'], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
  if (dependencies.status !== 0) {
    warn(`缺少 pandas/openpyxl：.xlsx 相关的代码执行会失败，可运行 ${usable} -m pip install pandas openpyxl`);
  } else {
    ok('pandas / openpyxl 可用（Excel 代码执行就绪）');
  }
}

console.log('\nYOLO Data 环境初始化\n');
assertNodeVersion();
installDependencies();
ensureEnvFile();
await verifyMysqlDriver();
resolvePythonRuntime();

console.log('\n完成。下一步：');
console.log('  1. 编辑 .env 配置 DEEPSEEK_API_KEY / SUPERSONIC_* / Doris 连接');
console.log('  2. npm run dev   然后打开 http://localhost:8088/\n');
