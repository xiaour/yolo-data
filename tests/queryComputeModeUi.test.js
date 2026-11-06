import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('query UI leaves runtime selection to YOLO', () => {
  const querySource = fs.readFileSync(new URL('../public/js/pages/query.js', import.meta.url), 'utf8');
  const runtimeSource = fs.readFileSync(new URL('../public/js/core/runtime.js', import.meta.url), 'utf8');
  assert.doesNotMatch(querySource, /data-compute-mode|computeMode:/);
  assert.doesNotMatch(runtimeSource, /computeMode\s*:/);
});
