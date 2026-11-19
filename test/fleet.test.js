const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const fleet = require('../lib/fleet');
const { listWorktrees } = require('../commands/worktree');

const TASK = {
  display_id: 'CLI-900',
  status: 'open',
  title: 'Fix the widget so operators stop retyping. Done: widget renders once, test included. Check: focused node --test test/widget.test.js.',
};

function waitUntil(predicate, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function writeExecutorDispatchHistory(root, outcomes) {
  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  for (let index = 0; index < 3; index += 1) {
    const at = `2026-07-${18 + index}T12:00:00.000Z`;
    const results = Object.entries(outcomes).map(([engine, verifiedPassed]) => ({
      task: `CLI-${engine}-${index}`,
      engine,
      task_type: 'executor',
      verified_passed: verifiedPassed,
      duration_ms: 1000,
      at,
      exitCode: verifiedPassed ? 0 : 1,
    }));
    fs.writeFileSync(path.join(runsDir, `dispatch-history-${index}.json`), `${JSON.stringify({
      schema: 'atris.dispatch_receipt.v1',
      results,
    })}\n`, 'utf8');
  }
}

test('parseDoneCheck extracts the task spec from board convention text', () => {
  const { done, check } = fleet.parseDoneCheck(TASK.title);
  assert.match(done, /widget renders once/);
  assert.match(check, /node --test test\/widget\.test\.js/);
  assert.deepEqual(fleet.parseDoneCheck('no spec here'), { done: '', check: '' });
});

test('buildFleetPrompt is generated, bounded, and carries the contract', () => {
  const prompt = fleet.buildFleetPrompt(TASK, { worktreePath: '/wt/x' });
  assert.match(prompt.split('\n')[0], /`atris worktree guard`/);
  assert.match(prompt, /CLI-900/);
  assert.match(prompt, /its own git worktree at \/wt\/x/);
  assert.match(prompt, /Do not push and do not create branches; the conductor lands your commit\./);
  assert.doesNotMatch(prompt, /atris worktree ship/);
  assert.match(prompt, /Done criteria: widget renders once/);
  assert.match(prompt, /atris\/MAP\.md first/);
  assert.match(prompt, /atris worktree guard/);
  assert.doesNotMatch(prompt, /atris worktree start/);
  assert.match(prompt, /Stage ONLY files you changed/);
  assert.match(prompt, /real exit code/);
  assert.match(prompt, /Done requires a receipt/);
  assert.match(prompt, /grep the whole repo for its callers/);
  assert.match(prompt, /one concern per PR/i);
  assert.match(prompt, /split anything larger into separate PRs/i);
  assert.match(prompt, /git history guides future agents/i);
  assert.match(prompt, /small PRs are cheap to revert and bisect/i);
  assert.match(prompt, /must hold on every path to the thing it protects/);
  assert.match(prompt, /Final report/);
});

test('buildFleetPrompt yolo asks the engine to land itself', () => {
  const prompt = fleet.buildFleetPrompt(TASK, { worktreePath: '/wt/x', yolo: true });
  assert.match(prompt, /atris worktree guard/);
  assert.match(prompt, /atris\/MAP\.md first/);
  assert.match(prompt, /plain-English message/);
  assert.match(prompt, /atris worktree ship --message "Fix the widget so operators stop retyping \(CLI-900\)" --verify 'focused node --test test\/widget\.test\.js\.' --merge/);
  assert.match(prompt, /That ship command is the only push allowed/);
  assert.match(prompt, /never resolve conflicts yourself/);
  assert.doesNotMatch(prompt, /Do not push/);
  assert.doesNotMatch(prompt, /NEVER push/);
});

// `atris worktree guard` refuses a checkout that has edits in it, so it can only pass at the
// start. A builder that re-ran it in its own review step, after its edits, got exit 3, obeyed
// "if it fails, stop immediately", and the finished work was never committed.
test('buildFleetPrompt orders the guard once, before the first edit, and never again after editing', () => {
  for (const yolo of [false, true]) {
    const first = fleet.buildFleetPrompt(TASK, { worktreePath: '/wt/x', yolo }).split('\n')[0];
    assert.match(first, /before your first edit/i, 'it runs before the first edit');
    assert.match(first, /run `atris worktree guard` once/, 'it runs one time');
    assert.match(first, /if it fails then, stop immediately, report back, and do not edit anything/, 'a failure at the start still stops the builder');
    assert.match(first, /clean start/, 'it says what the guard checks');
    assert.match(first, /fails once edits exist/, 'it says why it fails later');
    assert.match(first, /never run it again after editing/, 'it is not a gate to re-run');
    assert.doesNotMatch(first, /Do this before any file edit/, 'the open-ended order is gone');
  }
});

// A protected-lane task is never shipped by its builder. Its ship would open the pull request
// before the flight's own check, and a flight whose check or ship then failed would let go of the
// claim with that pull request open and unrecorded. So the builder commits and stops, as it does
// without yolo, and the flight ships the commit once, without --merge, for a person to land.
test('buildFleetPrompt yolo has a protected-lane builder commit only, and says a person lands it', () => {
  const prompt = fleet.buildFleetPrompt({ ...TASK, tag: 'security' }, { worktreePath: '/wt/x', yolo: true });
  assert.match(prompt, /This task is in the protected security lane, so a person lands it, not you\./);
  assert.match(prompt, /Commit on the current branch with a plain-English message\. Do not push, do not run `atris worktree ship`, and do not create branches; the conductor ships your commit for a person to review\./);
  assert.doesNotMatch(prompt, /--merge/, 'a builder never merges protected work');
  assert.doesNotMatch(prompt, /then run:/, 'there is no ship command to run');
  assert.doesNotMatch(prompt, /--verify/, 'there is no ship command to run');
  assert.doesNotMatch(prompt, /only push allowed/);
  assert.doesNotMatch(prompt, /Land it yourself/);
  assert.doesNotMatch(prompt, /PR URL/, 'it opens no pull request, so it has none to report');
  assert.match(prompt, /Final report \(plain text\): files changed, check command \+ result, commit sha \(or say what failed and why\)\./);
  assert.match(prompt, /Run the check bare before committing: focused node --test test\/widget\.test\.js\./);

  // Without yolo the conductor lands the commit, and the brief says nothing about shipping.
  const plain = fleet.buildFleetPrompt({ ...TASK, tag: 'security' }, { worktreePath: '/wt/x' });
  assert.match(plain, /Do not push and do not create branches; the conductor lands your commit\./);
  assert.doesNotMatch(plain, /atris worktree ship/);
  assert.doesNotMatch(plain, /protected security lane/);
});

test('every protected lane gets the commit-only yolo order, wherever the task carries the lane', () => {
  assert.ok(fleet.DENIED_TAGS.length >= 8);
  for (const lane of fleet.DENIED_TAGS) {
    for (const task of [
      { ...TASK, tag: lane },
      { ...TASK, tag: 'code', tags: ['docs', lane] },
      { ...TASK, tag: 'code', metadata: { tags: [lane.toUpperCase()] } },
      { ...TASK, tag: 'code', metadata: { todo_tags: ['docs', lane.toUpperCase()] } },
      { ...TASK, tag: 'code', title: `#${lane} ${TASK.title}` },
    ]) {
      const prompt = fleet.buildFleetPrompt(task, { worktreePath: '/wt/x', yolo: true });
      assert.doesNotMatch(prompt, /--merge/, `${lane} must not be merged by a builder`);
      assert.match(prompt, new RegExp(`protected ${lane} lane`));
      assert.match(prompt, /a person lands it/);
      assert.match(prompt, /do not run `atris worktree ship`/);
      assert.doesNotMatch(prompt, /PR URL/);
    }
  }
});

test('buildFleetPrompt yolo still orders --merge for a task outside the protected lanes', () => {
  for (const task of [
    TASK,
    { ...TASK, tag: 'code' },
    { ...TASK, tag: 'code', metadata: { todo_tags: ['docs'] } },
    { ...TASK, tag: 'code', tags: ['docs'], metadata: { tags: ['ui'], todo_tags: ['docs'] } },
    // A lane named in plain words is not the lane: only a tag or a hashtag is.
    { ...TASK, tag: 'code', title: TASK.title.replace('Fix the widget', 'Fix the security widget') },
    { ...TASK, tag: 'code', title: `#docs ${TASK.title}` },
  ]) {
    const prompt = fleet.buildFleetPrompt(task, { worktreePath: '/wt/x', yolo: true });
    assert.match(prompt, /Land it yourself\./);
    assert.match(prompt, /--verify 'focused node --test test\/widget\.test\.js\.' --merge, and report the PR URL\./);
    assert.doesNotMatch(prompt, /a person lands it/);
    assert.doesNotMatch(prompt, /protected \w+ lane/);
  }
});

test('METHOD_KERNEL is exported and fully present in the prompt', () => {
  assert.ok(Array.isArray(fleet.METHOD_KERNEL));
  assert.ok(fleet.METHOD_KERNEL.length >= 6);
  const prompt = fleet.buildFleetPrompt({ display_id: 'CLI-1', title: 'x' });
  for (const rule of fleet.METHOD_KERNEL) {
    assert.ok(prompt.includes(`- ${rule}`), `kernel rule missing from prompt: ${rule}`);
  }
});

test('assertIsolatedWorktree refuses missing and primary checkout paths', () => {
  const primaryRoot = fs.realpathSync(listWorktrees(process.cwd())[0].path);
  assert.throws(
    () => fleet.assertIsolatedWorktree('', process.cwd()),
    /worktreePath is required/
  );
  assert.throws(
    () => fleet.assertIsolatedWorktree(primaryRoot, process.cwd()),
    /primary repo checkout/
  );
});

test('assertIsolatedWorktree allows a real non-primary worktree path', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-isolated-wt-'));
  try {
    assert.doesNotThrow(() => fleet.assertIsolatedWorktree(wt, process.cwd()));
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('dispatchToEngine refuses to run from the primary checkout', () => {
  const primaryRoot = fs.realpathSync(listWorktrees(process.cwd())[0].path);
  let runnerCalled = false;
  assert.throws(
    () => fleet.dispatchToEngine({
      task: { ...TASK, display_id: 'CLI-PRIMARY-GUARD' },
      engine: 'cursor',
      worktreePath: primaryRoot,
      runner: () => { runnerCalled = true; return { status: 0, stdout: '', stderr: '' }; },
    }),
    /primary repo checkout/
  );
  assert.equal(runnerCalled, false);
});

test('buildEngineCommand rides runner profiles per engine', () => {
  assert.match(fleet.buildEngineCommand('cursor', '/tmp/p.md'), /^cursor-agent --trust -p/);
  assert.match(fleet.buildEngineCommand('codex', '/tmp/p.md'), /codex-watchdog\.js.*sh -c 'codex exec/);
  assert.match(fleet.buildEngineCommand('atris-fast', '/tmp/p.md'), /^ax --fast/);
  assert.match(fleet.buildEngineCommand('devin', '/tmp/p.md'), /^devin -p --permission-mode dangerous /);
  // claude has no template: default claude-shaped spawn with a model flag
  assert.match(fleet.buildEngineCommand('claude', '/tmp/p.md'), /^claude -p .*--model/);
  assert.throws(() => fleet.buildEngineCommand('gpt-11', '/tmp/p.md'), /unknown engine/);
});

test('dispatchToEngine writes the prompt file and captures the report', () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-wt-'));
  try {
    const calls = [];
    const result = fleet.dispatchToEngine({
      task: TASK,
      engine: 'cursor',
      worktreePath: wt,
      runner: (cmd) => { calls.push(cmd); return { status: 0, stdout: 'report: done', stderr: '' }; },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.engine, 'cursor');
    assert.match(result.report, /report: done/);
    assert.equal(calls.length, 1);
    const promptFile = path.join(wt, '.atris', 'fleet-prompt-CLI-900.md');
    assert.ok(fs.existsSync(promptFile));
    assert.match(fs.readFileSync(promptFile, 'utf8'), /Done criteria/);
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('dispatchToEngine appends engine chunks to its live log before the engine exits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-live-root-'));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-live-wt-'));
  const binDir = path.join(root, 'bin');
  const liveLogPath = path.join(root, 'atris', 'runs', 'dispatch-live.live.log');
  const resultPath = path.join(root, 'result.json');
  const runnerPath = path.join(root, 'runner.js');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeCursor = path.join(binDir, 'cursor-agent');
  fs.writeFileSync(fakeCursor, [
    '#!/usr/bin/env node',
    "process.stdout.write('first dispatch chunk\\n');",
    "setTimeout(() => process.stderr.write('second dispatch chunk\\n'), 350);",
    'setTimeout(() => process.exit(0), 700);',
    '',
  ].join('\n'));
  fs.chmodSync(fakeCursor, 0o755);
  fs.writeFileSync(runnerPath, [
    `'use strict';`,
    `const fs = require('node:fs');`,
    `const path = require('node:path');`,
    `const fleet = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'fleet.js'))});`,
    `process.env.PATH = ${JSON.stringify(binDir)} + path.delimiter + process.env.PATH;`,
    `Promise.resolve(fleet.dispatchToEngine({`,
    `  task: ${JSON.stringify(TASK)},`,
    `  engine: 'cursor',`,
    `  worktreePath: ${JSON.stringify(wt)},`,
    `  root: ${JSON.stringify(process.cwd())},`,
    `  briefId: 'test-live-brief',`,
    `  skipBriefCapture: true,`,
    `  liveLogPath: ${JSON.stringify(liveLogPath)},`,
    `})).then((result) => {`,
    `  fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));`,
    `});`,
    '',
  ].join('\n'));
  const child = spawn(process.execPath, [runnerPath], { cwd: root, stdio: 'ignore' });
  let closed = false;
  const childClosed = new Promise((resolve) => child.once('close', (code) => { closed = true; resolve(code); }));
  try {
    await waitUntil(() => fs.existsSync(liveLogPath) && fs.readFileSync(liveLogPath, 'utf8').includes('first dispatch chunk'), 5000);
    assert.equal(closed, false, 'the engine must still be running when the first chunk is readable');
    assert.equal(await childClosed, 0);
    assert.match(fs.readFileSync(liveLogPath, 'utf8'), /first dispatch chunk[\s\S]*second dispatch chunk/);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(result.exitCode, 0);
    assert.match(result.report, /first dispatch chunk/);
    assert.match(result.stderr, /second dispatch chunk/);
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('staffing skips denied lanes and keeps concurrent picks file-disjoint', () => {
  const tasks = [
    { display_id: 'A', status: 'open', title: 'touch commands/mission.js Done: x. Check: y.' },
    { display_id: 'B', status: 'open', title: 'billing invoice run #billing Done: x. Check: y.' },
    { display_id: 'C', status: 'open', title: 'also edits commands/mission.js plus lib/other.js Done: x. Check: y.' },
    { display_id: 'D', status: 'open', title: 'edits lib/fleet.js only Done: x. Check: y.' },
    { display_id: 'E', status: 'review', title: 'not open' },
  ];
  const staffed = fleet.staffFlight(tasks, { slots: 3 });
  const ids = staffed.map((s) => s.task.display_id);
  assert.ok(!ids.includes('B'), 'denied lane staffed');
  assert.ok(!ids.includes('E'), 'non-open staffed');
  assert.ok(ids.includes('A') && ids.includes('D'));
  assert.ok(!ids.includes('C'), 'overlapping surface staffed concurrently');
});

test('staffing allows at most one surface-blind task per flight', () => {
  const tasks = [
    { display_id: 'A', status: 'open', title: 'vague idea one Done: x. Check: y.' },
    { display_id: 'B', status: 'open', title: 'vague idea two Done: x. Check: y.' },
  ];
  const staffed = fleet.staffFlight(tasks, { slots: 3 });
  assert.equal(staffed.length, 1);
});

test('assignEngines round-robins the installed roster', () => {
  const staffed = fleet.staffFlight([
    { display_id: 'A', status: 'open', title: 'edits lib/a.js Done: x. Check: y.' },
    { display_id: 'B', status: 'open', title: 'edits lib/b.js Done: x. Check: y.' },
    { display_id: 'C', status: 'open', title: 'edits lib/c.js Done: x. Check: y.' },
  ], { slots: 3 });
  const assigned = fleet.assignEngines(staffed, ['codex', 'cursor']);
  assert.deepEqual(assigned.map((a) => a.engine), ['codex', 'cursor', 'codex']);
  assert.deepEqual(fleet.assignEngines(staffed, []), []);
});

test('restaffing keeps legacy rotation when history is thin and follows rich executor outcomes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-router-'));
  try {
    const installedEngines = ['codex', 'cursor', 'claude'];
    assert.equal(
      fleet.nextInstalledFleetEngine('codex', { root, installedEngines }),
      'cursor',
    );

    writeExecutorDispatchHistory(root, { cursor: false, claude: true });
    assert.equal(
      fleet.nextInstalledFleetEngine('codex', { root, installedEngines }),
      'claude',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('landArrival rebases clean arrivals and pauses on conflict without resolving', () => {
  const log = [];
  const gitOk = (args) => { log.push(args[0]); return { status: 0, stdout: '', stderr: '' }; };
  const clean = fleet.landArrival({ worktreePath: '/wt', targetRef: 'origin/master', git: gitOk });
  assert.deepEqual(clean, { ok: true, stage: 'rebased' });

  const conflictGit = (args) => {
    log.push(args.join(' '));
    if (args[0] === 'rebase' && args[1] === 'origin/master') return { status: 1, stdout: '', stderr: 'conflict' };
    if (args[0] === 'diff') return { status: 0, stdout: 'commands/mission.js\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const paused = fleet.landArrival({ worktreePath: '/wt', targetRef: 'origin/master', git: conflictGit });
  assert.equal(paused.ok, false);
  assert.equal(paused.stage, 'rebase_conflict');
  assert.deepEqual(paused.conflicts, ['commands/mission.js']);
  assert.ok(log.includes('rebase --abort'), 'conflict must be aborted, never auto-resolved');
});

// CLI-1190: a killed predecessor leaves modified/untracked files behind, so
// git rebase refuses before any conflict can occur — the unmerged-file list is
// empty. Reporting that as rebase_conflict sends the operator chasing a merge
// problem that does not exist. It must report a distinct dirty_worktree state
// naming the uncommitted paths, and an empty conflicts list is never a conflict.
test('landArrival reports dirty_worktree, not an empty rebase_conflict', () => {
  const dirtyGit = (args) => {
    if (args[0] === 'rebase' && args[1] === 'origin/master') {
      return { status: 1, stdout: '', stderr: 'cannot rebase: you have unstaged changes' };
    }
    if (args[0] === 'diff') return { status: 0, stdout: '', stderr: '' }; // no unmerged files
    if (args[0] === 'status') return { status: 0, stdout: ' M lib/web.js\n?? scratch.txt\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const dirty = fleet.landArrival({ worktreePath: '/wt', targetRef: 'origin/master', git: dirtyGit });
  assert.equal(dirty.ok, false);
  assert.equal(dirty.stage, 'dirty_worktree');
  assert.deepEqual(dirty.dirty, ['lib/web.js', 'scratch.txt']);
  assert.equal(dirty.conflicts, undefined, 'an empty conflicts list is never reported as a conflict');
});

// CLI-1190: a claude engine killed mid-flight (exit 143 / SIGTERM) returns an
// empty report. The restaff leg must name the signal instead of a silent no-op.
test('failedDispatchLeg names the signal for a killed engine with an empty report', () => {
  const watchdogReceipt = { schema: 'atris.codex_watchdog_receipt.v1', status: 'timed_out' };
  const exitLeg = fleet.failedDispatchLeg({ exitCode: 143, report: '', stderr: '', watchdog_receipt: watchdogReceipt }, 'claude');
  assert.equal(exitLeg.signal, 'SIGTERM');
  assert.equal(exitLeg.report, '(no report: killed by SIGTERM)');
  assert.deepEqual(exitLeg.watchdog_receipt, watchdogReceipt);

  const signalLeg = fleet.failedDispatchLeg({ status: null, signal: 'SIGKILL', report: '', stderr: '' }, 'claude');
  assert.equal(signalLeg.signal, 'SIGKILL');
  assert.equal(signalLeg.report, '(no report: killed by SIGKILL)');

  // a normal non-signal failure keeps its own report and grows no signal field.
  const plain = fleet.failedDispatchLeg({ exitCode: 1, report: 'engine died', stderr: 'boom' }, 'codex');
  assert.equal(plain.signal, undefined);
  assert.equal(plain.report, 'engine died');
});

test('detectDeadEngineDispatch flags a signalled leg distinctly from a plain nonzero exit', () => {
  assert.deepEqual(fleet.detectDeadEngineDispatch({ exitCode: 143, report: '' }), { reason: 'signalled', signal: 'SIGTERM', exitCode: 143 });
  assert.deepEqual(fleet.detectDeadEngineDispatch({ signal: 'SIGKILL', report: '' }), { reason: 'signalled', signal: 'SIGKILL', exitCode: null });
  assert.deepEqual(fleet.detectDeadEngineDispatch({ exitCode: 2, report: 'boom' }), { reason: 'nonzero_exit', exitCode: 2 });
});

test('only failed or empty engine-level output can refuse a build', () => {
  const sentence = 'Not logged in. Run: atris login';
  for (const field of ['report', 'stdout']) {
    assert.equal(fleet.detectDeadEngineDispatch({ exitCode: 0, [field]: sentence }), null);
    assert.equal(fleet.detectDeadEngineDispatch({ exitCode: 0, [field]: 'committed work', stderr: sentence }), null);
    assert.deepEqual(fleet.detectDeadEngineDispatch({ exitCode: 1, [field]: sentence }), { reason: 'nonzero_exit', exitCode: 1 });
  }
  for (const run of [
    { exitCode: 1, stderr: sentence },
    { exitCode: 0, stderr: sentence },
    { exitCode: 1, error: new Error(sentence) },
    { exitCode: 0, report: 'work', error: new Error(sentence) },
  ]) {
    assert.deepEqual(fleet.detectDeadEngineDispatch(run), { reason: 'engine_refused', detail: sentence, exitCode: run.exitCode });
  }
});

test('empty exit zero is no_output and missing exit metadata is unknown', () => {
  assert.deepEqual(fleet.detectDeadEngineDispatch({ exitCode: 0, report: ' \n', stderr: '' }), { reason: 'no_output', exitCode: 0 });
  assert.deepEqual(fleet.detectDeadEngineDispatch({ report: 'claimed success' }), { reason: 'unknown', exitCode: null });
  assert.deepEqual(fleet.detectDeadEngineDispatch({ report: 'usage limit reached' }), { reason: 'unknown', exitCode: null });

  const empty = fleet.dispatchResultToTerminal({ engine: 'codex', taskId: 'CLI-1' }, { exitCode: 0, report: '', stderr: '' });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'no_output');
  const unknown = fleet.dispatchResultToTerminal({ engine: 'codex', taskId: 'CLI-1' }, { report: 'answer' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'unknown');
  const stdout = fleet.dispatchResultToTerminal({ engine: 'codex', taskId: 'CLI-1' }, { exitCode: 0, stdout: 'answer' });
  assert.equal(stdout.ok, true);
  assert.equal(stdout.reason, 'ok');
  const mixed = fleet.dispatchResultToTerminal({ engine: 'codex', taskId: 'CLI-1' }, { exitCode: 0, report: ' ', stdout: 'answer' });
  assert.equal(mixed.ok, true);
  assert.equal(mixed.reason, 'ok');
});

test('defaultSelfLandCheck fetches the target ref and checks HEAD ancestry', () => {
  const calls = [];
  const result = fleet.defaultSelfLandCheck({
    worktreePath: '/wt',
    targetRef: 'origin/master',
    startCommit: 'base-commit',
    git: (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'new-commit\n', stderr: '' };
      if (args[0] === 'diff') return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(calls[0], ['rev-parse', '--verify', 'HEAD^{commit}']);
  assert.deepEqual(calls[1], ['diff', '--quiet', 'base-commit', 'new-commit', '--']);
  assert.deepEqual(calls[2], ['fetch', 'origin', 'master:refs/remotes/origin/master']);
  assert.deepEqual(calls[3], ['merge-base', '--is-ancestor', 'HEAD', 'origin/master']);
  assert.deepEqual(result, {
    ok: true,
    stage: 'self_landed',
    target: 'origin/master',
    start_commit: 'base-commit',
    head: 'new-commit',
  });
});

// A commit the engine made and did not land (a protected-lane builder only commits) is not on the
// target: the flight lands it itself, and a protected-lane task goes to a person from there.
test('defaultSelfLandCheck calls a committed branch that is not on the target self_land_missing', () => {
  const calls = [];
  const result = fleet.defaultSelfLandCheck({
    worktreePath: '/wt',
    targetRef: 'origin/master',
    startCommit: 'base-commit',
    git: (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'new-commit\n', stderr: '' };
      if (args[0] === 'diff') return { status: 1, stdout: '', stderr: '' };
      if (args[0] === 'merge-base') return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(calls[3], ['merge-base', '--is-ancestor', 'HEAD', 'origin/master']);
  assert.deepEqual(result, {
    ok: false,
    stage: 'self_land_missing',
    target: 'origin/master',
    start_commit: 'base-commit',
    head: 'new-commit',
    detail: 'HEAD is not an ancestor of origin/master',
  });
});

// The same check on real git, as a protected-lane builder leaves things: one commit on its branch and
// nothing pushed. That is not on the target, so the flight lands it. A pushed branch that was never
// merged is no more landed. Only a commit that reached the target reads as self-landed.
test('defaultSelfLandCheck, on real git, calls an unpushed commit and an unmerged pushed branch self_land_missing', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'self-land-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...args) => {
    const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    return run.stdout.trim();
  };
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  git(dir, 'init', '-q', '--bare', '--initial-branch=master', origin);
  git(dir, 'init', '-q', '--initial-branch=master', work);
  git(work, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(work, 'a.txt'), 'before\n');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'base');
  git(work, 'push', '-q', 'origin', 'master');
  const startCommit = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', '-b', 'task-branch');
  fs.writeFileSync(path.join(work, 'a.txt'), 'after\n');
  git(work, 'commit', '-qam', 'the fix');
  const check = () => fleet.defaultSelfLandCheck({ worktreePath: work, targetRef: 'origin/master', startCommit });

  const unpushed = check();
  assert.equal(unpushed.ok, false);
  assert.equal(unpushed.stage, 'self_land_missing');
  assert.equal(unpushed.head, git(work, 'rev-parse', 'HEAD'));

  git(work, 'push', '-q', 'origin', 'task-branch');
  assert.equal(check().stage, 'self_land_missing', 'a pushed branch that was not merged is not landed');

  git(work, 'push', '-q', 'origin', 'task-branch:master');
  const merged = check();
  assert.equal(merged.ok, true);
  assert.equal(merged.stage, 'self_landed');
});

test('defaultSelfLandCheck refuses an unchanged head before ancestry can read as success', () => {
  const calls = [];
  const result = fleet.defaultSelfLandCheck({
    worktreePath: '/wt',
    startCommit: 'base-commit',
    git: (args) => {
      calls.push(args);
      return { status: 0, stdout: 'base-commit\n', stderr: '' };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'no_work_landed');
  assert.equal(result.reason, 'no_work_landed');
  assert.equal(result.start_commit, result.head);
  assert.deepEqual(calls, [['rev-parse', '--verify', 'HEAD^{commit}']]);
});

test('defaultSelfLandCheck reports an empty commit as no work landed', () => {
  const calls = [];
  const result = fleet.defaultSelfLandCheck({
    worktreePath: '/wt',
    startCommit: 'base-commit',
    git: (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'empty-commit\n', stderr: '' };
      if (args[0] === 'diff') return { status: 0, stdout: '', stderr: '' };
      throw new Error('ancestry must not run for an empty diff');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'no_work_landed');
  assert.equal(result.start_commit, 'base-commit');
  assert.equal(result.head, 'empty-commit');
  assert.deepEqual(calls[1], ['diff', '--quiet', 'base-commit', 'empty-commit', '--']);
});

test('runFleetFlight dry-run staffs from the projection without dispatching', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-root-'));
  try {
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      tasks: [
        { display_id: 'F-1', status: 'open', title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.' },
        { display_id: 'F-2', status: 'open', title: 'edits lib/b.js Done: x. Check: node --test test/b.test.js.' },
        { display_id: 'F-3', status: 'open', title: 'deploy the site #deploy Done: x. Check: y.' },
      ],
    }));
    const lines = [];
    const flight = await fleet.runFleetFlight({
      root,
      engines: ['codex', 'cursor'],
      dryRun: true,
      log: (l) => lines.push(String(l)),
    });
    assert.equal(flight.dry_run, true);
    assert.deepEqual(flight.staffed.map((s) => s.task), ['F-1', 'F-2']);
    assert.deepEqual(flight.staffed.map((s) => s.engine), ['codex', 'cursor']);
    assert.ok(lines.some((l) => /2 tasks staffed/.test(l)));
    assert.equal(flight.results.length, 0, 'dry run must not dispatch');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runFleetFlight ranks its default primary engine only when executor history is rich', { concurrency: false }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-primary-router-'));
  const binDir = path.join(root, 'bin');
  const previousPath = process.env.PATH;
  try {
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [{ display_id: 'F-1', status: 'open', title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.' }],
    }));
    for (const name of ['claude', 'codex']) {
      fs.writeFileSync(path.join(binDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    process.env.PATH = `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`;

    const thin = await fleet.runFleetFlight({ root, dryRun: true, log: () => {} });
    assert.deepEqual(thin.roster, ['claude', 'codex']);
    assert.equal(thin.staffed[0].engine, 'claude');

    writeExecutorDispatchHistory(root, { claude: false, codex: true });
    const rich = await fleet.runFleetFlight({ root, dryRun: true, log: () => {} });
    assert.deepEqual(rich.roster, ['codex', 'claude']);
    assert.equal(rich.staffed[0].engine, 'codex');
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Like writeExecutorDispatchHistory but each engine gets its own outcome
// sequence, so pass rates can land inside the stretch zone band.
function writeMixedExecutorHistory(root, outcomesByEngine) {
  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const entries = Object.entries(outcomesByEngine);
  const count = entries[0][1].length;
  for (let index = 0; index < count; index += 1) {
    const at = `2026-07-${18 + index}T12:00:00.000Z`;
    const results = entries.map(([engine, outcomes]) => ({
      task: `CLI-${engine}-${index}`,
      engine,
      task_type: 'executor',
      verified_passed: outcomes[index],
      duration_ms: 1000,
      at,
      exitCode: outcomes[index] ? 0 : 1,
    }));
    fs.writeFileSync(path.join(runsDir, `dispatch-mixed-${index}.json`), `${JSON.stringify({
      schema: 'atris.dispatch_receipt.v1',
      results,
    })}\n`, 'utf8');
  }
}

test('rankFleetEnginesDetailed honors lowStakes: stretch zone pick beats the strongest engine', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-stretch-rank-'));
  try {
    // claude never fails (1.00, above the band); codex passes 2 of 3 (0.67, inside it).
    writeMixedExecutorHistory(root, {
      claude: [true, true, true],
      codex: [true, true, false],
    });
    const normal = fleet.rankFleetEnginesDetailed(['claude', 'codex'], root);
    assert.deepEqual(normal.candidates, ['claude', 'codex']);
    assert.equal(normal.stretch_zone_pick, null);
    const lowStakes = fleet.rankFleetEnginesDetailed(['claude', 'codex'], root, { lowStakes: true });
    assert.deepEqual(lowStakes.candidates, ['codex', 'claude']);
    assert.equal(lowStakes.stretch_zone_pick, 'codex');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runFleetFlight ranks safe-lane staffing low stakes and the receipt notes the stretch pick', { concurrency: false }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-stretch-flight-'));
  const binDir = path.join(root, 'bin');
  const previousPath = process.env.PATH;
  try {
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [{ display_id: 'F-1', status: 'open', title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.' }],
    }));
    for (const name of ['claude', 'codex']) {
      fs.writeFileSync(path.join(binDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    process.env.PATH = `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    writeMixedExecutorHistory(root, {
      claude: [true, true, true],
      codex: [true, true, false],
    });

    const flight = await fleet.runFleetFlight({ root, dryRun: true, log: () => {} });
    assert.equal(flight.staffed[0].engine, 'codex', 'safe-lane task gets the stretch zone engine');
    assert.equal(flight.stretch_zone_pick, 'codex');
    assert.match(flight.stretch_zone_note, /low-stakes staffing picked codex from the stretch zone/);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runFleetFlight never ranks protected or denied work low stakes', { concurrency: false }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-stretch-denied-'));
  const binDir = path.join(root, 'bin');
  const previousPath = process.env.PATH;
  try {
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [{ display_id: 'F-3', status: 'open', title: 'deploy the site #deploy Done: x. Check: y.' }],
    }));
    for (const name of ['claude', 'codex']) {
      fs.writeFileSync(path.join(binDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    process.env.PATH = `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`;
    writeMixedExecutorHistory(root, {
      claude: [true, true, true],
      codex: [true, true, false],
    });

    const flight = await fleet.runFleetFlight({ root, dryRun: true, log: () => {} });
    assert.equal(flight.staffed.length, 0, 'denied lane is never staffed');
    assert.deepEqual(flight.roster, ['claude', 'codex'], 'no low-stakes rank without a staffed safe-lane task');
    assert.equal(flight.stretch_zone_pick, null);
    assert.equal(flight.stretch_zone_note, undefined);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runFleetFlight full loop: claims, dispatches in parallel, lands serially, writes receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-root-'));
  try {
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      tasks: [
        { display_id: 'F-1', status: 'open', title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.' },
        { display_id: 'F-2', status: 'open', title: 'edits lib/b.js Done: x. Check: node --test test/b.test.js.' },
      ],
    }));
    const cliCalls = [];
    const ownCli = (args) => {
      cliCalls.push(args.join(' '));
      if (args[0] === 'worktree' && args[1] === 'start') {
        return { status: 0, stdout: `next: cd ${root}/wt-${cliCalls.length}\n`, stderr: '' };
      }
      return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
    };
    const landed = [];
    const flight = await fleet.runFleetFlight({
      root,
      engines: ['codex', 'cursor'],
      log: () => {},
      ownCli,
      dispatcher: (entry) => Promise.resolve({ exitCode: entry.task.display_id === 'F-2' ? 1 : 0, report: 'ok', stderr: entry.task.display_id === 'F-2' ? 'engine died' : '' }),
      lander: ({ entry }) => { landed.push(entry.task.display_id); return { ok: true, stage: 'shipped' }; },
    });
    // claims + worktrees per staffed task
    assert.ok(cliCalls.some((c) => c === `task claim F-1 --as fleet-codex --lease-minutes 60 --lease-pid ${process.pid}`));
    assert.ok(cliCalls.some((c) => c.startsWith('worktree start --agent cursor')));
    // failed build pauses with the worktree kept; good build lands + task ready
    assert.deepEqual(landed, ['F-1']);
    assert.deepEqual(flight.landed.map((l) => l.task), ['F-1']);
    assert.equal(flight.paused.length, 1);
    assert.equal(flight.paused[0].task, 'F-2');
    assert.ok(cliCalls.some((c) => c.startsWith('task ready F-1')));
    assert.ok(cliCalls.find((c) => c.startsWith('task ready F-1')).includes('Receipt saved at atris/runs/fleet-'), 'ready proof must cite the flight receipt path');
    assert.ok(!cliCalls.some((c) => c.startsWith('task ready F-2')));
    // receipt on disk, no other fleet state file anywhere
    assert.ok(fs.existsSync(flight.receipt));
    const receipt = JSON.parse(fs.readFileSync(flight.receipt, 'utf8'));
    assert.equal(receipt.landed.length, 1);
    assert.deepEqual(receipt.results[1].restaffed.failed_legs, [{
      engine: 'cursor',
      exitCode: 1,
      stderr: 'engine died',
      report: 'ok',
    }]);
    assert.deepEqual(receipt.paused[0].restaffed.failed_legs, receipt.results[1].restaffed.failed_legs);
    assert.ok(!fs.existsSync(path.join(root, '.atris', 'fleet.json')), 'fleet must not grow a state file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runFleetFlight fails closed when a claim loses a race', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-claim-race-'));
  try {
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      tasks: [
        { display_id: 'F-claim-lost', status: 'open', title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.' },
        { display_id: 'F-continues', status: 'open', title: 'edits lib/b.js Done: x. Check: node --test test/b.test.js.' },
      ],
    }));
    const cliCalls = [];
    const ownCli = (args) => {
      cliCalls.push(args.join(' '));
      if (args[0] === 'task' && args[1] === 'claim' && args[2] === 'F-claim-lost') {
        return { status: 1, stdout: '', stderr: 'already claimed by another agent' };
      }
      if (args[0] === 'worktree' && args[1] === 'start') {
        return { status: 0, stdout: `next: cd ${root}/wt-${cliCalls.length}\n`, stderr: '' };
      }
      return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
    };
    const dispatched = [];
    const landed = [];
    const lines = [];
    const flight = await fleet.runFleetFlight({
      root,
      engines: ['codex', 'cursor'],
      log: (line) => lines.push(String(line)),
      ownCli,
      dispatcher: (entry) => {
        dispatched.push(entry.task.display_id);
        return Promise.resolve({ exitCode: 0, report: 'ok', stderr: '' });
      },
      lander: ({ entry }) => { landed.push(entry.task.display_id); return { ok: true, stage: 'shipped' }; },
    });
    assert.deepEqual(flight.paused, [{ task: 'F-claim-lost', engine: 'codex', stage: 'claim', detail: 'already claimed by another agent' }]);
    assert.deepEqual(dispatched, ['F-continues']);
    assert.deepEqual(landed, ['F-continues']);
    assert.ok(!cliCalls.some((c) => c.startsWith('worktree start --agent codex')));
    assert.ok(!cliCalls.some((c) => c.startsWith('task ready F-claim-lost')));
    assert.ok(cliCalls.some((c) => c.startsWith('task ready F-continues')));
    assert.ok(lines.some((line) => /paused F-claim-lost at claim/.test(line)));
    assert.ok(fs.existsSync(flight.receipt));
    const receipt = JSON.parse(fs.readFileSync(flight.receipt, 'utf8'));
    assert.deepEqual(receipt.paused.find((entry) => entry.task === 'F-claim-lost'), {
      task: 'F-claim-lost',
      engine: 'codex',
      stage: 'claim',
      detail: 'already claimed by another agent',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// CLI-881: a flight launched from a long-lived feature-branch checkout must
// not cut its build worktrees from that branch — rebase-before-ship would then
// replay every feature commit onto master and pause at rebase_conflict. Fleet
// and dispatch both pass --base origin/master to `worktree start` by default.
function baseAfter(call) {
  const i = call.indexOf('--base');
  return i > -1 ? call[i + 1] : null;
}

test('runFleetFlight uses HEAD when no remote mainline is known', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-base-'));
  try {
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      tasks: [{ display_id: 'F-1', status: 'open', title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.' }],
    }));
    const startCalls = [];
    const ownCli = (args) => {
      if (args[0] === 'worktree' && args[1] === 'start') {
        startCalls.push(args);
        return { status: 0, stdout: `next: cd ${root}/wt\n`, stderr: '' };
      }
      return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
    };
    await fleet.runFleetFlight({
      root,
      engines: ['codex'],
      log: () => {},
      ownCli,
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'ok', stderr: '' }),
      lander: () => ({ ok: true, stage: 'shipped' }),
    });
    assert.equal(startCalls.length, 1);
    assert.equal(baseAfter(startCalls[0]), 'HEAD', 'unknown mainline must not invent origin/master');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runFleetFlight keeps launcher-HEAD only when checkoutBase is explicit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-base-'));
  try {
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      tasks: [{ display_id: 'F-1', status: 'open', title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.' }],
    }));
    const startCalls = [];
    const ownCli = (args) => {
      if (args[0] === 'worktree' && args[1] === 'start') {
        startCalls.push(args);
        return { status: 0, stdout: `next: cd ${root}/wt\n`, stderr: '' };
      }
      return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
    };
    await fleet.runFleetFlight({
      root,
      engines: ['codex'],
      log: () => {},
      ownCli,
      checkoutBase: 'HEAD',
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'ok', stderr: '' }),
      lander: () => ({ ok: true, stage: 'shipped' }),
    });
    assert.equal(baseAfter(startCalls[0]), 'HEAD', 'explicit checkoutBase overrides the origin/master default');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runDispatchFlight uses HEAD when no remote mainline is known', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-base-'));
  try {
    const startCalls = [];
    const ownCli = (args) => {
      if (args[0] === 'task' && args[1] === 'show') {
        return { status: 0, stdout: JSON.stringify({ display_id: 'D-1', status: 'open', title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.' }), stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'start') {
        startCalls.push(args);
        return { status: 0, stdout: `next: cd ${root}/wt\n`, stderr: '' };
      }
      return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
    };
    await fleet.runDispatchFlight({
      root,
      taskIds: ['D-1'],
      engine: 'codex',
      log: () => {},
      ownCli,
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'ok', stderr: '' }),
      lander: () => ({ ok: true, stage: 'shipped', check: 'node --test test/a.test.js', verifyOutput: 'ok' }),
    });
    assert.equal(startCalls.length, 1);
    assert.equal(baseAfter(startCalls[0]), 'HEAD', 'unknown mainline must not invent origin/master');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fleet landings ship with an explicit master target, never the launcher branch base', () => {
  const args = fleet.fleetShipArgs(
    { task: { display_id: 'F-9', title: 'fix the thing. Done: x.' }, engine: 'cursor' },
    'node --test test/a.test.js',
    'origin/master'
  );
  const target = args.indexOf('--target');
  assert.ok(target > -1, 'ship args must carry --target');
  assert.equal(args[target + 1], 'origin/master');
  assert.ok(args.includes('--merge'));
  assert.ok(args.join(' ').includes('(F-9, built by cursor)'));
});

test('headTail keeps MODULE_NOT_FOUND head with a stack tail', () => {
  const head = "Error: Cannot find module 'missing-mod'\nMODULE_NOT_FOUND: cannot find missing-mod\n";
  const stack = Array.from({ length: 80 }, (_, i) =>
    `    at Object.<anonymous> (node:internal/modules/cjs/loader:${1000 + i}:10)`
  ).join('\n');
  const text = head + stack;
  const clipped = fleet.headTail(text, 400, 500);
  assert.match(clipped, /MODULE_NOT_FOUND: cannot find missing-mod/);
  assert.match(clipped, /node:internal\/modules\/cjs\/loader/);
  assert.ok(clipped.includes(' … '));
  assert.ok(clipped.length < text.length);
  assert.equal(fleet.headTail('short'), 'short');
  assert.equal(fleet.clipHeadTail(text, { head: 400, tail: 500 }), clipped);
});

test('runFleetFlight ship failure receipt keeps the failing module at the head', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ship-fail-'));
  try {
    const stateDir = path.join(root, '.atris', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({
      tasks: [{ display_id: 'F-1', status: 'open', title: 'edits lib/a.js Done: x. Check: node --test test/a.test.js.' }],
    }));
    const head = "Error: Cannot find module 'atris-ship-helper'\nMODULE_NOT_FOUND: cannot find atris-ship-helper\nRequire stack:\n";
    const stack = Array.from({ length: 100 }, (_, i) =>
      `    at Module.require (node:internal/modules/cjs/loader:${2000 + i}:17)`
    ).join('\n');
    const shipErr = head + stack;
    const ownCli = (args) => {
      if (args[0] === 'worktree' && args[1] === 'start') {
        return { status: 0, stdout: `next: cd ${root}/wt\n`, stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'ship') {
        return { status: 1, stdout: '', stderr: shipErr };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const flight = await fleet.runFleetFlight({
      root,
      engines: ['cursor'],
      log: () => {},
      ownCli,
      dispatcher: () => Promise.resolve({ exitCode: 0, report: 'ok', stderr: '' }),
      rebase: () => ({ ok: true, stage: 'rebased' }),
    });
    assert.equal(flight.landed.length, 0);
    assert.equal(flight.paused.length, 1);
    assert.equal(flight.paused[0].stage, 'ship');
    assert.doesNotMatch(shipErr.slice(-500), /MODULE_NOT_FOUND/, 'a tail-only clip would have dropped the cause');
    assert.match(flight.paused[0].detail, /MODULE_NOT_FOUND: cannot find atris-ship-helper/);
    assert.match(flight.paused[0].detail, /node:internal\/modules\/cjs\/loader/);
    const receipt = JSON.parse(fs.readFileSync(flight.receipt, 'utf8'));
    assert.match(receipt.paused[0].detail, /MODULE_NOT_FOUND: cannot find atris-ship-helper/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function withCleanClaudeRunnerEnv(overrides, fn) {
  const keys = [
    'ATRIS_RUNNER_PROFILE',
    'ATRIS_RUNNER_MODEL',
    'ATRIS_RUNNER_BIN',
    'ATRIS_RUNNER_COMMAND_TEMPLATE',
    'ATRIS_CLAUDE_MODEL',
    'ATRIS_CLAUDE_BIN',
    'ATRIS_CLAUDE_COMMAND_TEMPLATE',
    'ATRIS_CLAUDE_SPEND_OK',
    'HOME',
    'CLAUDE_CONFIG_DIR',
  ];
  const prev = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-opus-effort-home-'));
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  for (const [key, value] of Object.entries(overrides || {})) process.env[key] = value;
  try {
    return fn();
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of keys) {
      const value = prev.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('isBugFixTask accepts concrete bug-fix tasks and rejects features, refactors, UI, docs, and sensitive work', () => {
  // Accepted bug-fix tasks
  assert.equal(fleet.isBugFixTask({ title: 'Fix null crash in lib/fleet.js', tag: 'cli', files: ['lib/fleet.js'] }), true);
  assert.equal(fleet.isBugFixTask({ title: 'Guard against stale lease in lib/fleet.js', files: ['lib/fleet.js'] }), true);
  assert.equal(fleet.isBugFixTask({ title: 'Prevent timeout hang in lib/fleet.js', files: ['lib/fleet.js'] }), true);
  assert.equal(fleet.isBugFixTask({ title: 'Update lib/fleet.js parser', tag: 'bug', files: ['lib/fleet.js'] }), true);

  // Rejected features, refactors, UI, docs, ambiguous, and sensitive/protected tasks
  const rejected = [
    { title: 'Add new flag to lib/fleet.js', tag: 'cli', files: ['lib/fleet.js'] },
    { title: 'Add regression test and fix bug in lib/fleet.js', tag: 'cli', files: ['lib/fleet.js'] },
    { title: 'Create status command in commands/status.js', tag: 'feature', files: ['commands/status.js'] },
    { title: 'Build helper in lib/fleet.js', files: ['lib/fleet.js'] },
    { title: 'Refactor parser in lib/fleet.js', files: ['lib/fleet.js'] },
    { title: 'Fix null crash in lib/fleet.js', tag: 'feature', files: ['lib/fleet.js'] },
    { title: 'Fix null crash in lib/fleet.js', tag: 'refactor', files: ['lib/fleet.js'] },
    { title: 'Fix null crash in lib/fleet.js', tag: 'ui', files: ['lib/fleet.js'] },
    { title: 'Fix UI layout glitch in src/panel.js', files: ['src/panel.js'] },
    { title: 'Fix CSS theme mismatch in src/app.css', files: ['src/app.css'] },
    { title: 'Polish copy in lib/fleet.js', files: ['lib/fleet.js'] },
    { title: 'Fix typo in docs/README.md', files: ['docs/README.md'] },
    { title: 'Fix sign-in redirect error in lib/session.js', files: ['lib/session.js'] },
    { title: 'Fix auth login crash in lib/auth.js', files: ['lib/auth.js'] },
    { title: 'Fix billing invoice rounding bug in lib/calc.js', files: ['lib/calc.js'] },
    { title: 'Fix release publish error in scripts/ship.js', files: ['scripts/ship.js'] },
    { title: 'Fix security RBAC permission leak in lib/acl.js', files: ['lib/acl.js'] },
    { title: 'Update lib/fleet.js', tag: 'cli', files: ['lib/fleet.js'] },
  ];
  for (const task of rejected) {
    assert.equal(fleet.isBugFixTask(task), false, task.title);
  }
});

test('opusBugfixEffortDecision splits eligible single-file Opus bug-fix tasks 50/50 by task id and fails closed when missing id', () => {
  assert.equal(fleet.OPUS_BUGFIX_LOW_EFFORT_AB_ENABLED, true);
  withCleanClaudeRunnerEnv({}, () => {
    const base = {
      title: 'Fix stale lease crash in lib/fleet.js',
      tag: 'cli',
      files: ['lib/fleet.js'],
    };

    // Even numeric ids -> low arm
    for (const id of ['t-104', '104', 104, 'CLI-200']) {
      assert.deepEqual(
        fleet.opusBugfixEffortDecision({ ...base, id }, 'claude', 'claude-opus-5-5', ''),
        { effort: 'low', experimentSide: 'low' },
        String(id)
      );
      assert.equal(fleet.smallSinglePlaceOpusEffort({ ...base, id }, 'claude', 'claude-opus-5-5', ''), 'low', String(id));
    }
    assert.deepEqual(
      fleet.opusBugfixEffortDecision({ ...base, id: 't-104' }, 'claude', 'opus 5.5', ''),
      { effort: 'low', experimentSide: 'low' }
    );
    assert.deepEqual(
      fleet.opusBugfixEffortDecision({ id: 't-104', title: 'Fix stale check', metadata: { files: ['./lib/fleet.js'] } }, 'claude', 'claude-opus-5-5', ''),
      { effort: 'low', experimentSide: 'low' }
    );

    // Odd numeric ids -> default arm (enrolled in A/B, no --effort override)
    for (const id of ['t-105', '105', 105, 'CLI-201']) {
      assert.deepEqual(
        fleet.opusBugfixEffortDecision({ ...base, id }, 'claude', 'claude-opus-5-5', ''),
        { effort: '', experimentSide: 'default' },
        String(id)
      );
      assert.equal(fleet.smallSinglePlaceOpusEffort({ ...base, id }, 'claude', 'claude-opus-5-5', ''), '', String(id));
    }

    // Non-numeric ULID / hash -> deterministic 0/1 parity
    const ulidA = fleet.opusBugfixEffortDecision({ ...base, id: '01JABC9XYZ0001' }, 'claude', 'claude-opus-5-5', '');
    const ulidARepeat = fleet.opusBugfixEffortDecision({ ...base, id: '01JABC9XYZ0001' }, 'claude', 'claude-opus-5-5', '');
    assert.deepEqual(ulidA, ulidARepeat);
    assert.ok(['low', 'default'].includes(ulidA.experimentSide));

    // Missing or empty task id -> fail closed (not enrolled, default effort)
    assert.deepEqual(
      fleet.opusBugfixEffortDecision({ ...base }, 'claude', 'claude-opus-5-5', ''),
      { effort: '', experimentSide: null }
    );
    assert.deepEqual(
      fleet.opusBugfixEffortDecision({ ...base, id: '' }, 'claude', 'claude-opus-5-5', ''),
      { effort: '', experimentSide: null }
    );

    // Kill switch disables experiment completely
    assert.deepEqual(
      fleet.opusBugfixEffortDecision({ ...base, id: 't-104' }, 'claude', 'claude-opus-5-5', '', { abEnabled: false }),
      { effort: '', experimentSide: null }
    );
  });

  withCleanClaudeRunnerEnv({ ATRIS_RUNNER_MODEL: 'claude-opus-5-5' }, () => {
    assert.deepEqual(
      fleet.opusBugfixEffortDecision({ id: 't-104', title: 'Fix null error in lib/fleet.js' }, 'claude', '', ''),
      { effort: 'low', experimentSide: 'low' }
    );
  });
});

test('opusBugfixEffortDecision skips explicit effort, non-bugfix, multi-file, globs, dirs, protected, validator, and non-opus/non-claude tasks', () => {
  withCleanClaudeRunnerEnv({}, () => {
    const base = {
      id: 't-104',
      title: 'Fix null crash in lib/fleet.js',
      tag: 'cli',
      files: ['lib/fleet.js'],
    };

    // Explicit effort pins are never overridden and not enrolled; whitespace-only effort falls through.
    assert.deepEqual(fleet.opusBugfixEffortDecision(base, 'claude', 'claude-opus-5-5', 'high'), { effort: '', experimentSide: null });
    assert.deepEqual(fleet.opusBugfixEffortDecision(base, 'claude', 'claude-opus-5-5', 'medium'), { effort: '', experimentSide: null });
    assert.deepEqual(fleet.opusBugfixEffortDecision(base, 'claude', 'claude-opus-5-5', '   '), { effort: 'low', experimentSide: 'low' });

    // Directories, globs, extensionless paths, and URLs are rejected.
    assert.deepEqual(fleet.opusBugfixEffortDecision({ id: 't-104', title: 'Fix crash', tag: 'cli', files: ['lib/'] }, 'claude', 'claude-opus-5-5', ''), { effort: '', experimentSide: null });
    assert.deepEqual(fleet.opusBugfixEffortDecision({ id: 't-104', title: 'Fix crash', tag: 'cli', files: ['lib/*.js'] }, 'claude', 'claude-opus-5-5', ''), { effort: '', experimentSide: null });
    assert.deepEqual(fleet.opusBugfixEffortDecision({ id: 't-104', title: 'Fix crash', tag: 'cli', files: ['lib/foo'] }, 'claude', 'claude-opus-5-5', ''), { effort: '', experimentSide: null });
    assert.deepEqual(fleet.opusBugfixEffortDecision({ id: 't-104', title: 'Fix crash in lib/foo/', tag: 'cli' }, 'claude', 'claude-opus-5-5', ''), { effort: '', experimentSide: null });
    assert.deepEqual(fleet.opusBugfixEffortDecision({ id: 't-104', title: 'Fix crash in lib/foo/*.js', tag: 'cli' }, 'claude', 'claude-opus-5-5', ''), { effort: '', experimentSide: null });
    assert.deepEqual(fleet.opusBugfixEffortDecision({ id: 't-104', title: 'Fix crash in lib/foo/{a,b}.js', tag: 'cli' }, 'claude', 'claude-opus-5-5', ''), { effort: '', experimentSide: null });
    assert.deepEqual(fleet.opusBugfixEffortDecision({ id: 't-104', title: 'Fix crash see https://example.com/docs/index.html', tag: 'cli' }, 'claude', 'claude-opus-5-5', ''), { effort: '', experimentSide: null });

    // Multi-file tasks (including non-prefix paths like utils/b.js and objective/description mentions) are not enrolled.
    assert.deepEqual(
      fleet.opusBugfixEffortDecision({ ...base, files: ['lib/fleet.js', 'test/fleet.test.js'] }, 'claude', 'claude-opus-5-5', ''),
      { effort: '', experimentSide: null }
    );
    assert.deepEqual(
      fleet.opusBugfixEffortDecision({ id: 't-104', title: 'Fix crash in lib/a.js and utils/b.js', tag: 'cli' }, 'claude', 'claude-opus-5-5', ''),
      { effort: '', experimentSide: null }
    );
    assert.deepEqual(
      fleet.opusBugfixEffortDecision({ id: 't-104', title: 'Fix crash in lib/a.js', objective: 'Also fix utils/b.js', tag: 'cli' }, 'claude', 'claude-opus-5-5', ''),
      { effort: '', experimentSide: null }
    );
    assert.deepEqual(
      fleet.opusBugfixEffortDecision({ id: 't-104', title: 'Fix crash in lib/a.js', description: 'Touches utils/b.js too', tag: 'cli' }, 'claude', 'claude-opus-5-5', ''),
      { effort: '', experimentSide: null }
    );

    // Blind tasks (no declared files or surface) are not enrolled.
    assert.deepEqual(
      fleet.opusBugfixEffortDecision({ id: 't-104', title: 'Fix vague crash', tag: 'cli' }, 'claude', 'claude-opus-5-5', ''),
      { effort: '', experimentSide: null }
    );

    // Protected lanes, sensitive tags, sensitive paths, and declared/sniffed protected tasks are not enrolled.
    for (const lane of ['money', 'security', 'deploy', 'Deploys', 'infra-deploy', 'outward', 'release', 'publish']) {
      assert.deepEqual(
        fleet.opusBugfixEffortDecision({ ...base, tag: lane }, 'claude', 'claude-opus-5-5', ''),
        { effort: '', experimentSide: null },
        lane
      );
    }
    assert.deepEqual(
      fleet.opusBugfixEffortDecision({ id: 't-104', title: 'Fix crash in lib/auth.js', tag: 'cli', files: ['lib/auth.js'] }, 'claude', 'claude-opus-5-5', ''),
      { effort: '', experimentSide: null }
    );
    assert.deepEqual(
      fleet.opusBugfixEffortDecision({ id: 't-104', title: 'Fix crash in lib/fleet.js (human review required)', files: ['lib/fleet.js'] }, 'claude', 'claude-opus-5-5', ''),
      { effort: '', experimentSide: null }
    );
    assert.deepEqual(
      fleet.opusBugfixEffortDecision({ id: 't-104', title: 'Fix stripe invoice retry in lib/retry.js', files: ['lib/retry.js'] }, 'claude', 'claude-opus-5-5', ''),
      { effort: '', experimentSide: null }
    );

    // Review / validator dispatches are never enrolled and stay on default.
    assert.deepEqual(fleet.opusBugfixEffortDecision(base, 'claude', 'claude-opus-5-5', '', { isReview: true }), { effort: '', experimentSide: null });
    assert.deepEqual(fleet.opusBugfixEffortDecision(base, 'claude', 'claude-opus-5-5', '', { role: 'validator' }), { effort: '', experimentSide: null });

    // options.env overrides process.env for model resolution.
    assert.deepEqual(
      fleet.opusBugfixEffortDecision(base, 'claude', '', '', { env: { ATRIS_RUNNER_MODEL: 'claude-opus-5-5' } }),
      { effort: 'low', experimentSide: 'low' }
    );

    // Deep / refactor / migration / overhaul / feature / UI titles are not enrolled.
    for (const title of [
      'Refactor auth architecture in lib/fleet.js',
      'Migrate lib/fleet.js parser',
      'Overhaul lib/fleet.js dispatch flow',
      'Add new option to lib/fleet.js',
      'Fix UI layout glitch in lib/fleet.js',
    ]) {
      assert.deepEqual(
        fleet.opusBugfixEffortDecision({ ...base, title }, 'claude', 'claude-opus-5-5', ''),
        { effort: '', experimentSide: null },
        title
      );
    }

    // Non-Opus models and non-claude engines are not enrolled.
    assert.deepEqual(fleet.opusBugfixEffortDecision(base, 'claude', 'claude-haiku-5-5', ''), { effort: '', experimentSide: null });
    assert.deepEqual(fleet.opusBugfixEffortDecision(base, 'claude', 'claude-sonnet-5-5', ''), { effort: '', experimentSide: null });
    assert.deepEqual(fleet.opusBugfixEffortDecision(base, 'claude', '', ''), { effort: '', experimentSide: null });
    assert.deepEqual(fleet.opusBugfixEffortDecision(base, 'codex', 'claude-opus-5-5', ''), { effort: '', experimentSide: null });
    assert.deepEqual(fleet.opusBugfixEffortDecision(base, 'cursor', 'claude-opus-5-5', ''), { effort: '', experimentSide: null });
  });
});

test('dispatchToEngine and roster_runs.jsonl record effort_experiment_side for both low and default A/B arms and skip unenrolled runs', () => {
  const { readRosterRuns } = require('../lib/roster-runs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-opus-ab-root-'));
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-opus-ab-wt-'));
  try {
    withCleanClaudeRunnerEnv({}, () => {
      const seen = [];
      const runner = (cmd) => {
        seen.push(cmd);
        return { status: 0, stdout: 'ok', stderr: '' };
      };
      const evenBug = {
        id: 't-104',
        display_id: 'CLI-104',
        title: 'Fix null crash in lib/fleet.js Done: crash fixed. Check: npm run test:fast.',
        tag: 'cli',
        files: ['lib/fleet.js'],
      };
      const oddBug = {
        ...evenBug,
        id: 't-105',
        display_id: 'CLI-105',
      };

      // Even arm -> --effort low, recorded as effort_experiment_side: 'low'
      const evenRes = fleet.dispatchToEngine({
        task: evenBug,
        engine: 'claude',
        model: 'claude-opus-5-5',
        worktreePath: wt,
        skipBriefCapture: true,
        runner,
      });
      assert.match(seen[0], /--model claude-opus-5-5 --effort low\b/);
      assert.equal(evenRes.effort, 'low');
      assert.equal(evenRes.effort_experiment_side, 'low');
      fleet.recordDispatchOutcome(root, {
        engine: 'claude',
        pin: { model: 'claude-opus-5-5' },
        startedMs: Date.now() - 5000,
        endedMs: Date.now(),
        result: evenRes,
        task: evenBug.display_id,
      });

      // Odd arm -> default effort (no --effort flag), recorded as effort_experiment_side: 'default'
      const oddRes = fleet.dispatchToEngine({
        task: oddBug,
        engine: 'claude',
        model: 'claude-opus-5-5',
        worktreePath: wt,
        skipBriefCapture: true,
        runner,
      });
      assert.doesNotMatch(seen[1], /--effort\b/);
      assert.equal(oddRes.effort, undefined);
      assert.equal(oddRes.effort_experiment_side, 'default');
      fleet.recordDispatchOutcome(root, {
        engine: 'claude',
        pin: { model: 'claude-opus-5-5' },
        startedMs: Date.now() - 5000,
        endedMs: Date.now(),
        result: oddRes,
        task: oddBug.display_id,
      });

      // Explicit --effort high overrides and is NOT tagged as A/B
      const pinnedRes = fleet.dispatchToEngine({
        task: evenBug,
        engine: 'claude',
        model: 'claude-opus-5-5',
        effort: 'high',
        worktreePath: wt,
        skipBriefCapture: true,
        runner,
      });
      assert.match(seen[2], /--model claude-opus-5-5 --effort high\b/);
      assert.doesNotMatch(seen[2], /--effort low\b/);
      assert.equal(pinnedRes.effort_experiment_side, undefined);
      fleet.recordDispatchOutcome(root, {
        engine: 'claude',
        pin: { model: 'claude-opus-5-5', effort: 'high' },
        startedMs: Date.now() - 5000,
        endedMs: Date.now(),
        result: pinnedRes,
        task: 'CLI-104-PIN',
      });

      // Validator dispatch stays on default and is NOT tagged as A/B
      const valRes = fleet.dispatchToEngine({
        task: evenBug,
        engine: 'claude',
        model: 'claude-opus-5-5',
        isReview: true,
        role: 'validator',
        allowedTools: 'Bash,Read,Grep,Glob',
        worktreePath: wt,
        skipBriefCapture: true,
        runner,
      });
      assert.doesNotMatch(seen[3], /--effort\b/);
      assert.equal(valRes.effort_experiment_side, undefined);

      // Whitespace-only effort falls through cleanly to even arm low
      const wsRes = fleet.dispatchToEngine({
        task: evenBug,
        engine: 'claude',
        model: 'claude-opus-5-5',
        effort: '   ',
        worktreePath: wt,
        skipBriefCapture: true,
        runner,
      });
      assert.match(seen[4], /--model claude-opus-5-5 --effort low\b/);
      assert.equal(wsRes.effort_experiment_side, 'low');

      // Missing task id fails closed: no --effort, not tagged as A/B
      const noIdRes = fleet.dispatchToEngine({
        task: { title: 'Fix null crash in lib/fleet.js Done: fixed. Check: ok.', tag: 'cli', files: ['lib/fleet.js'] },
        engine: 'claude',
        model: 'claude-opus-5-5',
        worktreePath: wt,
        skipBriefCapture: true,
        runner,
      });
      assert.doesNotMatch(seen[5], /--effort\b/);
      assert.equal(noIdRes.effort_experiment_side, undefined);

      // Persisted roster_runs.jsonl preserves effort_experiment_side for both arms and omits it on pinned runs
      const runs = readRosterRuns(root);
      assert.equal(runs.length, 3);
      assert.equal(runs[0].task, 'CLI-104');
      assert.equal(runs[0].effort, 'low');
      assert.equal(runs[0].effort_experiment_side, 'low');
      assert.equal(runs[1].task, 'CLI-105');
      assert.equal(runs[1].effort, undefined);
      assert.equal(runs[1].effort_experiment_side, 'default');
      assert.equal(runs[2].task, 'CLI-104-PIN');
      assert.equal(runs[2].effort, 'high');
      assert.equal(runs[2].effort_experiment_side, undefined);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wt, { recursive: true, force: true });
  }
});
