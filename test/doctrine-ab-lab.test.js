const { test } = require('node:test');
const assert = require('node:assert');
const { isRun, isMaskedRun, segEditTarget, measure } = require('../scripts/member-lab-evidence');
const { fisher } = require('../scripts/doctrine-ab');

test('a test run piped into a filter loses its exit code', () => {
  assert.equal(isMaskedRun('node --test test/a.test.js 2>&1 | tail -15'), true);
  assert.equal(isMaskedRun("npm test | grep -E 'pass|fail'"), true);
  assert.equal(isMaskedRun('set -o pipefail; node --test 2>&1 | tail'), false);
  assert.equal(isMaskedRun('node --test a.js 2>&1 | tail -9; echo "exit=${pipestatus[1]}"'), false);
  // zsh has no PIPESTATUS, so this one still prints nothing useful
  assert.equal(isMaskedRun('node --test a.js 2>&1 | tail -9; echo "exit=${PIPESTATUS[0]}"'), true);
  assert.equal(isMaskedRun('node --test a.js 2>&1 | tail -9; echo "exit=$?"'), true);
  assert.equal(isMaskedRun('node --test test/a.test.js; echo "exit=$?"'), false);
  assert.equal(isMaskedRun('node tool.js bogus || echo failed'), false);
  assert.equal(isMaskedRun('git log | head'), false);
});

test('only runs of the project code count as real runs', () => {
  assert.equal(isRun('node tool.js add widget'), true);
  assert.equal(isRun('cat tool.js && ls'), false);
  assert.equal(isRun('atris mission status x | head'), false);
  assert.equal(isRun("cat > notes.md <<'EOF'\nrun node --test later\nEOF"), false);
});

test('shell writes count as edits, scratch output does not', () => {
  assert.equal(segEditTarget("sed -i '' 's/a/b/' store.js"), 'store.js');
  assert.equal(segEditTarget('cat > tool.js'), 'tool.js');
  assert.equal(segEditTarget('node --test > /tmp/out.log 2>&1'), '');
  assert.equal(segEditTarget('node tool.js 2>/dev/null'), '');
  assert.equal(segEditTarget('git log > history.txt'), '');
});

test('edit order and the last run are read per step', () => {
  const sessions = [{ finalText: 'done', commands: [], steps: [
    { kind: 'run', masked: true },
    { kind: 'edit', file: '/w/tool.js' },
    { kind: 'run', masked: false },
    { kind: 'edit', file: '/w/tool.js' },
    { kind: 'edit', file: '/w/atris/logs/x.md' },
  ] }];
  const m = measure(sessions);
  assert.equal(m.ran_before_first_edit, true);
  assert.equal(m.edited_after_last_run, true);
  assert.equal(m.last_run_masked, false);
  assert.equal(m.masked_runs, 1);
  assert.equal(m.source_edits, 2);
});

test('fisher exact matches the textbook 2x2', () => {
  assert.ok(Math.abs(fisher(3, 1, 1, 3) - 0.4857) < 1e-3);
  assert.equal(fisher(5, 5, 5, 5), 1);
});
