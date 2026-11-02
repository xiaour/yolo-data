import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function findPortOwners(port) {
  if (process.platform === 'win32') {
    const script = [
      `$port = ${Number(port)}`,
      '$owners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)',
      'foreach ($owner in $owners) {',
      '  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $owner" -ErrorAction SilentlyContinue',
      '  if ($proc) { Write-Output (ConvertTo-Json -InputObject @{ pid = [int]$owner; commandLine = [string]$proc.CommandLine; processName = [string]$proc.Name } -Compress) }',
      '}',
    ].join('; ');
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script,
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const output = stdout.trim().replace(/^\uFEFF/, '');
    if (!output) return [];
    return (output.startsWith('[') ? JSON.parse(output) : [JSON.parse(output)]);
  }

  const { stdout } = await execFileAsync('lsof', [
    '-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN',
  ], { maxBuffer: 1024 * 1024 }).catch((error) => {
    if (error.code === 1) return { stdout: '' };
    throw error;
  });
  const pids = [...new Set(stdout.split(/\s+/).filter(Boolean))];
  const owners = [];
  for (const pid of pids) {
    const { stdout: commandLine } = await execFileAsync('ps', ['-p', pid, '-o', 'args=']);
    owners.push({ pid: Number(pid), commandLine: commandLine.trim() });
  }
  return owners;
}

