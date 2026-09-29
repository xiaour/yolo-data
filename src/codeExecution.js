import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BLOCKED_IMPORTS = [
  'ctypes',
  'ftplib',
  'http',
  'multiprocessing',
  'pty',
  'requests',
  'selenium',
  'socket',
  'subprocess',
  'urllib',
  'webbrowser',
];
const BLOCKED_PATTERNS = [
  /\bsubprocess\b/i,
  /\bsocket\b/i,
  /\brequests\b/i,
  /\burllib\b/i,
  /\bhttp\.client\b/i,
  /\bctypes\b/i,
  /\bmultiprocessing\b/i,
  /\bos\.system\b/i,
  /\bos\.popen\b/i,
  /\bos\.startfile\b/i,
  /\bshutil\.rmtree\b/i,
  /(^|[^a-z])[a-z]:[\\/]/i,
  /(?:^|[\\/])\.\.(?:[\\/]|$)/,
];
const TEXT_EXTENSIONS = new Set(['csv', 'json', 'txt', 'md']);
const BINARY_EXTENSIONS = new Set(['xlsx', 'xls', 'png', 'jpg', 'jpeg', 'pdf']);
const ALLOWED_EXTENSIONS = new Set([...TEXT_EXTENSIONS, ...BINARY_EXTENSIONS]);
const MAX_OUTPUT_FILES = 20;
const MAX_OUTPUT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_TOTAL_BYTES = 30 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 1024 * 1024;

function sanitizeFileName(value, fallback = 'artifact') {
  const base = path.basename(String(value ?? '').trim() || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return base.slice(0, 120) || fallback;
}

function extensionForArtifact(artifact) {
  const format = String(
    artifact?.metadata?.format
    ?? artifact?.payload?.format
    ?? artifact?.metadata?.fileType
    ?? '',
  ).toLowerCase();
  if (ALLOWED_EXTENSIONS.has(format)) {
    return format;
  }
  const mimeType = String(artifact?.metadata?.mimeType ?? artifact?.payload?.mimeType ?? '');
  if (mimeType.includes('spreadsheetml')) {
    return 'xlsx';
  }
  if (mimeType.includes('csv')) {
    return 'csv';
  }
  if (mimeType.includes('json')) {
    return 'json';
  }
  return artifact?.artifactType === 'TABLE' ? 'csv' : 'txt';
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function tableToCsv(artifact) {
  const columns = artifact?.payload?.data?.columns ?? [];
  const rows = artifact?.payload?.data?.rows ?? [];
  return [
    columns.map((column) => csvEscape(
      column?.name ?? column?.bizName ?? '',
    )).join(','),
    ...rows.map((row) => columns.map((column) => csvEscape(
      row?.[column?.bizName ?? column?.name],
    )).join(',')),
  ].join('\r\n');
}

function validateCode(code) {
  const source = String(code ?? '');
  if (!source.trim()) {
    throw new Error('analysis code is required');
  }
  if (source.length > 200_000) {
    throw new Error('analysis code is too large');
  }
  const match = BLOCKED_PATTERNS.find((pattern) => pattern.test(source));
  if (match) {
    throw new Error(`analysis code contains blocked operation: ${match}`);
  }
}

function safeEnv(runRoot) {
  const temp = path.join(runRoot, 'tmp');
  fs.mkdirSync(temp, { recursive: true });
  return {
    PATH: process.env.PATH ?? '',
    PATHEXT: process.env.PATHEXT ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    WINDIR: process.env.WINDIR ?? '',
    PYTHONIOENCODING: 'utf-8',
    PYTHONHASHSEED: '0',
    PYTHONDONTWRITEBYTECODE: '1',
    MPLBACKEND: 'Agg',
    HOME: runRoot,
    USERPROFILE: runRoot,
    TEMP: temp,
    TMP: temp,
  };
}

function pythonPrelude() {
  const blocked = JSON.stringify(BLOCKED_IMPORTS);
  return `# Generated safety prelude. Do not edit.
import builtins
import importlib
import os
import pathlib
import sys

RUN_ROOT = pathlib.Path(__file__).resolve().parent
INPUT_DIR = RUN_ROOT / "input"
OUTPUT_DIR = RUN_ROOT / "output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
BLOCKED_IMPORTS = set(${blocked})

try:
    import pandas  # noqa: F401
    import openpyxl  # noqa: F401
except Exception:
    pass

_original_import = builtins.__import__
_original_open = builtins.open
_original_os_open = os.open

def _guard_path(value):
    if not isinstance(value, (str, bytes, os.PathLike)):
        return value
    raw = os.fspath(value)
    candidate = pathlib.Path(raw)
    if not candidate.is_absolute():
        candidate = RUN_ROOT / candidate
    resolved = candidate.resolve()
    if resolved != RUN_ROOT and RUN_ROOT not in resolved.parents:
        raise PermissionError("analysis code cannot access paths outside its run directory")
    return str(resolved)

def _guarded_open(file, mode="r", *args, **kwargs):
    return _original_open(_guard_path(file), mode, *args, **kwargs)

def _guarded_os_open(path, flags, mode=0o777, *args, **kwargs):
    return _original_os_open(_guard_path(path), flags, mode, *args, **kwargs)

builtins.open = _guarded_open
os.open = _guarded_os_open

def _guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = str(name).split(".", 1)[0]
    if root in BLOCKED_IMPORTS:
        raise ImportError("module is blocked in analysis sandbox: " + root)
    return _original_import(name, globals, locals, fromlist, level)

builtins.__import__ = _guarded_import
`;
}

function normalizeTimeout(value) {
  const parsed = Number(value);
  return Math.max(1, Math.min(Number.isFinite(parsed) ? parsed : 60, 120));
}

function listFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const output = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        output.push(fullPath);
      }
    }
  };
  visit(root);
  return output;
}

function captureWriter(buffer) {
  return {
    push(chunk) {
      if (buffer.length >= MAX_CAPTURE_BYTES) {
        return;
      }
      buffer.push(chunk.subarray(0, MAX_CAPTURE_BYTES - buffer.length));
    },
    text() {
      return Buffer.concat(buffer).toString('utf8');
    },
  };
}

function runProcess({ command, args, cwd, env, timeoutSeconds }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdout = captureWriter(stdoutChunks);
    const stderr = captureWriter(stderrChunks);
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve({
        exitCode: null,
        timedOut: true,
        durationMs: Date.now() - startedAt,
        stdout: stdout.text(),
        stderr: `${stderr.text()}\nAnalysis code timed out after ${timeoutSeconds} seconds.`.trim(),
      });
    }, timeoutSeconds * 1000);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        stdout: stdout.text(),
        stderr: error.message,
      });
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        stdout: stdout.text(),
        stderr: stderr.text(),
      });
    });
  });
}

export class CodeExecutionService {
  constructor({ database, workspace, config = {} }) {
    this.database = database;
    this.workspace = workspace;
    this.root = path.resolve(
      config.codeExecutionRoot
        ?? path.join(config.projectRoot ?? process.cwd(), 'data', 'code-runs'),
    );
    this.pythonBin = String(config.pythonBin ?? process.env.PYTHON_BIN ?? 'python');
  }

  materializeArtifact({ artifact, runInputDir, index }) {
    const baseName = sanitizeFileName(
      artifact.title || artifact.id,
      `artifact_${index + 1}`,
    );
    const manifestEntry = {
      artifactId: artifact.id,
      title: artifact.title,
      type: artifact.artifactType,
      files: [],
    };
    if (artifact.artifactType === 'TABLE' || artifact.payload?.data) {
      const csvName = `${index + 1}_${baseName}.csv`;
      const jsonName = `${index + 1}_${baseName}.json`;
      fs.writeFileSync(path.join(runInputDir, csvName), `\ufeff${tableToCsv(artifact)}`, 'utf8');
      fs.writeFileSync(
        path.join(runInputDir, jsonName),
        JSON.stringify(artifact.payload ?? {}, null, 2),
        'utf8',
      );
      manifestEntry.files.push(csvName, jsonName);
      manifestEntry.format = 'csv+json';
      manifestEntry.rowCount = artifact.payload?.data?.rows?.length ?? 0;
      manifestEntry.columnCount = artifact.payload?.data?.columns?.length ?? 0;
      manifestEntry.columns = (artifact.payload?.data?.columns ?? []).map((column) => ({
        name: column?.name ?? column?.bizName ?? '',
        bizName: column?.bizName ?? column?.name ?? '',
        showType: column?.showType ?? column?.type ?? '',
        unit: column?.unit ?? '',
      }));
      return manifestEntry;
    }
    const extension = extensionForArtifact(artifact);
    const fileName = `${index + 1}_${baseName}.${extension}`;
    const payload = artifact.payload ?? {};
    if (payload.encoding === 'base64') {
      fs.writeFileSync(
        path.join(runInputDir, fileName),
        Buffer.from(String(payload.content ?? ''), 'base64'),
      );
    } else {
      fs.writeFileSync(
        path.join(runInputDir, fileName),
        String(payload.content ?? ''),
        'utf8',
      );
    }
    manifestEntry.files.push(fileName);
    manifestEntry.format = extension;
    return manifestEntry;
  }

  importOutputs({
    runRoot,
    userId,
    workspaceId,
    sessionId,
    purpose,
    artifactPrefix = '',
    runId,
    inputArtifactIds = [],
  }) {
    const outputDir = path.join(runRoot, 'output');
    const files = listFiles(outputDir);
    if (files.length > MAX_OUTPUT_FILES) {
      throw new Error(`analysis code produced too many files: ${files.length}`);
    }
    let totalBytes = 0;
    const outputs = [];
    for (const filePath of files) {
      const extension = path.extname(filePath).slice(1).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        continue;
      }
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_OUTPUT_FILE_BYTES) {
        throw new Error(`analysis output is too large: ${path.basename(filePath)}`);
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_OUTPUT_TOTAL_BYTES) {
        throw new Error('analysis outputs exceed the total size limit');
      }
      const relativeName = path.relative(runRoot, filePath).replaceAll('\\', '/');
      const content = TEXT_EXTENSIONS.has(extension)
        ? fs.readFileSync(filePath, 'utf8')
        : fs.readFileSync(filePath).toString('base64');
      const artifact = this.workspace.createFileArtifact({
        workspaceId,
        userId,
        sessionId,
        title: artifactPrefix
          ? `${artifactPrefix} · ${path.basename(filePath)}`
          : path.basename(filePath),
        encoding: TEXT_EXTENSIONS.has(extension) ? 'utf8' : 'base64',
        content,
        format: extension,
        mimeType: extension === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : extension === 'csv'
            ? 'text/csv; charset=utf-8'
            : extension === 'json'
              ? 'application/json; charset=utf-8'
              : 'application/octet-stream',
        purpose,
        runId,
        inputArtifactIds,
        size: stat.size,
      });
      outputs.push({
        artifactId: artifact.id,
        fileName: path.basename(filePath),
        format: extension,
        size: stat.size,
      });
    }
    return outputs;
  }

  async run({
    userId,
    workspaceId,
    sessionId,
    code,
    inputArtifactIds = [],
    outputFiles = [],
    timeoutSeconds = 60,
    purpose = '',
    artifactPrefix = '',
  }) {
    if (!this.workspace) {
      throw new Error('workspace service is not configured');
    }
    validateCode(code);
    const runId = crypto.randomUUID();
    const runRoot = path.join(this.root, String(sessionId ?? 'global'), runId);
    const inputDir = path.join(runRoot, 'input');
    const outputDir = path.join(runRoot, 'output');
    fs.mkdirSync(inputDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    const inputs = [];
    for (const [index, artifactId] of (inputArtifactIds ?? []).entries()) {
      const artifact = this.workspace.getArtifact({
        artifactId: String(artifactId),
        userId,
      });
      inputs.push(this.materializeArtifact({
        artifact,
        runInputDir: inputDir,
        index,
      }));
    }
    fs.writeFileSync(
      path.join(inputDir, 'manifest.json'),
      JSON.stringify({ runId, purpose, inputs }, null, 2),
      'utf8',
    );
    fs.writeFileSync(
      path.join(runRoot, 'run.py'),
      `${pythonPrelude()}\n# User-generated analysis code\n${String(code)}\n`,
      'utf8',
    );

    const timeout = normalizeTimeout(timeoutSeconds);
    const processResult = await runProcess({
      command: this.pythonBin,
      args: ['-I', '-B', 'run.py'],
      cwd: runRoot,
      env: safeEnv(runRoot),
      timeoutSeconds: timeout,
    });
    const outputs = this.importOutputs({
      runRoot,
      userId,
      workspaceId,
      sessionId,
      purpose,
      artifactPrefix,
      runId,
      inputArtifactIds: inputs.map((item) => item.artifactId),
    });
    const codeArtifact = this.workspace.createCodeArtifact({
      workspaceId,
      userId,
      sessionId,
      title: artifactPrefix
        ? `${artifactPrefix} · 分析代码`
        : `代码执行 · ${String(purpose || runId).slice(0, 80)}`,
      code,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      success: processResult.exitCode === 0 && !processResult.timedOut,
      durationMs: processResult.durationMs,
      runId,
      inputArtifacts: inputs,
      outputs,
      purpose,
    });
    return {
      runId,
      codeArtifactId: codeArtifact.id,
      success: processResult.exitCode === 0 && !processResult.timedOut,
      exitCode: processResult.exitCode,
      timedOut: processResult.timedOut,
      durationMs: processResult.durationMs,
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      inputArtifacts: inputs,
      expectedOutputFiles: outputFiles,
      outputs,
      runDirectory: runRoot,
    };
  }
}

export { validateCode };
