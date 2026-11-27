import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function installDependencies({ projectRoot, info, abort, ok }) {
  info('安装依赖（含 MySQL/Doris 驱动 mysql2 与 Codex CLI）');
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

export async function verifyMysqlDriver({ ok, abort }) {
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

function runLocalCodex(projectRoot, args, options = {}) {
  const entrypoint = path.join(
    projectRoot,
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js',
  );
  return spawnSync(process.execPath, [entrypoint, ...args], options);
}

export function verifyCodexCli({ projectRoot, ok, abort }) {
  const version = runLocalCodex(['--version'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (version.error || version.status !== 0) {
    const detail = version.error?.message
      || String(version.stderr ?? '').trim()
      || `退出码 ${version.status}`;
    abort(`Codex CLI 安装后无法运行：${detail}`);
  }
  ok(String(version.stdout ?? '').trim() || 'Codex CLI 已安装');
}
