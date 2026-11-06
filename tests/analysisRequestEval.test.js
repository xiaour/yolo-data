import assert from 'node:assert/strict';
import test from 'node:test';

import { ANALYSIS_REQUEST_CASES } from '../eval/analysisRequestCases.mjs';
import { inferAnalysisRequest } from '../src/analysisRequest.js';

for (const evalCase of ANALYSIS_REQUEST_CASES) {
  test(`analysis request eval: ${evalCase.id}`, () => {
    const actual = inferAnalysisRequest(evalCase.question, evalCase.context);
    assert.equal(actual.taskKind, evalCase.expect.taskKind);
    assert.equal(actual.requiresReport, evalCase.expect.requiresReport);
    if (evalCase.expect.interactionKind) {
      assert.equal(actual.interactionKind, evalCase.expect.interactionKind);
    }
    if (evalCase.expect.purposes) {
      assert.deepEqual(actual.purposes, evalCase.expect.purposes);
    }
  });
}
