import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findPortOwners } from './devProcessOwners.mjs';
import { isProjectServer, assertProjectServerOwners } from './devProcessIdentity.mjs';

const execFileAsync = promisify(execFile);

async function inspectExistingService({ host, port }) {
  try {
    const response = await fetch(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return { running: false, occupied: true };
    const body = await response.json();
    return { running: body?.status === 'ok', occupied: true };
  } catch {
    return { running: false, occupied: false };
  }
}

async function stopProjectServers(owners, config) {
  const { port } = config;
  const ownServers = assertProjectServerOwners(owners, config);
  if (ownServers.length === 0) return;
  console.log(`正在停止本项目占用端口 ${port} 的服务（PID ${ownServers.map((owner) => owner.pid).join(', ')}）……`);
  for (const owner of ownServers) {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill.exe', ['/PID', String(owner.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(owner.pid, 'SIGTERM');
    }
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const remaining = await findPortOwners(port);
    if (remaining.length === 0) return;
    if (remaining.some((owner) => !isProjectServer(owner, config))) {
      throw new Error(`端口 ${port} 在停止旧服务后仍被其他进程占用。`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`等待本项目旧服务释放端口 ${port} 超时。`);
}

export async function prepareDevPort(config) {
  const { port } = config;
  const owners = await findPortOwners(port);
  if (owners.length > 0) {
    await stopProjectServers(owners, config);
  } else {
    const existingService = await inspectExistingService(config);
    if (existingService.occupied) {
      throw new Error(`端口 ${port} 已被占用，但无法确认所属进程。为安全起见未终止，请设置 PORT 使用其他端口。`);
    }
  }
}
