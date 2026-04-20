const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { runTaskOnce } = require('../commands/autopilot');
const { verifyRubric } = require('../commands/verify');

// Build an isolated temp atris workspace with a TODO.md carrying one endgame
// task whose Verify field is customizable per-case. Return cwd so the test
// can drive runTaskOnce against it.
function setupFixture({ verify, extraSetup } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verify-test-'));
  const atrisDir = path.join(cwd, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'TODO.md'),
`# TODO.md

## Endgame

**Slug:** falsifiability-fixture
**Picked:** 2026-04-19
**Done when:** the fixture demonstrates the gate
**Source:** test fixture

## Backlog

- **T1:** Fixture task [endgame] [execute]
  **Files:** stub.txt
  **Exit:** fixture exit
  **Verify:** ${verify}
  **After:** none

## In Progress

## Completed
`);
  // Every fixture needs a lessons.md for writeLesson to append into.
  fs.writeFileSync(path.join(atrisDir, 'lessons.md'), '# lessons\n\n');
  if (extraSetup) extraSetup(cwd);
  return cwd;
}

function cleanup(cwd) {
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
}

// Stub out plan/do/review phase execution so the test doesn't spawn claude -p.
// runTaskOnce calls executePhaseDetailed internally; we monkey-patch via an
// env var that the module honors (adding a thin hook is the minimal change).
// Instead, we simply test the halt paths which never reach phases: those are
// triggered BEFORE executePhaseDetailed runs, so stubs aren't needed.

test('trivial Verify (true) halts with verify-not-falsifiable', () => {
  const cwd = setupFixture({ verify: 'true' });
  try {
    const result = runTaskOnce(
      { task: 'Fixture task', kind: 'endgame', files: [] },
      { cwd, verbose: false }
    );
    assert.strictEqual(result.outcome, 'halted');
    assert.strictEqual(result.reason, 'verify-not-falsifiable');
    const lessons = fs.readFileSync(path.join(cwd, 'atris', 'lessons.md'), 'utf8');
    assert.match(lessons, /verify-not-falsifiable/);
  } finally {
    cleanup(cwd);
  }
});

test('trivial Verify (echo ok) halts with verify-not-falsifiable', () => {
  const cwd = setupFixture({ verify: 'echo ok' });
  try {
    const result = runTaskOnce(
      { task: 'Fixture task', kind: 'endgame', files: [] },
      { cwd, verbose: false }
    );
    assert.strictEqual(result.outcome, 'halted');
    assert.strictEqual(result.reason, 'verify-not-falsifiable');
  } finally {
    cleanup(cwd);
  }
});

test('non-falsifiable Verify via test -f on existing file halts', () => {
  const cwd = setupFixture({
    verify: 'test -f already-there.txt',
    extraSetup: (dir) => fs.writeFileSync(path.join(dir, 'already-there.txt'), 'exists\n'),
  });
  try {
    const result = runTaskOnce(
      { task: 'Fixture task', kind: 'endgame', files: [] },
      { cwd, verbose: false }
    );
    assert.strictEqual(result.outcome, 'halted');
    assert.strictEqual(result.reason, 'verify-not-falsifiable');
  } finally {
    cleanup(cwd);
  }
});

test('falsifiable Verify (test -f missing file) would proceed past gate', () => {
  // We can't run full plan/do/review in tests (no claude CLI); we assert that
  // the gate lets the tick through — i.e., runTaskOnce does NOT halt with
  // verify-not-falsifiable for this case. It will halt or fail later when it
  // tries to spawn claude, but the gate itself is passed. We detect that by
  // checking the halt reason is anything other than verify-not-falsifiable.
  const cwd = setupFixture({ verify: 'test -f created-by-work.txt' });
  try {
    const result = runTaskOnce(
      { task: 'Fixture task', kind: 'endgame', files: [] },
      { cwd, verbose: false }
    );
    // If the test environment has no claude CLI, outcome may be 'halted' or
    // phases may throw. What matters is the falsifiability gate let it through.
    if (result.outcome === 'halted') {
      assert.notStrictEqual(result.reason, 'verify-not-falsifiable');
    }
  } finally {
    cleanup(cwd);
  }
});

test('non-endgame task is exempt from the gate', () => {
  // Reactive ticks (kind !== 'endgame') keep using npm test default and must
  // NOT be subject to pre-execute falsifiability — they'd always halt in a
  // healthy repo and break 80% of traffic.
  const cwd = setupFixture({ verify: 'true' });
  try {
    const result = runTaskOnce(
      { task: 'Fixture task', kind: 'inbox', files: [] },
      { cwd, verbose: false }
    );
    // Reactive kind means the explicit verify guard doesn't trigger; the gate
    // doesn't run either. The tick will still fail later (no claude CLI) but
    // not for verify-not-falsifiable.
    if (result.outcome === 'halted') {
      assert.notStrictEqual(result.reason, 'verify-not-falsifiable');
    }
  } finally {
    cleanup(cwd);
  }
});

// verifyRubric command tests: the new machine-checkable Verify shape.
test('verifyRubric extracts and runs a passing fenced bash block', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-rubric-test-'));
  try {
    const featureDir = path.join(cwd, 'atris', 'features', 'demo');
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(path.join(featureDir, 'validate.md'),
`# Validation — demo

## preflight
\`\`\`bash
echo "hello from rubric"
exit 0
\`\`\`

## simulation
- manual step
`);
    const code = verifyRubric('demo', 'preflight', { cwd, silent: true });
    assert.strictEqual(code, 0);
  } finally {
    cleanup(cwd);
  }
});

test('verifyRubric returns non-zero when the rubric script fails', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-rubric-test-'));
  try {
    const featureDir = path.join(cwd, 'atris', 'features', 'demo');
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(path.join(featureDir, 'validate.md'),
`# Validation — demo

## preflight
\`\`\`bash
exit 1
\`\`\`
`);
    const code = verifyRubric('demo', 'preflight', { cwd, silent: true });
    assert.notStrictEqual(code, 0);
  } finally {
    cleanup(cwd);
  }
});

test('verifyRubric returns 2 when the section is missing', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-rubric-test-'));
  try {
    const featureDir = path.join(cwd, 'atris', 'features', 'demo');
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(path.join(featureDir, 'validate.md'),
`# Validation — demo

## preflight
\`\`\`bash
exit 0
\`\`\`
`);
    const code = verifyRubric('demo', 'nonexistent', { cwd, silent: true });
    assert.strictEqual(code, 2);
  } finally {
    cleanup(cwd);
  }
});
