const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { runTaskOnce, suggestNextTask } = require('../commands/autopilot');
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

function stubPhaseExec(phase) {
  return { prompt: `${phase} prompt`, output: `${phase} ok` };
}

function setupPickerFixture({ endgameVerify = '', lesson = '' } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-picker-test-'));
  const atrisDir = path.join(cwd, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  const verifyLine = endgameVerify ? `  **Verify:** ${endgameVerify}\n` : '';
  fs.writeFileSync(path.join(atrisDir, 'TODO.md'),
`# TODO.md

## Endgame

**Slug:** picker-fixture

## Backlog

- **T1:** Unsafe endgame task [endgame] [execute]
${verifyLine}- **T2:** Safe generic task [execute]
  **Verify:** node -e "process.exit(1)"

## In Progress

## Completed
`);
  fs.writeFileSync(path.join(atrisDir, 'lessons.md'), lesson || '# lessons\n\n---\n');
  return cwd;
}

test('trivial Verify (true) halts with verify-not-falsifiable', () => {
  const cwd = setupFixture({ verify: 'true' });
  try {
    const result = runTaskOnce(
      { task: 'Fixture task', kind: 'endgame', files: [] },
      { cwd, verbose: false, skipPlanReview: true, phaseExec: stubPhaseExec }
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
  // Stub plan/do/review so the test checks only the gate and never spawns an
  // external agent process.
  const cwd = setupFixture({ verify: 'test -f created-by-work.txt' });
  try {
    const result = runTaskOnce(
      { task: 'Fixture task', kind: 'endgame', files: [] },
      { cwd, verbose: false, skipPlanReview: true, phaseExec: stubPhaseExec }
    );
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
      { cwd, verbose: false, skipPlanReview: true, phaseExec: stubPhaseExec }
    );
    if (result.outcome === 'halted') {
      assert.notStrictEqual(result.reason, 'verify-not-falsifiable');
    }
  } finally {
    cleanup(cwd);
  }
});

test('picker does not downgrade endgame tasks missing Verify into backlog', async () => {
  const cwd = setupPickerFixture();
  try {
    const suggestion = await suggestNextTask(cwd, new Set(), { auto: true });
    assert.strictEqual(suggestion.task, 'Safe generic task');
    assert.strictEqual(suggestion.kind, 'backlog');
  } finally {
    cleanup(cwd);
  }
});

test('picker does not downgrade recently pre-passed endgame tasks into backlog', async () => {
  const today = new Date().toISOString().split('T')[0];
  const cwd = setupPickerFixture({
    endgameVerify: 'true',
    lesson: `# lessons\n\n---\n\n- **[${today}] verify-not-falsifiable** — fail — Verify \`true\` passed before work started on "Unsafe endgame task". Either the rubric is trivial or the task is already done. Tick halted.\n`,
  });
  try {
    const suggestion = await suggestNextTask(cwd, new Set(['self-heal']), { auto: true });
    assert.strictEqual(suggestion.task, 'Safe generic task');
    assert.strictEqual(suggestion.kind, 'backlog');
  } finally {
    cleanup(cwd);
  }
});

test('picker skips stale MAP verify-failed lesson when repo audit is clean', async () => {
  const cwd = setupPickerFixture({
    lesson: '# lessons\n\n---\n\n- **[2026-04-29] verify-failed** — fail — Task "Fix 118 broken references in MAP.md" passed review but failed verify command.\n',
  });
  try {
    fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'scripts', 'audit_map_refs.py'),
`#!/usr/bin/env python3
print("Total broken references: 0")
`);

    const suggestion = await suggestNextTask(cwd, new Set(), { auto: true });
    assert.strictEqual(suggestion.task, 'Safe generic task');
    assert.strictEqual(suggestion.kind, 'backlog');
  } finally {
    cleanup(cwd);
  }
});

test('picker does not promote verify-not-falsifiable lessons to self-heal work', async () => {
  const cwd = setupPickerFixture({
    lesson: '# lessons\n\n---\n\n- **[2026-04-29] verify-not-falsifiable** — fail — Verify `true` passed before work started on "Old shipped task". Either the rubric is trivial or the task is already done. Tick halted.\n',
  });
  try {
    const suggestion = await suggestNextTask(cwd, new Set(), { auto: true });
    assert.strictEqual(suggestion.task, 'Safe generic task');
    assert.strictEqual(suggestion.kind, 'backlog');
  } finally {
    cleanup(cwd);
  }
});

test('picker does not promote legacy verify-failed receipts to self-heal work', async () => {
  const cwd = setupPickerFixture({
    lesson: '# lessons\n\n---\n\n- **[2026-04-29] verify-failed** — fail — Task "Capture rejection path". Touch `backend/rl/etl/action_queue_to_trajectories.py`. Verify command failed.\n',
  });
  try {
    const sourcePath = path.join(cwd, 'backend', 'rl', 'etl', 'action_queue_to_trajectories.py');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, '# failed verify wording in an unrelated comment\n');

    const suggestion = await suggestNextTask(cwd, new Set(), { auto: true });
    assert.strictEqual(suggestion.task, 'Safe generic task');
    assert.strictEqual(suggestion.kind, 'backlog');
  } finally {
    cleanup(cwd);
  }
});

test('picker replays passing inline python verify failures before self-heal', async () => {
  const cwd = setupPickerFixture({
    lesson: "# lessons\n\n---\n\n- **[2026-04-29] verify-fail-doc-edit-attribution** — fail — Verify command ``python3 -c \"open('proof.txt').read(); assert True\"`` failed: Command failed.\n",
  });
  try {
    fs.writeFileSync(path.join(cwd, 'proof.txt'), 'now present\n');

    const suggestion = await suggestNextTask(cwd, new Set(), { auto: true });
    assert.strictEqual(suggestion.task, 'Safe generic task');
    assert.strictEqual(suggestion.kind, 'backlog');
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
