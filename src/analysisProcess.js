import { spawn } from 'node:child_process';

const MAX_CAPTURE_BYTES = 1024 * 1024;

// Count bytes, not chunks: a long-running program may emit thousands of chunks.
export function createOutputCapture(maxBytes = MAX_CAPTURE_BYTES) {
  const chunks = [];
  let bytes = 0;
  return {
    push(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const kept = data.subarray(0, Math.max(0, maxBytes - bytes));
      if (kept.length) chunks.push(kept);
      bytes += kept.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

export function runProcess({ command, args, cwd, env, timeoutSeconds }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdout = createOutputCapture();
    const stderr = createOutputCapture();
    const child = spawn(command, args, {
      cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const finish = (exitCode, timedOut, message = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, timedOut, durationMs: Date.now() - startedAt,
        stdout: stdout.text(), stderr: [stderr.text(), message].filter(Boolean).join('\n') });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null, true, 'Analysis code timed out after ' + timeoutSeconds + ' seconds.');
    }, timeoutSeconds * 1000);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => finish(null, false, error.message));
    child.on('close', code => finish(code, false));
  });
}
