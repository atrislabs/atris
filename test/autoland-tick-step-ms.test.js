'use strict';

// 2026-11-12: an `atris autoland tick` ran past five minutes. Its receipt
// had only a start stamp, which left nobody able to say which step ate the
// time. The receipt now carries step_ms (whole milliseconds per step),
// total_ms and ended_at. The printed line says how long the tick took.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const autoland = require('../lib/autoland');
const landGreen = require('../lib/land-green');
const commandsAutoland = require('../commands/autoland');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');
const AGENT_ENV_KEYS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CODEX_SANDBOX', 'CURSOR_AGENT', 'DEVIN_SESSION_ID', 'ATRIS_AGENT_PROOF_ONLY'];

function git(args, cwd, env = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000, env: { ...process.env, ...env } });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

function makeRepo() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-tick-step-ms-')));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'master'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(['add', '.'], repo);
  git(['commit', '-qm', 'init'], repo);
  fs.mkdirSync(path.join(repo, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.atris', 'state'), { recursive: true });
  return { base, repo };
}

// Runs fn with a fixture repo, the agent markers stripped the way a cron
// tick has them, with a task database of its own. Everything is put back.
async function withTick(fn) {
  const { base, repo } = makeRepo();
  const saved = Object.fromEntries([...AGENT_ENV_KEYS, 'ATRIS_TASKS_DB', 'NODE_TEST_CONTEXT'].map((key) => [key, process.env[key]]));
  try {
    for (const key of AGENT_ENV_KEYS) delete process.env[key];
    process.env.ATRIS_TASKS_DB = path.join(repo, '.atris', 'fixture-tasks.db');
    // The ssh-agent sweep stops real agents unless a test run is declared.
    if (!process.env.NODE_TEST_CONTEXT) process.env.NODE_TEST_CONTEXT = 'child-v8';
    return await fn({ repo });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function freshReceipt() {
  return { at: new Date().toISOString(), landed: [], alarms: 0, digest_due: false, digest_sent: false, enabled: true };
}

async function captureLines(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

const isWholeMs = (value) => Number.isInteger(value) && value >= 0;

// Steps that run on every tick for a policy with nothing switched off and no
// phone number. No message goes out, which keeps live_update and alarm absent.
const ALWAYS_STEPS = [
  'engine_receipt_sweep', 'fleet_receipt_sweep', 'ssh_agent_sweep', 'lost_run_sweep',
  'engine_answer_validation', 'origin_refresh', 'accept_certify', 'merged_close', 'janitor',
  'green_landing', 'landing_sweep', 'idle_sweep', 'wish_dispatch', 'map_fold',
  'daily_experiment', 'mission_cleanup',
];

test('a real tick writes a whole-millisecond time for every step, a total that covers the longest step, plus an end stamp', async () => {
  await withTick(async ({ repo }) => {
    const policy = { enabled: true, enabled_by: 'keshav', strict_verify: false, digest_hour: new Date().getHours() };
    autoland.writePolicy(repo, policy);
    const receipt = freshReceipt();
    const lines = await captureLines(() => commandsAutoland.runTickBody(repo, { json: false, policy, receipt }));

    for (const name of ALWAYS_STEPS) assert.ok(isWholeMs(receipt.step_ms[name]), `${name}: ${JSON.stringify(receipt.step_ms)}`);
    // The digest step runs only in the digest hour. Its time is there exactly when it ran.
    assert.equal(receipt.digest_due, 'daily_digest' in receipt.step_ms);
    if (receipt.digest_due) assert.ok(isWholeMs(receipt.step_ms.daily_digest));
    // A message that was never sent has no time: absent, not zero.
    assert.equal('live_update' in receipt.step_ms, false);
    assert.equal('alarm' in receipt.step_ms, false);

    const longest = Math.max(...Object.values(receipt.step_ms));
    assert.ok(isWholeMs(receipt.total_ms));
    assert.ok(receipt.total_ms >= longest, `total ${receipt.total_ms} < longest step ${longest}`);
    assert.ok(Object.values(receipt.step_ms).reduce((sum, ms) => sum + ms, 0) <= receipt.total_ms, 'steps never add up to more than the total');
    assert.ok(Number.isFinite(Date.parse(receipt.ended_at)));
    assert.ok(Date.parse(receipt.ended_at) >= Date.parse(receipt.at));

    // Timing keys sit beside the old keys and leave them alone.
    assert.deepEqual(receipt.landed, []);
    assert.equal(receipt.alarms, 0);
    assert.equal(typeof receipt.wish_dispatch, 'object', 'the wish_dispatch result is not overwritten by its time');
    assert.equal(typeof receipt.green_landing, 'object');
    assert.equal(typeof receipt.daily_experiment, 'object');

    // The file on disk is the same receipt, timing included.
    const saved = JSON.parse(fs.readFileSync(path.join(repo, receipt.receipt_path), 'utf8'));
    assert.deepEqual(saved.step_ms, receipt.step_ms);
    assert.equal(saved.total_ms, receipt.total_ms);
    assert.equal(saved.ended_at, receipt.ended_at);

    const summary = lines.filter((line) => line.startsWith('autoland tick:'));
    assert.equal(summary.length, 1, lines.join('\n'));
    assert.match(summary[0], /, took \d+(\.\d)?s(, receipt |$)/);
    assert.equal(lines.some((line) => line.startsWith('slow step:')), false, 'a fast tick names no slow step');
  });
});

test('the real command prints the same timing in its json receipt', async () => {
  await withTick(async ({ repo }) => {
    autoland.writePolicy(repo, { enabled: true, enabled_by: 'keshav', strict_verify: false });
    // NODE_TEST_CONTEXT stays set (withTick guarantees it): without it the tick's
    // ssh-agent sweep would stop real agents on the machine running the test.
    const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' };
    const res = spawnSync(process.execPath, [CLI, 'autoland', 'tick', '--json'], { cwd: repo, encoding: 'utf8', env, timeout: 120000 });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const receipt = JSON.parse(res.stdout.trim().split('\n').pop());
    for (const name of ['accept_certify', 'landing_sweep', 'wish_dispatch']) assert.ok(isWholeMs(receipt.step_ms[name]), `${name}: ${JSON.stringify(receipt.step_ms)}`);
    assert.ok(receipt.total_ms >= Math.max(...Object.values(receipt.step_ms)));
    const saved = JSON.parse(fs.readFileSync(path.join(repo, receipt.receipt_path), 'utf8'));
    assert.deepEqual(saved.step_ms, receipt.step_ms);
  });
});

test('a step switched off by policy has no time at all while its old skip marker stays', async () => {
  await withTick(async ({ repo }) => {
    const policy = { enabled: true, enabled_by: 'keshav', strict_verify: false, janitor: false, green_landing: false, map_fold: false, daily_experiment: false, digest_hour: (new Date().getHours() + 12) % 24 };
    autoland.writePolicy(repo, policy);
    const receipt = freshReceipt();
    await captureLines(() => commandsAutoland.runTickBody(repo, { json: false, policy, receipt }));
    for (const name of ['janitor', 'idle_sweep', 'green_landing', 'map_fold', 'daily_experiment', 'daily_digest']) {
      assert.equal(name in receipt.step_ms, false, `${name} was off but has a time`);
    }
    assert.equal(receipt.daily_experiment_skipped, true);
    for (const name of ['accept_certify', 'landing_sweep', 'wish_dispatch']) assert.ok(isWholeMs(receipt.step_ms[name]), name);
  });
});

test('a step that runs over a minute is named, with the exact time from the clock the tick was given', async () => {
  await withTick(async ({ repo }) => {
    const policy = { enabled: true, enabled_by: 'keshav', strict_verify: false, janitor: false, green_landing: false, map_fold: false, daily_experiment: false, digest_hour: (new Date().getHours() + 12) % 24 };
    autoland.writePolicy(repo, policy);
    const wish = require('../commands/wish');
    const original = wish.sweepWishes;
    let now = 1000000;
    wish.sweepWishes = () => {
      now += 90000;
      return { scanned: 0, dispatched: 0, fulfilled: 0, fulfilled_results: [], results: [] };
    };
    try {
      const receipt = freshReceipt();
      const lines = await captureLines(() => commandsAutoland.runTickBody(repo, { json: false, policy, receipt, clock: () => now }));
      assert.equal(receipt.step_ms.wish_dispatch, 90000);
      for (const [name, ms] of Object.entries(receipt.step_ms)) {
        if (name !== 'wish_dispatch') assert.equal(ms, 0, `${name} did not move the clock`);
      }
      assert.equal(receipt.total_ms, 90000);
      const at = lines.findIndex((line) => line.startsWith('autoland tick:'));
      assert.ok(at >= 0, lines.join('\n'));
      assert.match(lines[at], /, took 90s(, receipt |$)/);
      assert.equal(lines[at + 1], 'slow step: wish_dispatch took 90s');
      assert.equal(lines.filter((line) => line.startsWith('slow step:')).length, 1);
    } finally {
      wish.sweepWishes = original;
    }
  });
});

test('a step that throws still records its time with the old error handling unchanged', async () => {
  await withTick(async ({ repo }) => {
    const policy = { enabled: true, enabled_by: 'keshav', strict_verify: false, janitor: false, green_landing: false, map_fold: false, daily_experiment: false, digest_hour: (new Date().getHours() + 12) % 24 };
    autoland.writePolicy(repo, policy);
    const wish = require('../commands/wish');
    const original = wish.sweepWishes;
    let now = 5000;
    wish.sweepWishes = () => {
      now += 7;
      throw new Error('wish sweep exploded');
    };
    try {
      const receipt = freshReceipt();
      let code;
      await captureLines(async () => { code = await commandsAutoland.runTickBody(repo, { json: false, policy, receipt, clock: () => now }); });
      assert.equal(code, 0);
      assert.match(receipt.wish_dispatch_error, /wish sweep exploded/);
      assert.equal(receipt.wish_dispatch, undefined);
      assert.equal(receipt.step_ms.wish_dispatch, 7);
      assert.equal(receipt.total_ms, 7);
    } finally {
      wish.sweepWishes = original;
    }
  });
});

test('the timer times sync, async, early-return, throwing and rejected steps and adds up a name used twice', async () => {
  let now = 100;
  const receipt = {};
  const { timed, finish } = commandsAutoland.createTickTimer(receipt, () => now);

  assert.equal(timed('sync', () => { now += 12; return 'out'; }), 'out');
  assert.equal(await timed('async', async () => { now += 30; return 'later'; }), 'later');
  assert.equal(timed('early', () => undefined), undefined, 'a step that returns at once still has a time');
  assert.throws(() => timed('boom', () => { now += 4; throw new Error('sync boom'); }), /sync boom/);
  await assert.rejects(timed('reject', async () => { now += 6; throw new Error('async boom'); }), /async boom/);
  timed('twice', () => { now += 1; });
  timed('twice', () => { now += 2; });
  // A clock that steps back is never a negative time.
  timed('backwards', () => { now -= 50; });
  now += 50;

  assert.deepEqual(receipt.step_ms, { sync: 12, async: 30, early: 0, boom: 4, reject: 6, twice: 3, backwards: 0 });
  finish();
  assert.ok(receipt.total_ms >= Math.max(...Object.values(receipt.step_ms)));
  assert.equal(receipt.total_ms, 55);
  assert.ok(Number.isFinite(Date.parse(receipt.ended_at)));
});

test('the slow-step line needs a step over a minute and names only the slowest', () => {
  const line = commandsAutoland.slowStepLine;
  assert.equal(line({ step_ms: { a: 60000, b: 59999, c: 0 } }), '', 'exactly a minute is not over a minute');
  assert.equal(line({ step_ms: { a: 60001 } }), 'slow step: a took 60s');
  assert.equal(line({ step_ms: { green_landing: 312400, accept_certify: 75000 } }), 'slow step: green_landing took 312s');
  assert.equal(line({}), '');
  assert.equal(line({ step_ms: { a: 'x', b: null, c: undefined } }), '');
  assert.equal(commandsAutoland.tickTimingNote({}), '', 'no total, no took clause');
  assert.equal(commandsAutoland.tickTimingNote({ total_ms: 0 }), ', took 0.0s', 'zero is a real time');
  assert.equal(commandsAutoland.tickTimingNote({ total_ms: 2450 }), ', took 2.5s');
  assert.equal(commandsAutoland.tickTimingNote({ total_ms: 9996 }), ', took 10s');
});

test('a green landing verdict keeps how long the verify took, zero included', () => {
  const row = commandsAutoland.greenVerdictRow;
  assert.deepEqual(
    row({ branch: 'member/a', action: 'red', reason: 'verify_failed', verify: { status: 1, duration_ms: 4321, failing: ['x one'] } }),
    { branch: 'member/a', action: 'red', reason: 'verify_failed', detail: null, failing: ['x one'], duration_ms: 4321 },
  );
  assert.equal(row({ branch: 'b', action: 'landed', verify: { duration_ms: 0 } }).duration_ms, 0);
  // Missing stays missing: not 0, not null.
  assert.equal('duration_ms' in row({ branch: 'c', action: 'skipped', reason: 'conflict' }), false);
  assert.equal('duration_ms' in row({ branch: 'd', action: 'red', verify: { failing: [] } }), false);
  assert.equal('duration_ms' in row({ branch: 'e', action: 'red', verify: { duration_ms: null } }), false);
});

test('a real verify result puts its duration into the tick receipt', async () => {
  // A stale branch that fails a real npm test, run through the real landing code.
  const { base, repo: green } = makeRepo();
  const long = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  try {
    fs.writeFileSync(path.join(green, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0', scripts: { test: 'node check.js' } }));
    fs.writeFileSync(path.join(green, 'ok.txt'), 'ok\n');
    fs.writeFileSync(path.join(green, 'check.js'), "process.exit(require('fs').readFileSync('ok.txt','utf8').trim() === 'ok' ? 0 : 1);\n");
    git(['add', '-A'], green);
    git(['commit', '-qm', 'base'], green, { GIT_AUTHOR_DATE: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(), GIT_COMMITTER_DATE: long });
    git(['checkout', '-q', '-b', 'member/red'], green);
    fs.writeFileSync(path.join(green, 'ok.txt'), 'broken\n');
    git(['add', '-A'], green);
    git(['commit', '-qm', 'red work'], green, { GIT_AUTHOR_DATE: long, GIT_COMMITTER_DATE: long });
    git(['checkout', '-q', 'master'], green);
    const result = landGreen.landStaleGreenBranches(green, { push: false, runCli: () => ({ status: 0, stdout: 'opened' }) });
    const red = result.verdicts.find((v) => v.branch === 'member/red');
    assert.equal(red.action, 'red');
    assert.ok(isWholeMs(red.verify.duration_ms), 'the verify run reports how long it took');

    await withTick(async ({ repo }) => {
      const policy = { enabled: true, enabled_by: 'keshav', strict_verify: false, janitor: false, map_fold: false, daily_experiment: false, digest_hour: (new Date().getHours() + 12) % 24 };
      autoland.writePolicy(repo, policy);
      const original = landGreen.landStaleGreenBranches;
      landGreen.landStaleGreenBranches = () => result;
      try {
        const receipt = freshReceipt();
        await captureLines(() => commandsAutoland.runTickBody(repo, { json: false, policy, receipt }));
        assert.equal(receipt.green_landing.verdicts.length, 1);
        assert.equal(receipt.green_landing.verdicts[0].duration_ms, red.verify.duration_ms);
        assert.deepEqual(receipt.green_landing.verdicts[0].failing, red.verify.failing);
        const saved = JSON.parse(fs.readFileSync(path.join(repo, receipt.receipt_path), 'utf8'));
        assert.equal(saved.green_landing.verdicts[0].duration_ms, red.verify.duration_ms);
        assert.ok(isWholeMs(receipt.step_ms.green_landing));
      } finally {
        landGreen.landStaleGreenBranches = original;
      }
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
