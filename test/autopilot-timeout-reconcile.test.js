const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const {
  executePhaseDetailed,
  snapshotRepoHeads,
  diffAdvancedRepoHeads,
  reconcileTimedOutTick,
  markTodoBulletDone,
  findCompletionReceipt,
  isDoPhaseTimeoutMessage,
  runTaskOnce,
} = require('../commands/autopilot');

// T33 (endgame loop-self-repair): a do-phase wall-clock timeout kills the
// reporter, not the work — 12/13 ETIMEDOUT halts in the 2026-06-10 RSI audit
// had commits landed with no receipt, no checked bullet, and a human halt.
// T33a reconciles from pre-tick HEADs; T33b checks-and-advances at the
// falsifiability gate when a completion receipt already exists.

const TODO_BODY = `# TODO.md

## Endgame

**Slug:** reconcile-fixture
**Picked:** 2026-06-10
**Done when:** the fixture demonstrates reconciliation
**Source:** test fixture

## Backlog

- **T1:** Fixture timeout task [endgame] [execute]
  **Files:** stub.txt
  **Exit:** fixture exit
  **Verify:** test -f created-by-work.txt
  **After:** none

## In Progress

## Completed
`;

function setupGitWorkspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-reconcile-test-'));
  const atrisDir = path.join(cwd, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'TODO.md'), TODO_BODY);
  fs.writeFileSync(path.join(atrisDir, 'lessons.md'), '# lessons\n\n---\n');
  execSync(
    'git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init',
    { cwd, stdio: 'pipe' }
  );
  return cwd;
}

function todayLogPath(cwd) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return path.join(cwd, 'atris', 'logs', String(yyyy), `${yyyy}-${mm}-${dd}.md`);
}

function cleanup(cwd) {
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
}

test('timeout-after-commit reconciles: receipt + checked bullet + no human halt', () => {
  const cwd = setupGitWorkspace();
  const origCwd = process.cwd();
  try {
    const snapshot = snapshotRepoHeads(cwd, 'Fixture timeout task');
    assert.ok(snapshot.length >= 1 && snapshot[0].head, 'workspace HEAD must be snapshotted');

    // Simulate the production failure: the do-phase claude commits real work,
    // then outlives the wall. cmdOverride drives the REAL timeout catch path.
    process.chdir(cwd);
    let thrown;
    try {
      executePhaseDetailed(
        'do',
        { task: 'Fixture timeout task', kind: 'endgame' },
        { verbose: false, timeout: 1500, cmdOverride: 'git commit -q --allow-empty -m landed && sleep 10' }
      );
    } catch (err) {
      thrown = err;
    }
    process.chdir(origCwd);
    assert.ok(thrown, 'expected the forced timeout to throw');
    assert.ok(isDoPhaseTimeoutMessage(thrown.message), `"${thrown.message}" must be detected as a do-phase timeout`);

    const result = reconcileTimedOutTick(cwd, snapshot, 'Fixture timeout task');
    assert.strictEqual(result.reconciled, true);
    assert.strictEqual(result.outcome, 'work-landed-receipt-died');
    assert.strictEqual(result.advanced.length, 1);
    assert.notStrictEqual(result.advanced[0].before, result.advanced[0].after);
    assert.strictEqual(result.bulletMarked, true);

    const journal = fs.readFileSync(todayLogPath(cwd), 'utf8');
    assert.match(journal, /work-landed-receipt-died/);
    assert.match(journal, /Fixture timeout task/);
    assert.match(journal, new RegExp(result.advanced[0].after.slice(0, 7)));

    const todo = fs.readFileSync(path.join(cwd, 'atris', 'TODO.md'), 'utf8');
    assert.match(todo, /- \[x\] \*\*T1:\*\* Fixture timeout task/);
  } finally {
    process.chdir(origCwd);
    cleanup(cwd);
  }
});

test('timeout with no commits still halts: no receipt, bullet untouched', () => {
  const cwd = setupGitWorkspace();
  try {
    const snapshot = snapshotRepoHeads(cwd, 'Fixture timeout task');
    const result = reconcileTimedOutTick(cwd, snapshot, 'Fixture timeout task');
    assert.strictEqual(result.reconciled, false);
    assert.strictEqual(result.advanced.length, 0);
    assert.ok(!fs.existsSync(todayLogPath(cwd)), 'no reconciliation receipt without landed commits');
    const todo = fs.readFileSync(path.join(cwd, 'atris', 'TODO.md'), 'utf8');
    assert.doesNotMatch(todo, /- \[x\] \*\*T1:\*\*/);
  } finally {
    cleanup(cwd);
  }
});

test('snapshotRepoHeads picks up ../sibling refs named in the task text', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-snapshot-test-'));
  const cwd = path.join(parent, 'main');
  const sibling = path.join(parent, 'sibling-repo');
  try {
    for (const dir of [cwd, sibling]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
      execSync(
        'git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init',
        { cwd: dir, stdio: 'pipe' }
      );
    }
    // Both forms must resolve: the journal-convention ../ref and a bare name.
    for (const text of ['Fix the wall — files: ../sibling-repo commands/x.js', 'Fix the wall in sibling-repo']) {
      const snapshot = snapshotRepoHeads(cwd, text);
      const labels = snapshot.map((r) => r.label);
      assert.deepStrictEqual(labels, ['.', '../sibling-repo'], `task text "${text}" → ${labels}`);
      assert.ok(snapshot.every((r) => r.head));
    }
    // A commit in the sibling shows up as advanced.
    const snapshot = snapshotRepoHeads(cwd, '../sibling-repo');
    execSync('git commit -q --allow-empty -m landed', { cwd: sibling, stdio: 'pipe' });
    const advanced = diffAdvancedRepoHeads(snapshot);
    assert.strictEqual(advanced.length, 1);
    assert.strictEqual(advanced[0].label, '../sibling-repo');
  } finally {
    cleanup(parent);
  }
});

test('gate check-and-advance: pre-passing verify WITH journal receipt advances', () => {
  const cwd = setupGitWorkspace();
  try {
    // Make the Verify pass pre-work, and plant a C# completion receipt naming
    // the task in today's journal (the shape logCompletion writes).
    fs.writeFileSync(path.join(cwd, 'created-by-work.txt'), 'already shipped\n');
    const logFile = todayLogPath(cwd);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, '# log\n\n## Completed\n\n- **C7:** Fixture timeout task [reviewed]\n');

    const result = runTaskOnce(
      { task: 'Fixture timeout task', kind: 'endgame', files: [] },
      { cwd, verbose: false, skipPlanReview: true, phaseExec: () => ({ prompt: 'p', output: 'ok' }) }
    );
    assert.strictEqual(result.outcome, 'advanced-already-done');
    assert.strictEqual(result.bulletMarked, true);
    assert.match(result.receipt, /\*\*C7:\*\*/);

    const todo = fs.readFileSync(path.join(cwd, 'atris', 'TODO.md'), 'utf8');
    assert.match(todo, /- \[x\] \*\*T1:\*\* Fixture timeout task/);
    const journal = fs.readFileSync(logFile, 'utf8');
    assert.match(journal, /advanced-already-done/);
    // The picker wedge must NOT be recorded — this is an advance, not a halt.
    const lessons = fs.readFileSync(path.join(cwd, 'atris', 'lessons.md'), 'utf8');
    assert.doesNotMatch(lessons, /verify-not-falsifiable/);
  } finally {
    cleanup(cwd);
  }
});

test('gate without a receipt still halts verify-not-falsifiable', () => {
  const cwd = setupGitWorkspace();
  try {
    fs.writeFileSync(path.join(cwd, 'created-by-work.txt'), 'pre-passing verify\n');
    const result = runTaskOnce(
      { task: 'Fixture timeout task', kind: 'endgame', files: [] },
      { cwd, verbose: false, skipPlanReview: true, phaseExec: () => ({ prompt: 'p', output: 'ok' }) }
    );
    assert.strictEqual(result.outcome, 'halted');
    assert.strictEqual(result.reason, 'verify-not-falsifiable');
  } finally {
    cleanup(cwd);
  }
});

test('findCompletionReceipt ignores unrelated receipts', () => {
  const cwd = setupGitWorkspace();
  try {
    const logFile = todayLogPath(cwd);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, '# log\n\n## Completed\n\n- **C1:** Some other task entirely [reviewed]\n');
    assert.strictEqual(findCompletionReceipt(cwd, 'Fixture timeout task'), null);
  } finally {
    cleanup(cwd);
  }
});

test('markTodoBulletDone checks plain checkbox bullets too', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-bullet-test-'));
  try {
    const atrisDir = path.join(cwd, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    fs.writeFileSync(path.join(atrisDir, 'TODO.md'),
      '## Backlog\n\n- [x] Already done thing\n- [ ] Re-target Chat to the selected business agent\n');
    assert.strictEqual(markTodoBulletDone(cwd, 'Re-target Chat to the selected business agent'), true);
    const todo = fs.readFileSync(path.join(atrisDir, 'TODO.md'), 'utf8');
    assert.match(todo, /- \[x\] Re-target Chat to the selected business agent/);
    // Idempotent: nothing left to mark.
    assert.strictEqual(markTodoBulletDone(cwd, 'Already done thing'), false);
  } finally {
    cleanup(cwd);
  }
});
