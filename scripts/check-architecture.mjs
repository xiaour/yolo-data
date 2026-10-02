#!/usr/bin/env node
// Dependency-free architecture guard (P0-6). Enforces a size ratchet plus a few
// grep-able red lines so the structure cannot silently regress. Baseline lives
// in config/size-baseline.json and is regenerated with `npm run size:baseline`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(projectRoot, 'config', 'size-baseline.json');

const SCAN_ROOTS = ['src', 'public/js', 'scripts'];
const SIZE_WARN = 800;
const SIZE_NEW_LIMIT = 800;
const GROWTH_TOLERANCE = 50;
const EXTENSIONS = new Set(['.js', '.mjs', '.css']);

function listFiles(relativeRoot) {
  const absolute = path.join(projectRoot, relativeRoot);
  if (!fs.existsSync(absolute)) {
    return [];
  }
  const result = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'vendor' || entry.name.startsWith('.')) {
      continue;
    }
    const relative = path.posix.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      result.push(...listFiles(relative));
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      result.push(relative);
    }
  }
  return result;
}

function lineCount(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8').split('\n').length;
}

function readBaseline() {
  if (!fs.existsSync(baselinePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
}

// Red lines from docs/architecture.md + the capability plan.
const FORBIDDEN_PATTERNS = [
  {
    id: 'NO-CACHE-DELETE-OUTSIDE-STORAGE',
    match: /DELETE\s+FROM\s+indicator_cache/i,
    allow: (file) => file === 'src/database.js',
    message: 'indicator_cache must only be mutated by the explicit storage sync path (P0-1).',
  },
  {
    id: 'NO-STAGE-DIRECT-DB',
    match: /from\s+['"][^'"]*database\.js['"]/,
    allow: (file) => !/^(src|public)\/(stages|orchestration\/stages)\//.test(file),
    message: 'workflow stage modules must not import database.js directly; go through repositories/services (P0-6).',
  },
];

function checkPatterns(files) {
  const issues = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(projectRoot, file), 'utf8');
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.match.test(source) && !rule.allow(file)) {
        issues.push({ level: 'error', file, rule: rule.id, message: rule.message });
      }
    }
  }
  return issues;
}

function checkSize(files, baseline) {
  const issues = [];
  const report = [];
  for (const file of files) {
    const lines = lineCount(file);
    report.push({ file, lines });
    const baselineLines = baseline?.[file];
    if (baselineLines === undefined) {
      if (lines > SIZE_NEW_LIMIT) {
        issues.push({
          level: 'error',
          file,
          rule: 'SIZE-NEW-FILE',
          message: `new file has ${lines} lines (> ${SIZE_NEW_LIMIT}); split it or add a justified baseline.`,
        });
      } else if (lines > SIZE_WARN) {
        issues.push({
          level: 'warn',
          file,
          rule: 'SIZE-WARN',
          message: `${lines} lines (> ${SIZE_WARN}).`,
        });
      }
      continue;
    }
    if (lines > baselineLines + GROWTH_TOLERANCE) {
      issues.push({
        level: 'error',
        file,
        rule: 'SIZE-GROWTH',
        message: `grew from ${baselineLines} to ${lines} lines (> +${GROWTH_TOLERANCE}); split instead of growing.`,
      });
    } else if (lines > SIZE_WARN) {
      issues.push({
        level: 'warn',
        file,
        rule: 'SIZE-WARN',
        message: `${lines} lines (> ${SIZE_WARN} baseline ${baselineLines}).`,
      });
    }
  }
  report.sort((left, right) => right.lines - left.lines);
  return { issues, report };
}

export function runChecks() {
  const files = SCAN_ROOTS.flatMap(listFiles).sort();
  const baseline = readBaseline();
  const size = checkSize(files, baseline);
  const patterns = checkPatterns(files);
  return {
    files,
    baseline,
    report: size.report,
    issues: [...size.issues, ...patterns],
  };
}

function toBaseline(report) {
  return Object.fromEntries(
    [...report]
      .sort((left, right) => left.file.localeCompare(right.file))
      .map((entry) => [entry.file, entry.lines]),
  );
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const { report, issues } = runChecks();
  if (process.argv.includes('--baseline')) {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, `${JSON.stringify(toBaseline(report), null, 2)}\n`, 'utf8');
    console.log(`Wrote size baseline with ${report.length} files -> ${path.relative(projectRoot, baselinePath)}`);
    process.exit(0);
  }
  console.log('Largest files:');
  for (const entry of report.slice(0, 12)) {
    console.log(`  ${String(entry.lines).padStart(6)}  ${entry.file}`);
  }
  const warnings = issues.filter((issue) => issue.level === 'warn');
  const errors = issues.filter((issue) => issue.level === 'error');
  for (const issue of issues) {
    console.log(`${issue.level === 'error' ? 'ERROR' : 'WARN '} [${issue.rule}] ${issue.file}: ${issue.message}`);
  }
  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s).`);
  process.exit(errors.length > 0 ? 1 : 0);
}
