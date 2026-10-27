#!/usr/bin/env node
// One-command environment bootstrap (see README「快速开始」).
//
//   1. checks the Node.js floor
//   2. installs dependencies, including the mysql2 driver used by
//      MySQL/Doris data sources
//   3. verifies that the yolo-conf.yaml config surface is present
//   4. verifies that mysql2 actually loads
//
// Dependency-free on purpose so it can run before `npm install`.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePythonAnalysisRuntime } from './python-setup.mjs';
import { resolveConfPath } from './confFileEdit.mjs';
import { loadEnvFile } from '../src/envFile.js';

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
  info('安装依赖（含 MySQL/Doris 驱动 mysql2）');
  // Windows cannot reliably spawn .cmd files directly (Node may return EINVAL).
  // Run npm.cmd through cmd.exe there; keep direct execution on POSIX.
  const command = process.platform === 'win32'
    ? (process.env.ComSpec || 'cmd.exe')
    : 'npm';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm.cmd install']
    : ['install'];
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit' });
  if (result.error) {
    abort(`无法执行 npm install：${result.error.message}`);
  }
  if (result.status !== 0) {
    abort('npm install 失败，请检查网络或 npm registry 配置后重试');
  }
  ok('依赖已安装');
}

function ensureConfigFile() {
  const confPath = resolveConfPath(projectRoot);
  if (confPath) {
    ok(`${path.basename(confPath)} 已就绪（配置面）`);
    return confPath;
  }
  warn('未找到 yolo-conf.yaml：平台将只使用代码内置默认值与环境变量');
  return null;
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

// Python 分析环境是完整安装的一部分：自动创建 .venv 并安装依赖；解释器由应用自动探测，不写回配置文件。
function setupPythonRuntime(confPath) {
  try {
    const runtime = ensurePythonAnalysisRuntime({
      projectRoot,
      confPath,
      onInfo: info,
    });
    ok(`Python 分析环境就绪（${runtime.pythonBin} ${runtime.version ?? ''}）`.trim());
  } catch (error) {
    abort(`Python 分析环境初始化失败：${error.message}`);
  }
}

console.log('\nYOLO Data 环境初始化\n');
loadEnvFile({ projectRoot });
assertNodeVersion();
installDependencies();
const confPath = ensureConfigFile();
await verifyMysqlDriver();
setupPythonRuntime(confPath);

console.log('\n完成。下一步：');
console.log('  1. 编辑 yolo-conf.yaml 配置模型密钥、指标平台、Doris 连接（机密建议用环境变量覆盖）');
console.log('  2. npm run dev   然后打开 http://localhost:8088/\n');
