import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachGateMetadata,
  getGate,
  listGates,
  summarizeGateIssues,
} from '../src/gateRegistry.js';
import { STAGE_DEFINITIONS } from '../src/workflow.js';

test('gate registry exposes rules by workflow phase', () => {
  const planGates = listGates({ phase: 'PLAN' }).map((gate) => gate.id);
  assert.ok(planGates.includes('CONTRACT-001'));
  assert.ok(planGates.includes('CONTRACT-004'));
  assert.ok(planGates.includes('CONTRACT-006'));
  assert.equal(getGate('SQL-001').owner, 'businessDatasets.js');
});

test('gate registry decorates issues with owner and blocking metadata', () => {
  const issues = attachGateMetadata([
    {
      level: 'ERROR',
      code: 'FILTER_THRESHOLD_NOT_BOUND',
      message: 'missing threshold',
    },
    {
      level: 'WARN',
      code: 'RESULT_TRUNCATED',
      message: 'truncated',
    },
  ]);

  assert.equal(issues[0].gateId, 'CONTRACT-006');
  assert.equal(issues[0].gatePhase, 'PLAN');
  assert.equal(issues[0].gateOwner, 'queryContractCompiler.js');
  assert.equal(issues[0].blocking, true);
  assert.equal(issues[1].gateId, 'SQL-005');
  assert.equal(issues[1].blocking, false);
});

test('workflow stages advertise their registered gates', () => {
  const plan = STAGE_DEFINITIONS.find((stage) => stage.code === 'PLAN');
  const execute = STAGE_DEFINITIONS.find((stage) => stage.code === 'EXECUTE');

  assert.ok(plan.gateIds.includes('CONTRACT-001'));
  assert.ok(execute.gateIds.includes('SQL-001'));
  assert.ok(execute.gateIds.includes('SQL-002'));
});

test('gate summary counts blocking errors by phase', () => {
  const summary = summarizeGateIssues([
    {
      level: 'ERROR',
      code: 'TIME_GRAIN_NOT_RESOLVED',
      message: 'missing time grain',
    },
    {
      level: 'ERROR',
      code: 'FILTER_RULE_NOT_TRACEABLE',
      message: 'untraceable filter',
    },
  ]);

  assert.equal(summary.errors, 2);
  assert.equal(summary.blocking, 2);
  assert.equal(summary.byPhase.PLAN, 2);
});
