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

import { installDependencies, verifyMysqlDriver } from './setup-dependencies.mjs';
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

function ensureConfigFile() {
  const confPath = resolveConfPath(projectRoot);
  if (confPath) {
    ok(`${path.basename(confPath)} 已就绪（配置面）`);
    return confPath;
  }
  warn('未找到 yolo-conf.yaml：平台将只使用代码内置默认值与环境变量');
  return null;
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
installDependencies({ projectRoot, info, abort, ok });
const confPath = ensureConfigFile();
await verifyMysqlDriver({ ok, abort });
setupPythonRuntime(confPath);

console.log('\n完成。下一步：');
console.log('  1. 编辑 yolo-conf.yaml 配置模型密钥、指标平台、Doris 连接（机密建议用环境变量覆盖）');
console.log('  2. npm run dev   然后打开 http://localhost:8088/\n');
