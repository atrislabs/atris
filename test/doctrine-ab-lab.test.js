const { test } = require('node:test');
const assert = require('node:assert');
const { isRun, isMaskedRun, measure } = require('../scripts/member-lab-evidence');
const { fisher } = require('../scripts/doctrine-ab');

test('a test run piped into a filter loses its exit code', () => {
  assert.equal(isMaskedRun('node --test test/a.test.js 2>&1 | tail -15'), true);
  assert.equal(isMaskedRun("npm test | grep -E 'pass|fail'"), true);
  assert.equal(isMaskedRun('set -o pipefail; node --test 2>&1 | tail'), false);
  assert.equal(isMaskedRun('node --test a.js 2>&1 | tail -9; echo "exit=${pipestatus[1]}"'), false);
  assert.equal(isMaskedRun('node --test a.js 2>&1 | tail -9; echo "exit=$?"'), true);
  assert.equal(isMaskedRun('node --test test/a.test.js; echo "exit=$?"'), false);
  assert.equal(isMaskedRun('node tool.js bogus || echo failed'), false);
  assert.equal(isMaskedRun('git log | head'), false);
});

test('only runs of the project code count as real runs', () => {
  assert.equal(isRun('node tool.js add widget'), true);
  assert.equal(isRun('cat tool.js && ls'), false);
  assert.equal(isRun('atris mission status x | head'), false);
});

test('an edit after the last run is caught', () => {
  const sessions = [{ finalText: 'done', steps: [
    { kind: 'bash', cmd: 'node --test' },
    { kind: 'edit', file: '/w/tool.js' },
    { kind: 'edit', file: '/w/atris/logs/x.md' },
  ] }];
  const m = measure(sessions);
  assert.equal(m.ran_before_first_edit, true);
  assert.equal(m.edited_after_last_run, true);
  assert.equal(m.source_edits, 1);
});

test('fisher exact matches the textbook 2x2', () => {
  assert.ok(Math.abs(fisher(3, 1, 1, 3) - 0.4857) < 1e-3);
  assert.equal(fisher(5, 5, 5, 5), 1);
});
