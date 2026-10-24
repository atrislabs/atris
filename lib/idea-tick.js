'use strict';

// atris idea tick: build the oldest waiting idea, one per repo at a time.
//
// The tick adds no new build machinery. It hands the idea's sentence to the
// one-lap path, which already turns a sentence into one scoped Atris task,
// builds it in a sealed copy cut from the protected branch, runs the repo's
// check, and has a second engine review the change (the builder never
// certifies itself). The tick then checks the built change against the same
// safety rails the inbox uses and lands it with `atris worktree ship`, which
// reruns the check, pushes a plain branch, and merges through a pull request.
//
// Rails encoded here: one tick per repo (lock file), a time cap on the build,
// no force-push, no hook skipping, no stash (the tick never calls any of
// them), and refusal of money, sending, auth, deleting user data, and
// migrations at intake and again on the built diff.
//
// Every idea the tick picks up ends with one row in the outcome ledger
// (lib/idea-ledger.js). When the same failure comes back twice in a day, the
// tick files one idea aimed at the loop itself, tagged 'loop', under the same
// rails as any other idea. At most one such idea is open at a time.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fleet = require('./fleet');
const { assertSafeShipArgs, secondReviewerSignedOff } = require('./idea-gate');
const { readOutcomes, recordOutcome, repeatedFailure } = require('./idea-ledger');
const {
  addIdea,
  changeRefusal,
  ideaRefusal,
  nextWaitingIdea,
  oneLine,
  readIdeas,
  updateIdea,
} = require('./idea-inbox');

const DEFAULT_BUILD_SECONDS = 30 * 60;
const MAX_ATTEMPTS = 2;
const LOCK_STALE_MS = 3 * 60 * 60 * 1000;
const SHIP_TIMEOUT_MS = 20 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const IDEA_BRIEF = [
  'House rules for this idea. The owner dropped it and walked away, so you decide close calls with these values:',
  '- Acceleration: land one small working change for this idea, not a plan.',
  '- Accuracy: a win counts only when checked. Add a test that fails before your change and passes after, and run the fast check bare.',
  '- Ambition: if the bigger version of the same win fits in this one change, take it; otherwise leave a note.',
  '- Agency: own the missing piece. If something blocks you, fix it inside this change or stop and say exactly what is missing.',
  'Hard rules:',
  '- Never force-push, never skip hooks (no --no-verify), never stash, never rewrite history.',
  '- Do not touch money, sending messages or email, auth, deleting user data, or database migrations. If the idea needs any of these, stop and say so.',
  '- Do not edit the rules that judge you: the idea refuse list, the landing gates, or the idea score.',
  '- Keep to the idea. One idea, one change.',
].join('\n');

function lockFile(root) {
  return path.join(path.resolve(root), '.atris', 'state', 'idea-tick.lock');
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// One tick per repo. A lock whose process is gone, or that is older than the
// longest a tick can take, is left over from a crash and gets taken.
function acquireTickLock(root, { pid = process.pid, now = Date.now(), staleMs = LOCK_STALE_MS } = {}) {
  const file = lockFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = crypto.randomBytes(8).toString('hex');
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify({ pid, token, started_at: new Date(now).toISOString() })}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, file, token };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const holder = readLock(file);
      let startedMs = holder ? Date.parse(holder.started_at || '') : NaN;
      if (!Number.isFinite(startedMs)) {
        try { startedMs = fs.statSync(file).mtimeMs; } catch { startedMs = now; }
      }
      const age = now - startedMs;
      const live = holder ? processAlive(Number(holder.pid)) : age < staleMs;
      if (live && age < staleMs) return { ok: false, file, holder };
      try { fs.unlinkSync(file); } catch {}
    }
  }
  return { ok: false, file, holder: readLock(file) };
}

function releaseTickLock(lock) {
  if (!lock || !lock.ok) return;
  const current = readLock(lock.file);
  if (current && current.token === lock.token) {
    try { fs.unlinkSync(lock.file); } catch {}
  }
}

// The repo's own fast check: an idea's --verify, else test:fast, test:unit,
// the npm test script, check, or node --test when a test folder exists. A repo
// with none of these gets no guess; the idea is refused with how to fix it.
function fastCheck(root, idea = {}) {
  if (idea.verify) return String(idea.verify).trim();
  let scripts = {};
  try {
    scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {};
  } catch {}
  const has = (name) => String(scripts[name] || '').trim().length > 0;
  if (has('test:fast')) return 'npm run test:fast';
  if (has('test:unit')) return 'npm run test:unit';
  if (has('test') && !/no test specified/i.test(scripts.test)) return 'npm test';
  if (has('check')) return 'npm run check';
  for (const dir of ['test', 'tests']) {
    try {
      if (fs.readdirSync(path.join(root, dir)).some((name) => /\.test\.(?:c|m)?js$/.test(name))) return 'node --test';
    } catch {}
  }
  return '';
}

function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60000 });
}

// What the built change touches: changed paths and added lines against the
// branch it will land on.
function inspectBuiltChange(worktree, target) {
  const range = `${target}...HEAD`;
  const names = git(worktree, ['diff', '--name-only', range]);
  const diff = git(worktree, ['diff', '-U0', range]);
  if (names.status !== 0 || diff.status !== 0) {
    return { ok: false, detail: String(names.stderr || diff.stderr || 'could not read the change').trim() };
  }
  const paths = String(names.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const addedLines = String(diff.stdout || '').split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1));
  return { ok: true, paths, addedLines };
}

function hasOrigin(cwd) {
  return git(cwd, ['remote', 'get-url', 'origin']).status === 0;
}

// A repo with no origin lands on its own branch (`--local`); every other repo
// lands through a pull request.
function shipArgsFor({ title, taskId, engine, verify, target, local = false }) {
  const args = fleet.fleetShipArgs({ task: { title, display_id: taskId }, engine }, verify, target);
  if (local) args.push('--local');
  return assertSafeShipArgs(args);
}

function defaultShip(worktree, args) {
  const bin = path.resolve(__dirname, '..', 'bin', 'atris.js');
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: worktree,
    encoding: 'utf8',
    env: process.env,
    timeout: SHIP_TIMEOUT_MS,
  });
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function defaultRunLap(text, options) {
  return require('../commands/one-lap').runOneLap(text, options);
}

// Sealed builds get no keychain, so a Claude build with no saved login fails
// at its first word. Saying so before the build keeps the idea's attempts.
function defaultLoginGap(repo) {
  try {
    const executor = require('../commands/one-lap').readyExecutor(repo);
    if (!executor || executor.id !== 'claude') return '';
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN || require('./engine-login').savedToken()) return '';
    return 'no Claude login for sealed builds';
  } catch {
    return '';
  }
}

// Where a stopped lap stopped: its check failed, its check passed but the
// review did not, or it never got that far.
function lapStage(lap) {
  const checked = String(lap && lap.checked || '');
  if (/\bfailed\b/.test(checked)) return 'checks';
  if (/\bpassed\b/.test(checked)) return 'review';
  return 'build';
}

// Where a failed landing stopped: `worktree ship` prints `merge_check:` only
// after the fast check passed, so without it the check is what failed.
function shipStage(out) {
  return /^verify: /m.test(out) && !/^merge_check: /m.test(out) ? 'checks' : 'push';
}

// A build that was mid-flight when the last tick died goes back in line once,
// then stops for the owner. Either way the ledger gets a failed build row.
function recoverInterrupted(root, ideas) {
  const recovered = [];
  for (const idea of ideas.filter((row) => row.status === 'building')) {
    if (Number(idea.attempts || 0) >= MAX_ATTEMPTS) {
      updateIdea(root, idea.id, { status: 'refused', reason: `the build stopped ${MAX_ATTEMPTS} times without finishing, needs owner` });
    } else {
      updateIdea(root, idea.id, { status: 'waiting' });
    }
    recordOutcome(root, { idea, outcome: 'failed', stage: 'build', cause: 'the build stopped without finishing', started: idea.started_at || null, taskId: idea.task_id || null });
    recovered.push(idea.id);
  }
  return recovered;
}

// When the same failure came back twice in a day, file one idea aimed at the
// loop itself. Never more than one open loop idea, never the same cause twice
// in a day, and the idea goes through addIdea, so the usual refuse rules
// apply to it (a cause about logins, say, is saved as refused, needs owner).
function feedLoop({ repo, loopRepo, now = Date.now(), log = () => {} }) {
  const repeat = repeatedFailure(readOutcomes(repo), { now });
  if (!repeat) return null;
  const home = path.resolve(loopRepo || repo);
  const ideas = readIdeas(home);
  const loopIdeas = ideas.filter((idea) => idea.tag === 'loop');
  if (loopIdeas.some((idea) => idea.status === 'waiting' || idea.status === 'building')) return null;
  if (loopIdeas.some((idea) => idea.cause_key === repeat.key && now - (Date.parse(idea.at || '') || 0) < DAY_MS)) return null;
  const text = `make the idea loop handle "${repeat.cause}" at the ${repeat.stage} stage (seen ${repeat.count} times in 24h)`;
  const idea = addIdea(home, text, { tag: 'loop', causeKey: repeat.key, now: new Date(now) });
  const where = home === path.resolve(repo) ? '' : ` in ${home}`;
  log(`the same ${repeat.stage} failure came back ${repeat.count} times today, so I filed loop idea ${idea.n}${where}: ${oneLine(text, 100)}`);
  if (idea.status === 'refused') log(`  loop idea ${idea.n} is refused too: ${idea.reason}`);
  return idea;
}

async function runIdeaTick({
  root = process.cwd(),
  log = console.log,
  runLap = defaultRunLap,
  ship = defaultShip,
  inspectChange = inspectBuiltChange,
  landTarget = (worktree) => fleet.resolveDispatchLandTarget(worktree),
  maxSeconds = DEFAULT_BUILD_SECONDS,
  lockOptions = {},
  loopRepo = null,
  clock = () => Date.now(),
  loginGap = runLap === defaultRunLap ? defaultLoginGap : () => '',
} = {}) {
  const repo = path.resolve(root);
  const lock = acquireTickLock(repo, lockOptions);
  if (!lock.ok) {
    log('one idea is already building here, so this tick waits.');
    return { status: 'busy' };
  }
  const iso = () => new Date(clock()).toISOString();
  let started = null;
  let current = null;
  // Every way out of a picked-up idea goes through here: the inbox row says
  // refused with the reason, and the ledger says refused (a rail said no) or
  // failed (a stage did not get through), at which stage, and why in short.
  const stop = (idea, { outcome = 'failed', stage, cause, reason, taskId = null }) => {
    updateIdea(repo, idea.id, { status: 'refused', reason, ...(taskId ? { task_id: taskId } : {}) });
    recordOutcome(repo, { idea: current || idea, outcome, stage, cause: cause || reason, started, finished: iso(), taskId });
    log(`idea ${idea.n} refused: ${reason}`);
    const loopIdea = outcome === 'failed' ? feedLoop({ repo, loopRepo, now: clock(), log }) : null;
    return { status: 'refused', outcome, stage, idea_id: idea.id, reason, ...(loopIdea ? { loop_idea: loopIdea.id } : {}) };
  };
  try {
    if (recoverInterrupted(repo, readIdeas(repo)).length) feedLoop({ repo, loopRepo, now: clock(), log });
    const idea = nextWaitingIdea(readIdeas(repo));
    if (!idea) {
      log('no ideas waiting.');
      return { status: 'idle' };
    }
    const intake = ideaRefusal(idea.text);
    if (intake) return stop(idea, { outcome: 'refused', stage: 'intake', cause: intake.split(' (')[0], reason: intake });
    const verify = fastCheck(repo, idea);
    if (!verify) {
      return stop(idea, { stage: 'checks', cause: 'no fast check found', reason: `this repo has no fast check I can find; give one: atris idea retry ${idea.n} --verify "<cmd>"` });
    }

    const gap = loginGap(repo);
    if (gap) {
      log(`idea ${idea.n} waits: ${gap}. run: atris idea login`);
      return { status: 'needs_login', idea_id: idea.id, reason: gap };
    }

    started = iso();
    current = updateIdea(repo, idea.id, { status: 'building', attempts: Number(idea.attempts || 0) + 1, started_at: started }) || idea;
    log(`building idea ${idea.n}: ${oneLine(idea.text, 80)}`);

    let lap = null;
    try {
      await runLap(idea.text, {
        root: repo,
        verifier: verify,
        maxSeconds,
        brief: IDEA_BRIEF,
        asJson: true,
        quiet: true,
        onResult: (result) => { lap = result; },
        progress: (line) => log(`  ${String(line || '').trim()}`),
      });
    } catch (error) {
      const why = oneLine(error && error.message || error, 120);
      return stop(idea, { stage: 'build', cause: `the build crashed: ${why}`, reason: `the build crashed: ${why}` });
    }
    if (!lap) return stop(idea, { stage: 'build', reason: 'the build ended without a result' });
    const taskId = lap.task_id || null;
    if (taskId) updateIdea(repo, idea.id, { task_id: taskId });
    if (lap.status === 'waiting_input') {
      return stop(idea, {
        outcome: 'refused',
        stage: 'build',
        cause: 'the build asked the owner a question',
        reason: `needs your answer: ${oneLine(lap.question || 'the build asked a question', 120)}`,
        taskId,
      });
    }
    if (lap.status !== 'done') {
      const why = oneLine(lap.reason || 'it stopped early', 120);
      return stop(idea, { stage: lapStage(lap), cause: why, reason: `the build did not pass: ${why}`, taskId });
    }
    if (!secondReviewerSignedOff(lap)) {
      return stop(idea, { stage: 'review', cause: 'no second engine signed off', reason: 'no second engine signed off on the change, needs owner', taskId });
    }
    if (!lap.worktree) return stop(idea, { stage: 'build', reason: 'the built change has no copy to land from', taskId });

    const target = landTarget(lap.worktree);
    const change = inspectChange(lap.worktree, target);
    if (!change || change.ok === false) {
      return stop(idea, {
        stage: 'review',
        cause: 'could not read the built change',
        reason: `could not read the built change: ${oneLine(change && change.detail, 100)}`,
        taskId,
      });
    }
    const unsafe = changeRefusal(change);
    if (unsafe) {
      return stop(idea, {
        outcome: 'refused',
        stage: 'review',
        cause: unsafe.split(' (')[0],
        reason: `built and reviewed, but ${unsafe}; it waits in review as ${taskId}`,
        taskId,
      });
    }

    const args = shipArgsFor({
      title: lap.changed || idea.text,
      taskId: taskId || idea.id,
      engine: lap.engine || 'engine',
      verify,
      target,
      local: !hasOrigin(lap.worktree),
    });
    log(`  landing idea ${idea.n}: the fast check runs once more first`);
    const shipped = ship(lap.worktree, args) || {};
    const out = `${shipped.stdout || ''}\n${shipped.stderr || ''}`;
    if (shipped.status !== 0 || !/done: worktree shipped/.test(out)) {
      const why = out.split('\n').map((line) => line.trim()).filter(Boolean).slice(-1)[0] || 'landing failed';
      return stop(idea, { stage: shipStage(out), cause: oneLine(why, 120), reason: `the change did not land: ${oneLine(why, 120)}`, taskId });
    }
    const pr = (out.match(/^pr:\s*(https?:\/\/\S+)/m) || [])[1] || '';
    const queued = /merge: pending/.test(out);
    const link = pr || 'merged on the local branch';
    updateIdea(repo, idea.id, { status: 'landed', link, task_id: taskId, ...(queued ? { note: 'merge queued' } : {}) });
    recordOutcome(repo, { idea: current, outcome: 'landed', started, finished: iso(), taskId, link: pr || null });
    log(`idea ${idea.n} landed${queued ? ' (merge queued)' : ''}: ${link}`);
    return { status: 'landed', outcome: 'landed', idea_id: idea.id, link, task_id: taskId };
  } finally {
    releaseTickLock(lock);
  }
}

module.exports = {
  DEFAULT_BUILD_SECONDS,
  IDEA_BRIEF,
  MAX_ATTEMPTS,
  acquireTickLock,
  fastCheck,
  lockFile,
  releaseTickLock,
  runIdeaTick,
  shipArgsFor,
};
