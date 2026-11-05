#!/usr/bin/env node
// Semantic eval runner.
//
//   L1 = contract-level, deterministic, no model or datasource.
//   L2 = result-level, deterministic: simulates the resolved query plan on a
//        fixture table and verifies rowCount / columns / totals.
//   L3 = answer-level, LLM-as-Judge: runs reflectOnAnswer on a golden
//        (question, answer, result) triple. The Judge is OPTIONAL — when no
//        model is configured the deterministic ①/② checks still run and the
//        Judge portion is reported as `judgePending` (never faked as a pass).
//
// The module exports runLevel / runAllLevels so the /api/eval endpoint can
// invoke it in-process; the CLI at the bottom keeps the `npm run eval` flow.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileEvalCase } from '../eval/fixtures.mjs';
import { simulateContractResult, checkL2Result } from '../eval/resultSim.mjs';
import { runL3Case } from '../eval/answerCase.mjs';
import { runMultiTurnSuite } from '../eval/multiTurnCases.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evalRoot = path.join(projectRoot, 'eval');
const baselinePath = path.join(evalRoot, 'baseline.json');
const reportPath = path.join(evalRoot, 'report.json');

// Allowed levels (L2/L3 are no longer stubs).
const SUPPORTED_LEVELS = ['L1', 'L2', 'L3', 'L4'];

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

// ---------------------------------------------------------------------------
// L1
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// L2
// ---------------------------------------------------------------------------

function runL2Case(evalCase) {
  const checks = [];
  // Optional contract-level assertion (reuses the L1 compiler).
  if (evalCase.expect) {
    const result = compileEvalCase(evalCase);
    for (const [key, expected] of Object.entries(evalCase.expect)) {
      const actual = getPath(result, key);
      checks.push({
        assertion: `contract.${key}`,
        ok: JSON.stringify(actual) === JSON.stringify(expected),
        expected,
        actual,
      });
    }
  }
  const simulated = simulateContractResult({
    draft: evalCase.draft,
    fixtureRows: evalCase.fixtureRows ?? [],
  });
  checks.push(...checkL2Result(evalCase.expectResult ?? {}, simulated));
  return {
    id: evalCase.id,
    description: evalCase.description ?? '',
    passed: checks.every((check) => check.ok),
    checks,
    simulated,
  };
}

// ---------------------------------------------------------------------------
// baseline / diff
// ---------------------------------------------------------------------------

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

function diffBaseline(baseline, level, results) {
  const prev = baseline?.levels?.[level]?.cases;
  if (!prev) {
    return { improved: [], regressed: [], new_cases: results.map((item) => item.id) };
  }
  const improved = [];
  const regressed = [];
  const newCases = [];
  for (const result of results) {
    const previous = prev[result.id];
    if (previous === undefined) {
      newCases.push(result.id);
    } else if (previous !== result.passed) {
      (result.passed ? improved : regressed).push(result.id);
    }
  }
  return { improved, regressed, new_cases: newCases };
}

// ---------------------------------------------------------------------------
// level runner
// ---------------------------------------------------------------------------

export async function runLevel(level, { judge = null } = {}) {
  const cases = loadCases(level);
  let results;
  let gateBlockDistribution = {};
  if (level === 'L1') {
    results = cases.map(({ case: evalCase }) => runL1Case(evalCase));
    for (const result of results) {
      for (const gateId of result.blockingGateIds) {
        gateBlockDistribution[gateId] = (gateBlockDistribution[gateId] ?? 0) + 1;
      }
    }
  } else if (level === 'L2') {
    results = cases.map(({ case: evalCase }) => runL2Case(evalCase));
  } else if (level === 'L3') {
    results = [];
    for (const { case: evalCase } of cases) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await runL3Case(evalCase, judge));
    }
  } else if (level === 'L4') {
    results = runMultiTurnSuite();
  } else {
    throw new Error(`unsupported eval level: ${level}`);
  }

  const passed = results.filter((result) => result.passed).length;
  const baseline = readBaseline();
  const baselineDiff = diffBaseline(baseline, level, results);
  const judgePending = results.filter((result) => result.judgePending).length;
  // Legacy judgeRan follows reflection.judgeUsed; it does not imply a usable verdict.
  const judgeRan = results.filter((result) => result.judgeAvailable).length;
  const judgeAttempted = results.filter((result) => result.judgeAttempted).length;
  const judgeCompleted = results.filter((result) => result.judgeCompleted).length;

  return {
    level,
    totals: {
      cases: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length > 0 ? passed / results.length : 0,
      judgePending,
      judgeRan,
      judgeAttempted,
      judgeCompleted,
    },
    gateBlockDistribution,
    results,
    baselineDiff,
  };
}

export async function runAllLevels({ judge = null } = {}) {
  const levels = {};
  let totalCases = 0;
  let totalPassed = 0;
  for (const level of SUPPORTED_LEVELS) {
    // eslint-disable-next-line no-await-in-loop
    const report = await runLevel(level, { judge });
    levels[level] = report;
    totalCases += report.totals.cases;
    totalPassed += report.totals.passed;
  }
  return {
    generatedAt: new Date().toISOString(),
    levels,
    overall: {
      cases: totalCases,
      passed: totalPassed,
      failed: totalCases - totalPassed,
      accuracy: totalCases > 0 ? totalPassed / totalCases : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// optional judge from env (so L3 can run with a real model in CI/prod)
// ---------------------------------------------------------------------------

async function buildJudgeFromEnv() {
  const baseUrl = process.env.EVAL_JUDGE_BASE_URL;
  const apiKey = process.env.EVAL_JUDGE_API_KEY;
  if (!baseUrl || !apiKey) {
    return null;
  }
  const { ResponsesApiHarness } = await import('../src/harness.js');
  const harness = new ResponsesApiHarness({
    baseUrl,
    apiKey,
    model: process.env.EVAL_JUDGE_MODEL ?? 'deepseek-chat',
    temperature: 0,
  });
  return async (systemText, userText) => {
    const res = await harness.run({
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: userText },
      ],
      tools: [],
      executeTool: async () => ({ content: '' }),
      metadata: { judge: true, callType: 'EVAL_L3_JUDGE' },
    });
    return res?.content ?? '';
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const levelArg = args.find((arg) => arg.startsWith('--level'));
  const requested = levelArg
    ? (levelArg.split('=')[1] ?? args[args.indexOf(levelArg) + 1] ?? 'ALL')
    : 'ALL';
  const updateBaseline = args.includes('--update-baseline');

  const judge = await buildJudgeFromEnv();
  const levelsToRun = requested === 'ALL'
    ? SUPPORTED_LEVELS
    : [String(requested).toUpperCase()];

  const allReport = await runAllLevels({ judge });
  // Keep only the requested levels in the persisted report to match CLI scope.
  const report = {
    generatedAt: allReport.generatedAt,
    levels: Object.fromEntries(
      Object.entries(allReport.levels).filter(([lvl]) => levelsToRun.includes(lvl)),
    ),
    overall: {
      cases: levelsToRun.reduce((sum, lvl) => sum + allReport.levels[lvl].totals.cases, 0),
      passed: levelsToRun.reduce((sum, lvl) => sum + allReport.levels[lvl].totals.passed, 0),
      failed: 0,
      accuracy: 0,
    },
  };
  report.overall.failed = report.overall.cases - report.overall.passed;
  report.overall.accuracy = report.overall.cases > 0
    ? report.overall.passed / report.overall.cases
    : 0;

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  for (const lvl of levelsToRun) {
    const r = allReport.levels[lvl];
    console.log(`[eval] ${lvl}: ${r.totals.passed}/${r.totals.cases} passed (pass rate ${(r.totals.passRate * 100).toFixed(1)}%)`
      + (r.totals.judgePending ? `, judgePending=${r.totals.judgePending}` : '')
      + (r.totals.judgeAttempted ? `, judgeAttempted=${r.totals.judgeAttempted}` : '')
      + (r.totals.judgeCompleted ? `, judgeCompleted=${r.totals.judgeCompleted}` : ''));
    if (Object.keys(r.gateBlockDistribution).length > 0) {
      console.log(`[eval] ${lvl} gate blocks:`, JSON.stringify(r.gateBlockDistribution));
    }
    if (r.baselineDiff.improved.length > 0) {
      console.log(`[eval] ${lvl} improved vs baseline:`, r.baselineDiff.improved.join(', '));
    }
    if (r.baselineDiff.regressed.length > 0) {
      console.log(`[eval] ${lvl} REGRESSED vs baseline:`, r.baselineDiff.regressed.join(', '));
    }
    for (const result of r.results.filter((item) => !item.passed)) {
      console.log(`[eval] FAIL ${lvl}-${result.id}`);
      for (const check of result.checks.filter((item) => !item.ok)) {
        console.log(`        ${check.assertion}: expected ${JSON.stringify(check.expected)} got ${JSON.stringify(check.actual)}`);
      }
    }
  }
  console.log(`[eval] overall fixture pass rate: ${(report.overall.accuracy * 100).toFixed(1)}% (${report.overall.passed}/${report.overall.cases})`);
  console.log(`[eval] report -> ${path.relative(projectRoot, reportPath)}`);

  if (updateBaseline) {
    const levels = {};
    for (const lvl of SUPPORTED_LEVELS) {
      levels[lvl] = {
        cases: Object.fromEntries(
          allReport.levels[lvl].results.map((result) => [result.id, result.passed]),
        ),
      };
    }
    fs.writeFileSync(baselinePath, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      levels,
    }, null, 2)}\n`, 'utf8');
    console.log(`[eval] baseline -> ${path.relative(projectRoot, baselinePath)}`);
  }

  const regressed = levelsToRun.some((lvl) => allReport.levels[lvl].baselineDiff.regressed.length > 0);
  process.exit(report.overall.passed === report.overall.cases && !regressed ? 0 : 1);
}

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('[eval] fatal:', error);
    process.exit(1);
  });
}

export { SUPPORTED_LEVELS };
