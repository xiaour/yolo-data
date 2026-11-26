import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Python 沙箱解释器的兜底候选。Windows 装的是 `python`，macOS/Linux 上是 `python3`；
// 必须和 yolo-conf.yaml 的 `codeExecution.pythonBin` 注释及 scripts/setup.mjs 探测顺序一致，避免缺少别名时失败。
export const DEFAULT_PYTHON_BIN = process.platform === 'win32' ? 'python' : 'python3';

export function projectPythonBin() {
  const relativePath = process.platform === 'win32'
    ? path.join('.venv', 'Scripts', 'python.exe')
    : path.join('.venv', 'bin', 'python');
  const candidate = path.join(projectRoot, relativePath);
  return fs.existsSync(candidate) ? candidate : DEFAULT_PYTHON_BIN;
}

export function projectCodexBin() {
  const relativePath = process.platform === 'win32'
    ? path.join('node_modules', '.bin', 'codex.cmd')
    : path.join('node_modules', '.bin', 'codex');
  const candidate = path.join(projectRoot, relativePath);
  return fs.existsSync(candidate)
    ? candidate
    : (process.platform === 'win32' ? 'codex.cmd' : 'codex');
}
