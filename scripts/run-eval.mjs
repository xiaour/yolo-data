#!/usr/bin/env node
// Semantic eval runner (P0-2). L1 = contract-level, deterministic, no model or
// datasource. L2/L3 (result/expression level) are declared but not yet
// implemented; requesting them prints an explicit notice instead of faking a pass.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileEvalCase } from '../eval/fixtures.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evalRoot = path.join(projectRoot, 'eval');
const baselinePath = path.join(evalRoot, 'baseline.json');
const reportPath = path.join(evalRoot, 'report.json');

function getPath(target, dotted) {
  return String(dotted).split('.').reduce((value, key) => {
    if (value === null || value === undefined) {
      return undefined;
    }
    return value[key];
  }, target);
}

function loadCases(level) {
  const directory = path.join(evalRoot, 'cases', level.toLowerCase());
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs.readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({
      file,
      case: JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')),
    }));
}

function blockingGateIds(result) {
  return [...new Set(
    (result.issues ?? [])
      .filter((issue) => issue.level === 'ERROR' && issue.gateId)
      .map((issue) => issue.gateId),
  )];
}

function runL1Case(evalCase) {
  const result = compileEvalCase(evalCase);
  const checks = [];
  for (const [key, expected] of Object.entries(evalCase.expect ?? {})) {
    if (key === 'gateIds') {
      const actual = blockingGateIds(result);
      const missing = expected.filter((gateId) => !actual.includes(gateId));
      checks.push({
        assertion: 'gateIds',
        ok: missing.length === 0,
        expected,
        actual,
        missing,
      });
      continue;
    }
    const actual = getPath(result, key);
    checks.push({
      assertion: key,
      ok: JSON.stringify(actual) === JSON.stringify(expected),
      expected,
      actual,
    });
  }
  return {
    id: evalCase.id,
    description: evalCase.description ?? '',
    passed: checks.every((check) => check.ok),
    checks,
    blockingGateIds: blockingGateIds(result),
  };
}

function readBaseline() {
  if (!fs.existsSync(baselinePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch {
    return null;
  }
}

function diffBaseline(baseline, results) {
  if (!baseline?.cases) {
    return { improved: [], regressed: [], new_cases: results.map((item) => item.id) };
  }
  const improved = [];
  const regressed = [];
  const newCases = [];
  for (const result of results) {
    const previous = baseline.cases[result.id];
    if (previous === undefined) {
      newCases.push(result.id);
    } else if (previous !== result.passed) {
      (result.passed ? improved : regressed).push(result.id);
    }
  }
  return { improved, regressed, new_cases: newCases };
}

const args = process.argv.slice(2);
const levelArg = args.find((arg) => arg.startsWith('--level'));
const level = (levelArg ? levelArg.split('=')[1] ?? args[args.indexOf(levelArg) + 1] : 'L1')
  ?.toUpperCase() ?? 'L1';

if (level !== 'L1') {
  console.log(`[eval] level ${level} is not implemented yet (tracked as P0-2 L2/L3).`);
  process.exit(0);
}

const cases = loadCases('L1');
const results = cases.map(({ case: evalCase }) => runL1Case(evalCase));

const gateBlockDistribution = {};
for (const result of results) {
  for (const gateId of result.blockingGateIds) {
    gateBlockDistribution[gateId] = (gateBlockDistribution[gateId] ?? 0) + 1;
  }
}

const passed = results.filter((result) => result.passed).length;
const baseline = readBaseline();
const diff = diffBaseline(baseline, results);
const report = {
  generatedAt: new Date().toISOString(),
  level,
  totals: {
    cases: results.length,
    passed,
    failed: results.length - passed,
    contractPassRate: results.length > 0 ? passed / results.length : 0,
  },
  gateBlockDistribution,
  results,
  baselineDiff: diff,
};

fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`[eval] L1 cases: ${passed}/${results.length} passed (contract pass rate ${(report.totals.contractPassRate * 100).toFixed(1)}%)`);
if (Object.keys(gateBlockDistribution).length > 0) {
  console.log('[eval] gate blocks by gateId:', JSON.stringify(gateBlockDistribution));
}
if (diff.improved.length > 0) {
  console.log('[eval] improved vs baseline:', diff.improved.join(', '));
}
if (diff.regressed.length > 0) {
  console.log('[eval] REGRESSED vs baseline:', diff.regressed.join(', '));
}
for (const result of results.filter((item) => !item.passed)) {
  console.log(`[eval] FAIL ${result.id}`);
  for (const check of result.checks.filter((item) => !item.ok)) {
    console.log(`        ${check.assertion}: expected ${JSON.stringify(check.expected)} got ${JSON.stringify(check.actual)}`);
  }
}
console.log(`[eval] report -> ${path.relative(projectRoot, reportPath)}`);

if (args.includes('--update-baseline')) {
  fs.writeFileSync(baselinePath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    cases: Object.fromEntries(results.map((result) => [result.id, result.passed])),
  }, null, 2)}\n`, 'utf8');
  console.log(`[eval] baseline -> ${path.relative(projectRoot, baselinePath)}`);
}

process.exit(passed === results.length && diff.regressed.length === 0 ? 0 : 1);
