'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { addIdea, readIdeas, updateIdea } = require('../lib/idea-inbox');
const {
  IDEA_BRIEF,
  acquireTickLock,
  fastCheck,
  lockFile,
  releaseTickLock,
  runIdeaTick,
  shipArgsFor,
} = require('../lib/idea-tick');
const fleet = require('../lib/fleet');

function tempRepo({ scripts = { 'test:fast': 'node --test', test: 'node --test' } } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-idea-tick-')));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts }));
  return dir;
}

function doneLap(overrides = {}) {
  return {
    status: 'done',
    task_id: 'T-7',
    engine: 'claude',
    changed: 'Make the inbox search faster',
    worktree: '/wt/review-t-7',
    result: {
      passed: true,
      validator_result: { passed: true, independent: true, engine: 'codex', executor_engine: 'claude', worktree_unchanged: true },
    },
    ...overrides,
  };
}

function harness({ lap = doneLap(), change = { ok: true, paths: ['lib/search.js', 'test/search.test.js'], addedLines: ['const fast = true;'] }, shipOut = { status: 0, stdout: 'pr: https://github.com/o/r/pull/9\nmerge: merged\ndone: worktree shipped\n', stderr: '' } } = {}) {
  const calls = { laps: [], ships: [], logs: [] };
  return {
    calls,
    deps: {
      log: (line) => calls.logs.push(line),
      runLap: async (text, options) => {
        calls.laps.push({ text, options });
        if (lap) options.onResult(typeof lap === 'function' ? lap(text) : lap);
        return 0;
      },
      ship: (worktree, args) => {
        calls.ships.push({ worktree, args });
        return shipOut;
      },
      inspectChange: () => change,
      landTarget: () => 'origin/master',
    },
  };
}

test('a tick builds the oldest waiting idea and lands it with the link', async () => {
  const repo = tempRepo();
  const first = addIdea(repo, 'make the inbox search faster');
  addIdea(repo, 'speed up the test runner');
  const { calls, deps } = harness();

  const outcome = await runIdeaTick({ root: repo, ...deps });

  assert.equal(outcome.status, 'landed');
  assert.equal(calls.laps.length, 1);
  assert.equal(calls.laps[0].text, 'make the inbox search faster');
  assert.equal(calls.laps[0].options.verifier, 'npm run test:fast');
  const idea = readIdeas(repo).find((row) => row.id === first.id);
  assert.equal(idea.status, 'landed');
  assert.equal(idea.link, 'https://github.com/o/r/pull/9');
  assert.equal(idea.task_id, 'T-7');
  assert.equal(readIdeas(repo)[1].status, 'waiting', 'one idea per tick');

  const ship = calls.ships[0];
  assert.equal(ship.worktree, '/wt/review-t-7');
  assert.deepEqual(ship.args.slice(0, 2), ['worktree', 'ship']);
  assert.equal(ship.args[ship.args.indexOf('--verify') + 1], 'npm run test:fast');
  for (const flag of ['--force', '--force-with-lease', '--no-verify']) assert.equal(ship.args.includes(flag), false);
  assert.equal(fs.existsSync(lockFile(repo)), false, 'the lock is released');
});

test('the build gets a time cap and the house rules in its brief', async () => {
  const repo = tempRepo();
  addIdea(repo, 'make the inbox search faster');
  const { calls, deps } = harness();
  await runIdeaTick({ root: repo, ...deps, maxSeconds: 600 });
  const options = calls.laps[0].options;
  assert.equal(options.maxSeconds, 600);
  assert.equal(options.brief, IDEA_BRIEF);
  for (const words of [/Acceleration/, /Accuracy/, /Ambition/, /Agency/, /Never force-push/, /no --no-verify/, /never stash/]) {
    assert.match(IDEA_BRIEF, words);
  }
});

test('a second tick waits while the first holds the lock, and a dead holder is taken over', async () => {
  const repo = tempRepo();
  addIdea(repo, 'make the inbox search faster');
  const held = acquireTickLock(repo);
  assert.equal(held.ok, true);
  const { calls, deps } = harness();
  const busy = await runIdeaTick({ root: repo, ...deps });
  assert.equal(busy.status, 'busy');
  assert.equal(calls.laps.length, 0);
  releaseTickLock(held);

  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.on('exit', resolve));
  fs.writeFileSync(lockFile(repo), JSON.stringify({ pid: child.pid, token: 'gone', started_at: new Date().toISOString() }));
  const taken = await runIdeaTick({ root: repo, ...deps });
  assert.equal(taken.status, 'landed');
});

test('a build that does not pass is refused with a one-line why and the next tick moves on', async () => {
  const repo = tempRepo();
  addIdea(repo, 'make the inbox search faster');
  addIdea(repo, 'speed up the test runner');
  const lap = (text) => (text.startsWith('make') ? { status: 'stuck', task_id: 'T-1', reason: 'npm run test:fast failed (exit 1)' } : doneLap());
  const { deps } = harness({ lap });
  const first = await runIdeaTick({ root: repo, ...deps });
  assert.equal(first.status, 'refused');
  assert.match(readIdeas(repo)[0].reason, /the build did not pass: npm run test:fast failed/);
  const second = await runIdeaTick({ root: repo, ...deps });
  assert.equal(second.status, 'landed');
  assert.equal(readIdeas(repo)[1].status, 'landed');
});

test('a change the builder alone vouched for never lands', async () => {
  for (const validator of [
    null,
    { passed: true, independent: true, engine: 'claude', executor_engine: 'claude' },
    { passed: false, independent: true, engine: 'codex', executor_engine: 'claude' },
  ]) {
    const repo = tempRepo();
    addIdea(repo, 'make the inbox search faster');
    const { calls, deps } = harness({ lap: doneLap({ result: { passed: true, validator_result: validator } }) });
    const outcome = await runIdeaTick({ root: repo, ...deps });
    assert.equal(outcome.status, 'refused');
    assert.match(readIdeas(repo)[0].reason, /no second engine signed off/);
    assert.equal(calls.ships.length, 0);
  }
});

test('a built change touching migrations or auth waits for the owner instead of landing', async () => {
  for (const change of [
    { ok: true, paths: ['db/migrations/0042_tags.sql'], addedLines: [] },
    { ok: true, paths: ['lib/auth.js'], addedLines: [] },
    { ok: true, paths: ['lib/search.js'], addedLines: ['db.run("DROP TABLE users")'] },
  ]) {
    const repo = tempRepo();
    addIdea(repo, 'make the inbox search faster');
    const { calls, deps } = harness({ change });
    const outcome = await runIdeaTick({ root: repo, ...deps });
    assert.equal(outcome.status, 'refused');
    assert.match(readIdeas(repo)[0].reason, /needs owner; it waits in review as T-7/);
    assert.equal(calls.ships.length, 0);
  }
});

test('a question from the build becomes a refusal that names it', async () => {
  const repo = tempRepo();
  addIdea(repo, 'make the inbox search faster');
  const { calls, deps } = harness({ lap: { status: 'waiting_input', question: 'which inbox, mail or tasks?' } });
  await runIdeaTick({ root: repo, ...deps });
  assert.match(readIdeas(repo)[0].reason, /needs your answer: which inbox, mail or tasks\?/);
  assert.equal(calls.ships.length, 0);
});

test('a refused-at-intake idea is skipped, and a failed landing is refused', async () => {
  const repo = tempRepo();
  addIdea(repo, 'rotate the oauth tokens');
  addIdea(repo, 'make the inbox search faster');
  const { calls, deps } = harness({ shipOut: { status: 1, stdout: 'verify: npm run test:fast\n', stderr: 'blocked: branch does not merge cleanly into origin/master\n' } });
  const outcome = await runIdeaTick({ root: repo, ...deps });
  assert.equal(calls.laps.length, 1);
  assert.equal(calls.laps[0].text, 'make the inbox search faster');
  assert.equal(outcome.status, 'refused');
  assert.match(readIdeas(repo)[1].reason, /did not land: blocked: branch does not merge cleanly/);
});

test('a build cut off mid-flight goes back in line once, then stops for the owner', async () => {
  const repo = tempRepo();
  const idea = addIdea(repo, 'make the inbox search faster');
  updateIdea(repo, idea.id, { status: 'building', attempts: 1 });
  const { deps } = harness({ lap: null });
  await runIdeaTick({ root: repo, ...deps });
  assert.equal(readIdeas(repo)[0].attempts, 2);
  updateIdea(repo, idea.id, { status: 'building' });
  const { calls, deps: again } = harness();
  const loopRepo = tempRepo();
  await runIdeaTick({ root: repo, loopRepo, ...again });
  assert.equal(calls.laps.length, 0);
  assert.match(readIdeas(repo)[0].reason, /stopped 2 times without finishing/);
  // Stopping mid-build twice in a day is the loop's own problem, so it files
  // one idea about itself in the loop's repo.
  assert.match(readIdeas(loopRepo)[0].text, /^make the idea loop handle "the build stopped without finishing" at the build stage/);
});

test('the fast check prefers test:fast, honors --verify, and never guesses for a bare repo', () => {
  assert.equal(fastCheck(tempRepo()), 'npm run test:fast');
  assert.equal(fastCheck(tempRepo({ scripts: { test: 'bash scripts/test_fast.sh' } })), 'npm test');
  assert.equal(fastCheck(tempRepo(), { verify: 'npm run lint' }), 'npm run lint');
  assert.equal(fastCheck(tempRepo({ scripts: {} })), '');
});

test('landing arguments never carry a force or hook-skip flag', () => {
  const args = shipArgsFor({ title: 'Make it fast', taskId: 'T-1', engine: 'claude', verify: 'npm test', target: 'origin/master' });
  assert.deepEqual(args.slice(0, 2), ['worktree', 'ship']);
  assert.ok(args.includes('--merge'));
  const original = fleet.fleetShipArgs;
  fleet.fleetShipArgs = () => ['worktree', 'ship', '--force'];
  try {
    assert.throws(() => shipArgsFor({ title: 'x', taskId: 'T', engine: 'e', verify: 'npm test', target: 'origin/master' }), /refusing to land with --force/);
  } finally {
    fleet.fleetShipArgs = original;
  }
});

test('the dispatch flight appends a caller brief to the builder prompt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-idea-brief-'));
  const prompts = [];
  const task = { display_id: 'CLI-1', status: 'open', title: 'Make search fast. Check: node --test test/search.test.js.' };
  const cli = (args) => {
    if (args[0] === 'task' && args[1] === 'show') return { status: 0, stdout: JSON.stringify(task), stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'start') return { status: 0, stdout: 'next: cd /wt/dispatch-cli-1\n', stderr: '' };
    return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
  };
  try {
    await fleet.runDispatchFlight({
      root,
      taskIds: ['CLI-1'],
      engine: 'cursor',
      ownCli: cli,
      brief: 'HOUSE RULES: never force-push.',
      dispatcher: (entry) => {
        prompts.push(entry.prompt || '');
        return Promise.resolve({ exitCode: 0, report: 'ok' });
      },
      rebase: () => ({ ok: true, stage: 'rebased' }),
      verifier: () => ({ status: 0, stdout: 'ok', stderr: '' }),
      log: () => {},
    });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Task: Make search fast/);
    assert.match(prompts[0], /HOUSE RULES: never force-push\.$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('one lap hands its result to a caller, stays quiet, and takes the caller time cap and brief', async () => {
  const { runOneLap, lapFlightPins } = require('../commands/one-lap');
  const seen = [];
  const printed = [];
  const original = console.log;
  console.log = (...args) => printed.push(args.join(' '));
  let code;
  try {
    code = await runOneLap('', { onResult: (result) => seen.push(result), quiet: true, progress: () => {} });
  } finally {
    console.log = original;
  }
  assert.equal(code, 2);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, 'stuck');
  assert.deepEqual(printed, []);

  const executor = { id: 'claude', roster_model: 'opus', roster_max_seconds: 7200 };
  assert.equal(lapFlightPins(executor, []).maxSeconds, 7200);
  const pins = lapFlightPins(executor, [], { maxSeconds: 900, brief: 'never force-push' });
  assert.equal(pins.maxSeconds, 900);
  assert.equal(pins.model, 'opus');
  assert.equal(pins.brief, 'never force-push');
});

test('a repo with no origin lands on its own branch, and retry can name the fast check', () => {
  const remote = shipArgsFor({ title: 'x', taskId: 'T', engine: 'e', verify: 'npm test', target: 'origin/master' });
  assert.equal(remote.includes('--local'), false);
  const local = shipArgsFor({ title: 'x', taskId: 'T', engine: 'e', verify: 'npm test', target: 'master', local: true });
  assert.equal(local.includes('--local'), true);

  const repo = tempRepo({ scripts: {} });
  const idea = addIdea(repo, 'make the inbox search faster');
  updateIdea(repo, idea.id, { status: 'refused', reason: 'no fast check' });
  const cli = path.resolve(__dirname, '..', 'bin', 'atris.js');
  const retried = spawnSync(process.execPath, [cli, 'idea', 'retry', '1', '--verify', 'npm run lint'], { cwd: repo, encoding: 'utf8', env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' } });
  assert.equal(retried.status, 0, retried.stderr);
  const after = readIdeas(repo)[0];
  assert.equal(after.status, 'waiting');
  assert.equal(fastCheck(repo, after), 'npm run lint');
});
