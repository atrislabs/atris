'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tasks = require('../../lib/task-db');
const realClaimTask = tasks.claimTask;
const fleet = require('../../lib/fleet');
const { loadSeason, rosterRows } = require('../../lib/gm-season');
const { scrubAgentEnv } = require('./agent-env');

const CLI = path.resolve(__dirname, '../..', 'bin', 'atris.js');
const PR_URL = 'https://github.example/repo/pull/77';
const COMMIT = '93b6d4bcf66276bbd6a53aebe72ab48bf9a7b136';

// ---------------------------------------------------------------------------
// The dispatch flight, with a fake task plane and a fake ship.

const FEEDBACK_TASK = {
  display_id: 'BCK-1934',
  status: 'open',
  tag: 'feedback',
  title: 'Fix the form so people stop retyping. Done: the form keeps what was typed. Check: node --test test/form.test.js.',
};

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'held-flight-'));
  const saved = process.env.ATRIS_TASKS_DB;
  // The flight keeps claim leases in the task db it finds by env; keep it in the sandbox.
  process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
  t.after(() => {
    tasks.close();
    if (saved === undefined) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

// show, claim, ready, release and worktreeStart are for a test that needs one task command to
// be answered some other way than the stand-in answers it (the real command, a refusal, a
// failure), each given the arguments the flight sent. afterShow runs once the task command has
// answered, which is when a list can change before the flight's next command. The flight
// claims a job its store holds in its own process, not through the task command, so claim only
// answers for a job the store has no row for; afterClaim is what runs once the store has
// answered the flight's claim, which is when a task command writes the list again.
function fakeTaskPlane({ task, shipOutput, shipStatus = 0, readyStatus = 0, readyError = 'ready failed: nope', releaseStatus = 0, show = null, claim = null, ready = null, release = null, worktreeStart = null, afterShow = null, afterClaim = null }) {
  const calls = [];
  const cli = (args) => {
    calls.push(args);
    if (args[0] === 'task' && args[1] === 'show') {
      const answer = show ? show(args) : { status: 0, stdout: JSON.stringify(task), stderr: '' };
      if (afterShow) afterShow();
      return answer;
    }
    if (args[0] === 'task' && args[1] === 'claim' && claim) return claim(args);
    if (args[0] === 'worktree' && args[1] === 'start') {
      if (worktreeStart) return worktreeStart(args);
      return { status: 0, stdout: `next: cd /wt/${args[args.indexOf('--task') + 1]}\n`, stderr: '' };
    }
    if (args[0] === 'worktree' && args[1] === 'ship') return { status: shipStatus, stdout: shipOutput, stderr: shipStatus ? 'ship failed' : '' };
    if (args[0] === 'task' && args[1] === 'ready') {
      if (ready) return ready(args);
      return { status: readyStatus, stdout: readyStatus ? '' : 'proof ready', stderr: readyStatus ? readyError : '' };
    }
    if (args[0] === 'task' && args[1] === 'release') {
      if (release) return release(args);
      return { status: releaseStatus, stdout: releaseStatus ? '' : 'released', stderr: releaseStatus ? 'release failed: busy' : '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { cli, calls, afterClaim };
}

// Record the claims the flight makes in its own process (the row ids it claims, in order), and
// run afterClaim once the store has answered each. The claim itself is the real one.
function watchClaims(t, plane, afterClaim = plane.afterClaim) {
  plane.storeClaims = plane.storeClaims || [];
  if (tasks.claimTask.mock) tasks.claimTask.mock.restore();
  t.mock.method(tasks, 'claimTask', (db, args) => {
    plane.storeClaims.push(args.id);
    const answer = realClaimTask(db, args);
    if (afterClaim) afterClaim();
    return answer;
  });
}

// options go to the dispatch flight as they are, for a test that needs it to run another way
// (review only, with no engine of its own).
async function flyWith(t, plane, { root = tempRoot(t), options = {} } = {}) {
  const logs = [];
  watchClaims(t, plane);
  const flight = await fleet.runDispatchFlight({
    root,
    taskIds: [plane.task.display_id],
    engine: 'codex',
    ownCli: plane.cli,
    dispatcher: () => Promise.resolve({ exitCode: 0, report: 'engine report' }),
    rebase: () => ({ ok: true, stage: 'rebased' }),
    verifier: () => ({ status: 0, stdout: '# tests 3\n# pass 3\n# fail 0\n', stderr: '' }),
    log: (line = '') => logs.push(String(line)),
    ...options,
  });
  return { flight, logs, root, receipt: JSON.parse(fs.readFileSync(flight.receipt, 'utf8')) };
}

const planeFor = (task, options = {}) => ({ task, ...fakeTaskPlane({ task, shipOutput: `push: origin codex/dispatch\npr: ${PR_URL}\ndone: worktree shipped\n`, ...options }) });
const callsTo = (plane, ...words) => plane.calls.filter((args) => words.every((word, i) => args[i] === word));

// ---------------------------------------------------------------------------
// The real task plane and the rating.

function sandboxDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-season-'));
  const dbPath = path.join(dir, 'tasks.db');
  const saved = process.env.ATRIS_TASKS_DB;
  process.env.ATRIS_TASKS_DB = dbPath;
  const db = tasks.open(dbPath);
  t.after(() => {
    tasks.close();
    if (saved === undefined) delete process.env.ATRIS_TASKS_DB; else process.env.ATRIS_TASKS_DB = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, db };
}

// A job the flight built in a protected lane: claimed, then sent to Review
// with its open pull request and no merge commit.
function heldJob(db, dir, { title = 'Fix the feedback form', builder = 'fleet-codex' } = {}) {
  const { id } = tasks.addTask(db, { title, tag: 'feedback', workspaceRoot: dir });
  assert.equal(tasks.claimTask(db, { id, claimedBy: builder, leaseMinutes: 60, leasePid: process.pid }).claimed, true);
  const ready = tasks.readyTask(db, {
    id,
    actor: builder,
    proof: 'Built and verified; the pull request waits for a person to land it.',
    merge: { number: '77', url: PR_URL },
  });
  assert.equal(ready.ready, true);
  return id;
}

const seasonOf = (dir, dbPath) => {
  const season = loadSeason(dir, { dbPath, now: Date.now() + 1000, lastSeen: null });
  assert.equal(season.error, undefined);
  return season;
};
const playsOf = (season, id) => season.outcomes.filter((o) => o.task_id === id);

// ---------------------------------------------------------------------------
// The real command line: what the flight sends is accepted as it is written.

function cliWorkspace(t) {
  // The CLI records the real path of its folder, which is not the /var alias macOS gives mkdtemp.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'held-cli-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'atris'));
  const dbPath = path.join(dir, 'tasks.db');
  // attempt answers whatever the command did; run insists it worked.
  const attempt = (args, { env = {} } = {}) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...scrubAgentEnv(), ...env, ATRIS_TASKS_DB: dbPath, ATRIS_SKIP_UPDATE_CHECK: '1', NODE_NO_WARNINGS: '1' },
  });
  const run = (args, options) => {
    const result = attempt(args, options);
    assert.equal(result.status, 0, `${args.join(' ').slice(0, 120)}: ${result.stderr || result.stdout}`);
    return result;
  };
  return { dir, dbPath, run, attempt };
}

module.exports = {
  CLI,
  PR_URL,
  COMMIT,
  FEEDBACK_TASK,
  tempRoot,
  watchClaims,
  flyWith,
  planeFor,
  callsTo,
  sandboxDb,
  heldJob,
  seasonOf,
  playsOf,
  cliWorkspace,
};
