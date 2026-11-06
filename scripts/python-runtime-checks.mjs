import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readPythonBin } from './confFileEdit.mjs';

export const VENV_DIRECTORY = '.venv';

export function canRunPython(bin, args = ['-c', 'print(1)']) {
  if (!bin) {
    return false;
  }
  const result = spawnSync(bin, args, { encoding: 'utf8', stdio: 'ignore' });
  return !result.error && result.status === 0;
}

export function venvPythonPath(projectRoot) {
  return process.platform === 'win32'
    ? path.join(projectRoot, VENV_DIRECTORY, 'Scripts', 'python.exe')
    : path.join(projectRoot, VENV_DIRECTORY, 'bin', 'python');
}

export function resolveBasePython(confPath) {
  const configured = process.env.PYTHON_BIN || readPythonBin(confPath);
  const candidates = [
    configured,
    process.platform === 'win32' ? 'python' : 'python3',
    process.platform === 'win32' ? 'py' : 'python',
  ].filter(Boolean);
  return [...new Set(candidates)].find((bin) => canRunPython(bin)) ?? null;
}

export function requirementsDigest(requirementsPath) {
  return createHash('sha256').update(fs.readFileSync(requirementsPath)).digest('hex');
}

export function hasAnalysisDependencies(pythonBin) {
  return canRunPython(pythonBin, ['-c', 'import pandas, openpyxl']);
}

export function pythonVersion(pythonBin) {
  const result = spawnSync(
    pythonBin,
    ['-c', 'import sys; print(sys.version.split()[0])'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return result.status === 0 ? String(result.stdout ?? '').trim() || null : null;
}

export function pythonMeetsMinimum(pythonBin, minimumMajor = 3, minimumMinor = 9) {
  const result = spawnSync(
    pythonBin,
    ['-c', 'import sys; print("%s.%s" % sys.version_info[:2])'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (result.status !== 0) return false;
  const [major, minor] = String(result.stdout ?? '').trim().split('.').map(Number);
  return major > minimumMajor || (major === minimumMajor && minor >= minimumMinor);
}
