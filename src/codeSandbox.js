import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from './analysisProcess.js';

export function resolveSandboxConfig(config = {}, env = process.env) {
  const options = config.codeExecution ?? {};
  return {
    backend: String(options.backend ?? env.SANDBOX_BACKEND ?? 'container').trim().toLowerCase(),
    allowUnsafeInprocess: options.allowUnsafeInprocess === true
      || (options.allowUnsafeInprocess === undefined && env.SANDBOX_ALLOW_UNSAFE_INPROCESS === 'true'),
    sandboxImage: String(options.image ?? env.SANDBOX_IMAGE ?? 'yolo-data-sandbox:local').trim(),
    seccompProfile: String(options.seccompProfile ?? env.SANDBOX_SECCOMP ?? '').trim(),
  };
}

export function assertSandboxAllowed(options) {
  if (!['container', 'podman', 'inprocess'].includes(options.backend)) {
    throw Object.assign(new Error('未知的代码执行后端：' + options.backend), { code: 'SANDBOX_BACKEND_INVALID' });
  }
  if (options.backend === 'inprocess' && !options.allowUnsafeInprocess) {
    throw Object.assign(new Error('宿主机 Python 执行已禁用。请使用 container/podman 隔离；可信本地开发才可显式设置 SANDBOX_ALLOW_UNSAFE_INPROCESS=true。'), {
      code: 'UNSAFE_SANDBOX_DISABLED',
    });
  }
}

export async function runContainerAnalysis({ runRoot, timeoutSeconds, env, sandbox, run = runProcess }) {
  const runtime = sandbox.backend === 'podman' ? 'podman' : 'docker';
  const name = 'yolo-analysis-' + crypto.randomUUID();
  const outputDir = path.join(runRoot, 'output');
  // Only the output directory is writable by the unprivileged container user.
  fs.chmodSync(outputDir, 0o777);
  const args = [
    'run', '--rm', '--name', name, '--pull', 'never',
    '--user', '65534:65534', '--network', 'none', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--memory', '512m', '--memory-swap', '512m', '--cpus', '1',
    '--pids-limit', '128', '--shm-size', '64m', '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--volume', runRoot + ':/work:ro',
    '--volume', outputDir + ':/work/output:rw',
    '--workdir', '/work', '--env', 'HOME=/tmp', '--env', 'MPLBACKEND=Agg',
  ];
  // Leave Docker's default seccomp policy enabled unless an operator supplies one.
  if (sandbox.seccompProfile) args.push('--security-opt', 'seccomp=' + sandbox.seccompProfile);
  args.push(sandbox.sandboxImage, 'python', '-I', '-B', 'run.py');
  const result = await run({ command: runtime, args, cwd: runRoot, env, timeoutSeconds });
  if (result.timedOut) {
    // Killing the CLI does not stop the container. Remove this exact run by name.
    const cleanup = await run({ command: runtime, args: ['rm', '--force', name],
      cwd: runRoot, env, timeoutSeconds: 10 });
    if (cleanup.exitCode !== 0 && !/no such (?:container|object)/i.test(cleanup.stderr)) {
      throw Object.assign(new Error('分析已超时，但容器清理失败：' + cleanup.stderr), { code: 'SANDBOX_CLEANUP_FAILED' });
    }
  }
  if (result.exitCode !== 0 && !result.timedOut) {
    result.stderr = '隔离分析执行失败；请确认本机 Docker/Podman 可用并已构建沙箱镜像 '
      + sandbox.sandboxImage + '。' + '\n' + result.stderr;
  }
  return result;
}
