'use strict';

// Command-level tests for commands/autopilot.js — the decision helpers the
// tick engine leans on: task selection, endgame boundary reading, lesson
// parsing/self-heal picking, verify-command shape + fallback, verdict
// parsing, reward math, and the --legacy dispatch guard via real CLI spawns.

// The todo shim caches ATRIS_TASK_DB at load; force the pure markdown path
// before the module graph loads so fixtures behave the same everywhere.
delete process.env.ATRIS_TASK_DB;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  suggestNextTask,
  shouldSkipAutoHumanGate,
  readEndgameState,
  parseLessons,
  loadLessonMetadata,
  pickUnresolvedFailLesson,
  isLessonResolved,
  validateVerifyCommandShape,
  parseVerdict,
  markTodoBulletDone,
  findCompletionReceipt,
  isDoPhaseTimeoutMessage,
  getVerifyCommand,
  detectDefaultVerify,
  computeTickReward,
  lessonSlug,
} = require('../commands/autopilot');
const { REWARD_CONFIG } = require('../lib/reward-config');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

function makeWorkspace(prefix = 'atris-ap-cmd-') {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  return dir;
}

function writeTodo(dir, content) {
  fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), content);
}

function todayJournalFile(dir) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const yearDir = path.join(dir, 'atris', 'logs', String(yyyy));
  fs.mkdirSync(yearDir, { recursive: true });
  return path.join(yearDir, `${yyyy}-${mm}-${dd}.md`);
}

// suggestNextTask reaches for the journal via getLogPath(), which reads
// process.cwd() — run the picker with cwd pinned to the fixture workspace.
async function inWorkspace(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, cwd, extraEnv = {}) {
  const env = { ...process.env, ATRIS_RUNNER_BIN: 'node', ...extraEnv };
  delete env.ATRIS_TASK_DB;
  delete env.ATRIS_RUNNER_PROFILE;
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status == null ? 1 : err.status, stdout: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Tick selection (suggestNextTask)
// ---------------------------------------------------------------------------

test('suggestNextTask picks the endgame task with an explicit Verify before anything else', async () => {
  const dir = makeWorkspace();
  try {
    writeTodo(dir, [
      '# TODO',
      '',
      '## Endgame',
      '**Slug:** ship-the-boundary',
      `**Picked:** ${isoDaysAgo(1)}`,
      '**Horizon:** Everything lands itself.',
      '',
      '## Backlog',
      '',
      '- **T1:** Wire the boundary detector [endgame]',
      '  - **Verify:** node -e "process.exit(0)"',
      '',
      '- **T2:** Sweep the docs',
      '',
      '## In Progress',
      '',
      '## Completed',
      '',
    ].join('\n'));
    const s = await inWorkspace(dir, () => suggestNextTask(dir, new Set(), { auto: true }));
    assert.ok(s, 'expected a suggestion');
    assert.equal(s.kind, 'endgame');
    assert.equal(s.task, 'Wire the boundary detector');
  } finally {
    cleanup(dir);
  }
});

test('suggestNextTask never surfaces an endgame task missing a Verify field — falls to backlog', async () => {
  const dir = makeWorkspace();
  try {
    writeTodo(dir, [
      '# TODO',
      '',
      '## Backlog',
      '',
      '- **T1:** Wire the boundary detector [endgame]',
      '',
      '- **T2:** Sweep the docs',
      '',
    ].join('\n'));
    const s = await inWorkspace(dir, () => suggestNextTask(dir, new Set(), { auto: true }));
    assert.ok(s, 'expected a suggestion');
    assert.equal(s.kind, 'backlog');
    assert.equal(s.task, 'Sweep the docs');
  } finally {
    cleanup(dir);
  }
});

test('suggestNextTask in auto mode skips owner-claimed in-progress work; interactive mode resumes it', async () => {
  const dir = makeWorkspace();
  try {
    writeTodo(dir, [
      '# TODO',
      '',
      '## Backlog',
      '',
      '- **T2:** Sweep the docs',
      '',
      '## In Progress',
      '',
      '- **T3:** Draft the customer email',
      `  - **Claimed by:** keshav ${isoDaysAgo(1)}`,
      '',
    ].join('\n'));
    const auto = await inWorkspace(dir, () => suggestNextTask(dir, new Set(), { auto: true }));
    assert.equal(auto.kind, 'backlog', 'auto mode must not pick up owner-claimed work');
    assert.equal(auto.task, 'Sweep the docs');

    const interactive = await inWorkspace(dir, () => suggestNextTask(dir, new Set(), { auto: false }));
    assert.equal(interactive.kind, 'resume');
    assert.equal(interactive.task, 'Draft the customer email');
  } finally {
    cleanup(dir);
  }
});

test('suggestNextTask turns the first raw inbox idea into a break-down task, stripping the I-number', async () => {
  const dir = makeWorkspace();
  try {
    writeTodo(dir, '# TODO\n\n## Backlog\n\n');
    fs.writeFileSync(todayJournalFile(dir), [
      '# journal',
      '',
      '## Inbox',
      '- **I1:** Build the pricing page',
      '- **I2:** Second idea',
      '',
      '## Notes',
      '',
    ].join('\n'));
    const s = await inWorkspace(dir, () => suggestNextTask(dir, new Set(), { auto: true }));
    assert.ok(s, 'expected a suggestion');
    assert.equal(s.kind, 'inbox');
    assert.equal(s.task, 'Break down inbox idea: "Build the pricing page"');
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Auto human-gate
// ---------------------------------------------------------------------------

test('shouldSkipAutoHumanGate flags owner-claimed tasks and owner-gated titles only', () => {
  assert.equal(shouldSkipAutoHumanGate({ title: 'Fix parser', claimed: 'keshav 2026-08-01' }), true);
  assert.equal(shouldSkipAutoHumanGate({ title: 'Approve and manually send the invoice' }), true);
  assert.equal(shouldSkipAutoHumanGate({ title: 'Needs human approval before rollout' }), true);
  assert.equal(shouldSkipAutoHumanGate({ title: 'Fix parser', claimed: 'builder 2026-08-01' }), false);
  assert.equal(shouldSkipAutoHumanGate(null), false);
});

// ---------------------------------------------------------------------------
// Endgame boundary detection (readEndgameState)
// ---------------------------------------------------------------------------

test('readEndgameState reads slug/picked/horizon and counts endgame steps across sections', () => {
  const dir = makeWorkspace();
  try {
    writeTodo(dir, [
      '# TODO',
      '',
      '## Endgame',
      '**Slug:** ship-the-boundary',
      '**Picked:** 2026-08-01',
      '**Horizon:** Everything lands itself.',
      '',
      '## Backlog',
      '',
      '- **T1:** Wire the boundary detector [endgame]',
      '  - **Verify:** node -e "process.exit(0)"',
      '',
      '- **T2:** Sweep the docs',
      '',
      '## In Progress',
      '',
      '- **T3:** Land the sweeper [endgame]',
      '',
      '## Completed',
      '',
      '- [x] Set up the repo [endgame]',
      '- [x] Unrelated chore',
      '',
    ].join('\n'));
    const s = readEndgameState(dir);
    assert.equal(s.slug, 'ship-the-boundary');
    assert.equal(s.pickedAt, '2026-08-01');
    assert.equal(s.horizon, 'Everything lands itself.');
    assert.equal(s.remaining, 2);
    assert.equal(s.completed, 1);
  } finally {
    cleanup(dir);
  }
});

test('readEndgameState reports the unset boundary when no TODO.md exists', () => {
  const dir = makeWorkspace();
  try {
    assert.deepEqual(readEndgameState(dir),
      { slug: 'unset', pickedAt: null, horizon: '', remaining: 0, completed: 0 });
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Lesson parsing + self-heal picking
// ---------------------------------------------------------------------------

function writeLessonsFixture(dir, sidecar) {
  fs.writeFileSync(path.join(dir, 'atris', 'lessons.md'), [
    '# lessons.md — What We Learned',
    '',
    '---',
    '',
    '- **[2026-07-01] old-bug** — fail — grep still finds the pattern',
    '- **[2026-07-02] fixed-bug** — fail — [resolved] cleaned up already',
    '- **[2026-07-03] good-pattern** — pass — keep doing this',
    'not a lesson line',
    '',
  ].join('\n'));
  if (sidecar) {
    fs.writeFileSync(path.join(dir, 'atris', 'lessons.json'), JSON.stringify(sidecar, null, 2));
  }
}

test('parseLessons joins the lessons.json sidecar by slug and marks sidecar-less lessons legacy', () => {
  const dir = makeWorkspace();
  try {
    writeLessonsFixture(dir, { 'old-bug': { status: 'open', detector: 'exit 1' } });
    const lessons = parseLessons(dir);
    assert.equal(lessons.length, 3);

    const [oldBug, fixedBug, goodPattern] = lessons;
    assert.equal(oldBug.id, 'old-bug');
    assert.equal(oldBug.verdict, 'fail');
    assert.equal(oldBug.legacy, false);
    assert.equal(oldBug.meta.detector, 'exit 1');

    assert.equal(fixedBug.resolvedTag, true);
    assert.equal(fixedBug.body, 'cleaned up already');
    assert.equal(fixedBug.legacy, true);

    assert.equal(goodPattern.verdict, 'pass');
    assert.equal(goodPattern.date, '2026-07-03');
  } finally {
    cleanup(dir);
  }
});

test('loadLessonMetadata returns {} for a missing or malformed sidecar', () => {
  const dir = makeWorkspace();
  try {
    assert.deepEqual(loadLessonMetadata(dir), {});
    fs.writeFileSync(path.join(dir, 'atris', 'lessons.json'), '{not json');
    assert.deepEqual(loadLessonMetadata(dir), {});
  } finally {
    cleanup(dir);
  }
});

test('pickUnresolvedFailLesson picks the typed fail lesson whose detector still fails', () => {
  const dir = makeWorkspace();
  try {
    writeLessonsFixture(dir, { 'old-bug': { status: 'open', detector: 'exit 1' } });
    const picked = pickUnresolvedFailLesson(dir);
    assert.ok(picked, 'expected a self-heal candidate');
    assert.equal(picked.slug, 'old-bug');
    assert.equal(picked.typed, true);
    assert.equal(picked.detector, 'exit 1');
  } finally {
    cleanup(dir);
  }
});

test('pickUnresolvedFailLesson skips detector-resolved, [resolved]-tagged, and attempt-capped lessons', () => {
  const dir = makeWorkspace();
  try {
    // Detector now exits 0 → the bug is gone → nothing to heal.
    writeLessonsFixture(dir, { 'old-bug': { status: 'open', detector: 'exit 0' } });
    assert.equal(pickUnresolvedFailLesson(dir), null);

    // Three failed attempts → needs human re-scoping, not another tick.
    writeLessonsFixture(dir, { 'old-bug': { status: 'attempted', attempts: 3, detector: 'exit 1' } });
    assert.equal(pickUnresolvedFailLesson(dir), null);
  } finally {
    cleanup(dir);
  }
});

test('isLessonResolved trusts the detector exit code', () => {
  const dir = makeWorkspace();
  try {
    const line = '- **[2026-07-01] old-bug** — fail — grep still finds the pattern';
    assert.equal(isLessonResolved(line, dir, { meta: { detector: 'exit 0' } }), true);
    assert.equal(isLessonResolved(line, dir, { meta: { detector: 'exit 1' } }), false);
  } finally {
    cleanup(dir);
  }
});

test('lessonSlug normalizes to kebab-case and truncates on a word boundary', () => {
  assert.equal(lessonSlug('Verify FAILED: npm test!'), 'verify-failed-npm-test');
  assert.equal(lessonSlug(''), 'unknown');
  const long = lessonSlug('one two three four five six seven eight nine ten eleven');
  assert.ok(long.length <= 40, `slug too long: ${long}`);
  assert.ok(!long.endsWith('-'), 'slug must not end mid-word with a dash');
});

// ---------------------------------------------------------------------------
// Verify command shape + fallback
// ---------------------------------------------------------------------------

test('validateVerifyCommandShape rejects backticks, prose expectations, and unlistable statuses', () => {
  assert.equal(validateVerifyCommandShape('`npm test`').ok, false);
  assert.equal(validateVerifyCommandShape('atris task list should show one row').ok, false);
  const readyLint = validateVerifyCommandShape('atris task list --status ready');
  assert.equal(readyLint.ok, false);
  assert.match(readyLint.reason, /review/);
  assert.equal(validateVerifyCommandShape('node --test test/foo.test.js').ok, true);
  assert.equal(validateVerifyCommandShape('').ok, true);
});

test('getVerifyCommand prefers the explicit TODO Verify field and falls back to repo-shape detection', () => {
  const dir = makeWorkspace();
  try {
    writeTodo(dir, [
      '## Backlog',
      '',
      '- **T1:** Wire the boundary detector',
      '  - **Verify:** node --test test/boundary.test.js',
      '',
    ].join('\n'));
    assert.deepEqual(getVerifyCommand(dir, 'Wire the boundary detector'),
      { cmd: 'node --test test/boundary.test.js', explicit: true });
    // Unknown task in an empty workspace: no shape → no default verify.
    assert.deepEqual(getVerifyCommand(dir, 'Some reactive task'), { cmd: null, explicit: false });
  } finally {
    cleanup(dir);
  }
});

test('detectDefaultVerify maps repo shape to a runner and refuses the npm stub script', () => {
  const dir = makeWorkspace();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    assert.equal(detectDefaultVerify(dir), 'npm test');

    fs.writeFileSync(path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    assert.equal(detectDefaultVerify(dir), null);

    fs.rmSync(path.join(dir, 'package.json'));
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
    assert.equal(detectDefaultVerify(dir), 'cargo test');
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Plan-review verdict parsing
// ---------------------------------------------------------------------------

test('parseVerdict reads SIGNOFF, REJECT with FIX + PROPOSED, and treats unparseable output as REJECT', () => {
  const signoff = parseVerdict('thinking...\nSIGNOFF: plan is safe to run');
  assert.equal(signoff.verdict, 'SIGNOFF');
  assert.equal(signoff.reason, 'plan is safe to run');

  const reject = parseVerdict([
    'REJECT: no rollback named',
    'FIX: name a rollback commit',
    'PROPOSED:',
    '  Verify: node --test test/x.test.js',
    '  Rollback: git revert abc1234',
  ].join('\n'));
  assert.equal(reject.verdict, 'REJECT');
  assert.equal(reject.reason, 'no rollback named');
  assert.equal(reject.fix, 'name a rollback commit');
  assert.deepEqual(reject.proposed,
    { verify: 'node --test test/x.test.js', rollback: 'git revert abc1234' });

  const mush = parseVerdict('I think the plan is probably fine.');
  assert.equal(mush.verdict, 'REJECT');
  assert.match(mush.reason, /did not contain SIGNOFF or REJECT/);
});

// ---------------------------------------------------------------------------
// Timeout reconciliation helpers
// ---------------------------------------------------------------------------

test('isDoPhaseTimeoutMessage matches only the do-phase wall message', () => {
  assert.equal(isDoPhaseTimeoutMessage('do phase timed out after 3600s'), true);
  assert.equal(isDoPhaseTimeoutMessage('review phase timed out after 60s'), false);
  assert.equal(isDoPhaseTimeoutMessage(null), false);
});

test('markTodoBulletDone checks the matching bullet and skips done or struck ones', () => {
  const dir = makeWorkspace();
  try {
    writeTodo(dir, [
      '## Backlog',
      '- [x] Wire the boundary detector (already done twin)',
      '- ~~Wire the boundary detector (struck twin)~~',
      '- [ ] Wire the boundary detector [endgame]',
      '',
    ].join('\n'));
    assert.equal(markTodoBulletDone(dir, 'Wire the boundary detector'), true);
    const lines = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8').split('\n');
    assert.equal(lines[3], '- [x] Wire the boundary detector [endgame]');
    // The struck bullet stays untouched.
    assert.equal(lines[2], '- ~~Wire the boundary detector (struck twin)~~');
    assert.equal(markTodoBulletDone(dir, 'A task nobody wrote down'), false);
  } finally {
    cleanup(dir);
  }
});

test('findCompletionReceipt finds a C-line receipt for the task in today journal', () => {
  const dir = makeWorkspace();
  try {
    fs.writeFileSync(todayJournalFile(dir), [
      '# journal',
      '',
      '## Completed',
      '- **C1:** Wire the boundary detector — landed in one tick',
      '',
    ].join('\n'));
    const receipt = findCompletionReceipt(dir, 'Wire the boundary detector');
    assert.ok(receipt && receipt.includes('**C1:**'));
    assert.equal(findCompletionReceipt(dir, 'Some other task'), null);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Reward math
// ---------------------------------------------------------------------------

test('computeTickReward pays out for clean review + passing verify + npm bonus + landed commit', () => {
  const execution = {
    reviewOutput: 'all checks passed',
    verifyRan: true,
    verifyPass: true,
    phaseResults: { do: { output: '2 files changed, committed' } },
  };
  const expected = REWARD_CONFIG.REVIEW_CLEAN + REWARD_CONFIG.VERIFY_PASS
    + REWARD_CONFIG.NPM_TEST_BONUS + REWARD_CONFIG.COMMIT_LANDED;
  assert.equal(computeTickReward(execution, 'completed', 'npm test'), expected);
});

test('computeTickReward charges the halt penalty and pays nothing for a failed dirty tick', () => {
  const execution = {
    reviewOutput: 'review failed on step two',
    verifyRan: false,
    verifyPass: false,
    phaseResults: { do: { output: '' } },
  };
  assert.equal(computeTickReward(execution, 'halted', null), REWARD_CONFIG.HALT_PENALTY);
});

// ---------------------------------------------------------------------------
// CLI smokes (spawned from temp dirs — never the repo checkout)
// ---------------------------------------------------------------------------

test('atris autopilot --help routes to the mission-runtime front door', () => {
  const dir = makeWorkspace();
  try {
    const r = runCli(['autopilot', '--help'], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /mission or member/);
    assert.match(r.stdout, /--legacy/);
  } finally {
    cleanup(dir);
  }
});

test('atris autopilot --legacy --help routes to the legacy suggest/approve loop help', () => {
  const dir = makeWorkspace();
  try {
    const r = runCli(['autopilot', '--legacy', '--help'], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Suggests one task at a time/);
    assert.match(r.stdout, /--dry-run/);
  } finally {
    cleanup(dir);
  }
});

test('atris autopilot --legacy --dry-run picks a task without executing, all writes stay in the temp workspace', () => {
  const dir = makeWorkspace();
  try {
    writeTodo(dir, [
      '# TODO',
      '',
      '## Backlog',
      '',
      '- **T1:** Sweep the docs',
      '',
    ].join('\n'));
    const r = runCli(['autopilot', '--legacy', '--dry-run', '--iterations=1'], dir);
    assert.equal(r.status, 0, `dry tick failed:\n${r.stdout}`);
    assert.match(r.stdout, /Sweep the docs/);
    assert.match(r.stdout, /dry run/);
    // The dry tick must not have marked the bullet done.
    const todo = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    assert.match(todo, /- \*\*T1:\*\* Sweep the docs/);
  } finally {
    cleanup(dir);
  }
});
