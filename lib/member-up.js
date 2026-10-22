'use strict';

// `atris member up`: a small foreground supervisor that keeps the team
// working. Each check it looks at every runnable member, and when one has no
// live run and a task with a runnable check fits it, starts
// `atris member go <name> --needs-check` so the member claims and runs that
// task. A member with no such task writes its own next job from its standing
// mission when that mission names a check (lib/member-self-next-job.js), and
// starts on it; otherwise it stays idle. The clock, the spawner, the member
// list and the task picker are passed in, so tests drive it with fake time.

const { taskCheck } = require('./member-task-pick');
const { followBoard } = require('./member-board');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CHECK_MS = 60 * 1000;
const IDLE_CHECK_MS = 5 * 60 * 1000;
const IDLE_MAX_CHECK_MS = 30 * 60 * 1000;
const SUMMARY_MS = 10 * 60 * 1000;
// A run with no new step for this long is called out as stuck, once per stall.
const STALL_MS = 20 * 60 * 1000;
// How often member changes GitHub dropped from its merge line are put back.
// Each look can call GitHub, so it runs less often than the member check.
const REQUEUE_MS = 5 * 60 * 1000;
// Put-back outcomes worth a line: one went back in, or one was left for you.
const REQUEUE_SAID = new Set(['requeued', 'clash', 'gave-up', 'changed', 'moved', 'stalled', 'refreshed', 'refresh-failed']);
const MAINTENANCE_LOCK_MS = 2 * 60 * 1000;
const MERGE_QUIET_MS = 2 * 60 * 60 * 1000;
const IDLE_AFTER_EMPTY = 3;
const DEFAULT_MAX = 6;
// Exit code `member go --needs-check` uses when it found no task with a check
// to claim (another run took it first). Not a failure, just idle.
const IDLE_EXIT = 75;
// A member name that gets each job by itself, for the add-one hint.
const JOB_MEMBER = { build: 'builder', review: 'reviewer', search: 'researcher' };

function maintenanceGit(cwd, args) {
  const out = spawnSync('git', args, {
    cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  return { ok: out.status === 0, text: String(out.stdout || '').trim() };
}

// Never move a developer's branch, a linked work folder, or any edited copy.
// Recheck after the fetch, which can take long enough for edits to arrive.
function refreshMemberCode(root) {
  const safe = () => {
    try { if (!fs.lstatSync(path.join(root, '.git')).isDirectory()) return false; } catch { return false; }
    const detached = maintenanceGit(root, ['symbolic-ref', '-q', 'HEAD']);
    const clean = maintenanceGit(root, ['status', '--porcelain', '--untracked-files=all']);
    return !detached.ok && clean.ok && !clean.text;
  };
  if (!safe()) return null;
  const before = maintenanceGit(root, ['rev-parse', '--verify', 'HEAD']);
  const fetched = maintenanceGit(root, ['fetch', '-q', 'origin', '+refs/heads/master:refs/remotes/origin/master']);
  if (!fetched.ok) return { state: 'refresh-failed', line: 'could not refresh the members\' code copy; will try again' };
  const tip = maintenanceGit(root, ['rev-parse', '--verify', 'refs/remotes/origin/master^{commit}']);
  const current = maintenanceGit(root, ['rev-parse', '--verify', 'HEAD']);
  if (!before.ok || !tip.ok || !current.ok || current.text !== before.text || !safe()) return null;
  if (tip.text === before.text) return null;
  // A detached local commit is still someone's work. Only move forward.
  if (!maintenanceGit(root, ['merge-base', '--is-ancestor', before.text, tip.text]).ok) return null;
  const moved = maintenanceGit(root, ['checkout', '--detach', tip.text]);
  return moved.ok
    ? { state: 'refreshed', line: 'the members\' code copy is current' }
    : { state: 'refresh-failed', line: 'could not refresh the members\' code copy; will try again' };
}

// Shared by all windows of a project, including linked work folders. The
// completed-pass timestamp survives release, so a second window waits too.
// announceQuiet false: a caller that prints nothing (a finished mission run)
// leaves the two-hour warning for the team loop to say.
function memberMaintenance({ cwd, codeRoot, now = Date.now(), requeueDropped, waitingTasks = () => [], announceQuiet = true }) {
  const common = maintenanceGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok) return { results: [] };
  const dir = path.join(path.dirname(common.text), '.atris', 'state');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'member-up-maintenance.lock');
  const file = path.join(dir, 'member-up-maintenance.json');
  let fd;
  try {
    fd = fs.openSync(lock, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A live owner always holds, even past the lease: GitHub may be slow.
    // Unknown/malformed owners get a short grace period before recovery.
    try {
      const stat = fs.statSync(lock);
      let owner;
      try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch {}
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); return { results: [] }; }
        catch (e) { if (e.code !== 'ESRCH') return { results: [] }; }
      } else if (now - stat.mtimeMs < MAINTENANCE_LOCK_MS) return { results: [] };
      if (fs.statSync(lock).ino !== stat.ino) return { results: [] };
      fs.unlinkSync(lock);
      fd = fs.openSync(lock, 'wx');
    } catch { return { results: [] }; }
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now }));
    let state = {};
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
    if (Number.isFinite(state.checked_at) && now - state.checked_at < REQUEUE_MS) return { results: [] };
    const save = () => {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    };
    state.checked_at = now;
    save();
    const out = requeueDropped();
    const results = [...(out?.results || [])];
    const merged = results.some((r) => r.state === 'merged');
    const waiting = results.some((r) => !['merged', 'closed'].includes(r.state)) || waitingTasks().length > 0;
    if (merged || !waiting) {
      state.waiting_since = null;
      state.quiet_said = false;
    }
    if (waiting && state.waiting_since == null) state.waiting_since = now;
    if (announceQuiet && waiting && !state.quiet_said && now - state.waiting_since >= MERGE_QUIET_MS) {
      results.push({ state: 'stalled', line: 'jobs are waiting, but nothing has merged for two hours' });
      state.quiet_said = true;
    }
    const refresh = codeRoot ? refreshMemberCode(codeRoot) : null;
    if (refresh && (refresh.state !== 'refresh-failed' || !state.refresh_failed)) results.push(refresh);
    state.refresh_failed = refresh?.state === 'refresh-failed';
    save();
    return { ...out, results };
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// How long an idle member waits before its next check. The first few empty
// checks wait one round; after that the wait doubles from 5 minutes each
// empty check, up to 30 minutes. Finding work resets it.
function idleWaitMs(empty) {
  if (!(empty >= IDLE_AFTER_EMPTY)) return 0;
  const doublings = Math.min(empty - IDLE_AFTER_EMPTY, 10);
  return Math.min(IDLE_CHECK_MS * 2 ** doublings, IDLE_MAX_CHECK_MS);
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// A task only starts a member when it names a check that can be run.
function hasRunnableCheck(task) {
  const check = taskCheck(task);
  return Boolean(check.command) && check.runnable;
}

// deps:
//   listMembers() -> [{ name, parked, human, sleeping, live }]
//   pickTask(name, takenIds) -> { id, title } | null   (looks only, never claims)
//   spawn(name, onExit, onClaim) -> any (claim confirms { id, title })
//   now() -> ms
//   print(line)
//   jobOf(name) -> 'build' | 'review' | 'search'       (optional)
//   writeNextJob(name, { dryRun }) -> { task } | { skip } (optional; writes
//                     the member's next job from its mission when its list
//                     is empty; a dry run only says what it would write)
//   waitingTasks() -> [{ id, title, job }]            (optional; open tasks
//                     with a runnable check, any job)
//   requeueDropped() -> { results: [{ state, line }] } (optional; puts member
//                     changes GitHub dropped from its merge line back in)
function createMemberUp(deps, options = {}) {
  const max = Math.max(1, Number(options.max) || DEFAULT_MAX);
  const dryRun = options.dryRun === true;
  const print = deps.print || ((line) => console.log(line));
  // only: when set, these members are the whole team for this supervisor.
  // Nobody else is started or counted, and unknown names are skipped.
  const only = Array.isArray(options.only) && options.only.length
    ? new Set(options.only.map((name) => String(name).trim()).filter(Boolean))
    : null;
  const skippedUnknown = new Set();
  const hintedJobs = new Set();
  const state = new Map();
  const running = new Map();
  let doneToday = 0;
  let doneDay = dayOf(deps.now());
  let lastSummaryAt = deps.now();
  let lastRequeueAt = -Infinity;
  let requeueFailSaid = false;
  // Members working right now: the runs this supervisor started plus any
  // live run started some other way. Both count toward --max.
  let liveElsewhere = new Set();
  const working = () => new Set([...running.keys(), ...liveElsewhere]).size;

  const seat = (name) => {
    if (!state.has(name)) state.set(name, { empty: 0, idle: false, nextCheckAt: 0 });
    return state.get(name);
  };

  function claimed(name, run, task) {
    if (running.get(name) !== run || run.announced || !task?.id || !task?.title) return;
    run.announced = true;
    run.taskId = task.id;
    const s = seat(name);
    const title = oneLine(task.title);
    run.title = title;
    if (s.idle) print(`${name} woke up for: ${title}`);
    s.idle = false;
    s.empty = 0;
    s.nextCheckAt = 0;
    print(`${name} started on: ${title}`);
  }

  function finish(name, code, result = {}) {
    if (!running.has(name)) return;
    const run = running.get(name);
    running.delete(name);
    const now = deps.now();
    if (dayOf(now) !== doneDay) {
      doneDay = dayOf(now);
      doneToday = 0;
    }
    const s = seat(name);
    s.empty = 0;
    s.nextCheckAt = 0;
    if (code === IDLE_EXIT) {
      s.idle = true;
      print(idleLine(name));
    } else if (code === 0 && result.ok !== false && run.finished?.ok !== false) {
      doneToday += 1;
      const changed = oneLine(result.summary || run.finished?.text.replace(/^ok\b[: ,]*/, '')
        || run.changed || 'no change summary reported');
      print(`${name} done ok: ${changed}`);
    } else {
      const reason = oneLine(result.reason || run.finished?.text.replace(/^failed\b[: ,]*/, '')
        || (code === 0 ? 'member reported failure' : code == null ? 'run ended without a result' : `exit ${code}`));
      print(`${name} failed: ${reason}`);
    }
  }

  const idleLine = (name) => `${name} is idle, no task with a check`;

  // Jobs waiting for a kind of work no awake member does, said once per kind:
  // name a member who could be woken for it, or say to add one.
  function otherKindHints(team, awake, taken) {
    if (!deps.jobOf || !deps.waitingTasks) return;
    const awakeJobs = new Set(awake.map((m) => deps.jobOf(m.name)));
    const waiting = new Map();
    for (const task of deps.waitingTasks() || []) {
      if (!task || !task.job || (task.id && taken.has(task.id))) continue;
      if (awakeJobs.has(task.job) || hintedJobs.has(task.job)) continue;
      waiting.set(task.job, (waiting.get(task.job) || 0) + 1);
    }
    const awakeNames = new Set(awake.map((m) => m.name));
    for (const [job, count] of waiting) {
      hintedJobs.add(job);
      const jobs = count === 1 ? `1 ${job} job is waiting` : `${count} ${job} jobs are waiting`;
      const sleeper = team.find((m) => m && m.name && !m.human && !m.parked
        && !awakeNames.has(m.name) && deps.jobOf(m.name) === job);
      print(sleeper
        ? `${jobs}, but nobody who does ${job} is awake. wake one: atris member wake ${sleeper.name} --keep`
        : `${jobs}, but no member on the team does ${job}. add one: atris member create ${JOB_MEMBER[job] || job}`);
    }
  }

  function progress(event) {
    const run = running.get(event.member);
    if (!run || Date.parse(event.at) < run.startedAt) return;
    if (event.kind === 'finished') {
      run.finished = event;
      return;
    }
    if (event.kind !== 'step') return;
    if (event.text.startsWith('editing ')) run.changed = event.text;
    run.lastStepAt = Math.max(run.lastStepAt, Date.parse(event.at) || 0);
    run.lastStep = oneLine(event.text);
    run.stallSaid = false;
    const time = new Date(event.at);
    const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
    print(`  ${event.member} ${hhmm}  ${oneLine(event.text)}`);
  }

  function summary() {
    const idle = Array.from(state.values()).filter((s) => s.idle).length;
    return `working ${working()}, idle ${idle}, done today ${doneToday}`;
  }

  // Say once when a run has shown no new step for STALL_MS, so a hung member
  // does not hold a seat in silence. A new step lets a later stall be said again.
  function callOutStalls(now) {
    for (const [name, run] of running) {
      const quietMs = now - run.lastStepAt;
      if (run.stallSaid || quietMs < STALL_MS) continue;
      run.stallSaid = true;
      print(`${name} looks stuck: no progress for ${Math.floor(quietMs / 60000)} minutes on ${run.title}. `
        + `last step: ${run.lastStep || 'none yet'}`);
    }
  }

  // Every REQUEUE_MS, put back member changes GitHub dropped from its merge
  // line, so nobody has to run atris land --requeue. A dry run never pushes.
  // A failure is said once until a later look works.
  function putBackDropped(now) {
    if (dryRun || !deps.requeueDropped || now - lastRequeueAt < REQUEUE_MS) return;
    lastRequeueAt = now;
    let out;
    try {
      out = deps.requeueDropped();
      requeueFailSaid = false;
    } catch (error) {
      if (!requeueFailSaid) print(`could not check github's merge line: ${oneLine(error && error.message || error)}`);
      requeueFailSaid = true;
      return;
    }
    for (const result of (out && out.results) || []) {
      if (result && REQUEUE_SAID.has(result.state)) print(oneLine(result.line));
    }
  }

  // An empty list: the member writes its next job from its mission. The new
  // task is the one it starts on; a skip or an error leaves it idle.
  function ownNextJob(name, s) {
    if (!deps.writeNextJob) return null;
    let out;
    try {
      out = deps.writeNextJob(name, { dryRun });
    } catch (error) {
      if (!s.idle) print(`${name} could not write its own next job: ${oneLine(error && error.message || error)}`);
      return null;
    }
    const task = out && out.task;
    if (!task || !hasRunnableCheck(task)) return null;
    print(`${name} had no job, so it ${dryRun ? 'would write' : 'wrote'} its own from its mission: ${oneLine(task.title)}`);
    return task;
  }

  // One pass over the team. Returns the members it started (or would start).
  function check() {
    const now = deps.now();
    callOutStalls(now);
    putBackDropped(now);
    const started = [];
    const taken = new Set(Array.from(running.values()).map((run) => run.taskId).filter(Boolean));
    const team = deps.listMembers();
    const members = only ? team.filter((m) => m && only.has(m.name)) : team;
    if (only) {
      const known = new Set(team.map((m) => m && m.name).filter(Boolean));
      for (const name of only) {
        if (known.has(name) || skippedUnknown.has(name)) continue;
        skippedUnknown.add(name);
        print(`${name} is not on the team, skipping`);
      }
    }
    liveElsewhere = new Set(members.filter((m) => m && m.name && m.live).map((m) => m.name));
    for (const member of members) {
      const name = member && member.name;
      if (!name || member.parked || member.human || member.sleeping) continue;
      if (running.has(name) || member.live) continue;
      if (working() + (dryRun ? started.length : 0) >= max) break;
      const s = seat(name);
      if (now < s.nextCheckAt) continue;
      const picked = deps.pickTask(name, taken);
      let task = picked && hasRunnableCheck(picked) ? picked : null;
      if (!task) task = ownNextJob(name, s);
      if (!task) {
        s.empty += 1;
        if (!s.idle && !dryRun) print(idleLine(name));
        s.idle = true;
        const wait = idleWaitMs(s.empty);
        if (wait) s.nextCheckAt = now + wait;
        continue;
      }
      const title = oneLine(task.title);
      if (task.id) taken.add(task.id);
      if (dryRun) {
        print(`would start ${name} on: ${title}`);
        started.push({ name, task });
        continue;
      }
      const run = { taskId: task.id || null, title, startedAt: now, lastStepAt: now, announced: false };
      running.set(name, run);
      try {
        deps.spawn(name, (code, result) => {
          deps.flushProgress?.();
          if (running.get(name) === run) finish(name, code, result);
        }, (claimedTask) => claimed(name, run, claimedTask));
      } catch (error) {
        running.delete(name);
        print(`${name} failed to start: ${oneLine(error && error.message || error)}`);
        continue;
      }
      started.push({ name, task });
    }
    try {
      otherKindHints(team, members.filter((m) => m && m.name && !m.parked && !m.human && !m.sleeping), taken);
    } catch {}
    if (!dryRun && now - lastSummaryAt >= SUMMARY_MS) {
      lastSummaryAt = now;
      print(summary());
    }
    return started;
  }

  return {
    check,
    progress,
    summary,
    running: () => Array.from(running.keys()),
    working,
    max,
    only: only ? Array.from(only) : null,
    idle: () => Array.from(state.entries()).filter(([, s]) => s.idle).map(([name]) => name),
  };
}

// The child's final one-line JSON carries the checked task outcome, even when
// the CLI exits zero after releasing a failed task. Never turn that into done.
function memberUpResult(stdout, stderr = '', signal = '') {
  for (const line of String(stdout || '').trim().split('\n').reverse()) {
    let result;
    try { result = JSON.parse(line); } catch { continue; }
    if (!result || typeof result !== 'object' || Array.isArray(result)) continue;
    if (!result.task) {
      if (result.mode === 'idle') return { ok: false, reason: result.reason };
      if (result.error) return { ok: false, reason: result.error };
      continue;
    }
    if (result.task.outcome !== 'review') return { ok: false, reason: result.task.reason || 'the check did not pass' };
    return { ok: true, summary: result.work_step?.summary || '' };
  }
  return { ok: false, reason: signal ? `stopped by ${signal.toLowerCase()}`
    : oneLine(stderr) || 'run ended without a checked task result' };
}

// Reads `member up` flags: --max N, --only a,b and --dry-run (or --plan).
// Returns { max, only, dryRun } or { error }.
function parseMemberUpArgs(args = []) {
  const list = args.map((arg) => String(arg == null ? '' : arg));
  const valueOf = (flag) => {
    const at = list.indexOf(flag);
    if (at >= 0) return list[at + 1] == null ? '' : list[at + 1];
    const inline = list.find((arg) => arg.startsWith(`${flag}=`));
    return inline == null ? null : inline.slice(flag.length + 1);
  };
  // --plan only plans, same as on a single wake: `member wake a --keep --plan`
  // must never start a paid run.
  const out = { max: undefined, only: null, dryRun: list.includes('--dry-run') || list.includes('--plan') };
  const maxText = valueOf('--max');
  if (maxText != null) {
    const max = Number(maxText);
    if (!(Number.isInteger(max) && max > 0)) return { error: '--max needs a whole number above zero.' };
    out.max = max;
  }
  const onlyText = valueOf('--only');
  if (onlyText != null) {
    const names = onlyText.split(',').map((name) => name.trim()).filter((name) => name && !name.startsWith('-'));
    if (!names.length) return { error: '--only needs member names, like --only navigator,executor' };
    out.only = Array.from(new Set(names));
  }
  return out;
}

// Runs checks every minute until stop() is called. `sleep(ms)` must resolve
// after ms or as soon as the returned stop fires.
function runMemberUp(deps, options = {}) {
  // Begin following before any child starts, so its first step cannot be lost.
  let follower;
  const up = createMemberUp({ ...deps, flushProgress: () => follower?.scan() }, options);
  if (!options.dryRun) follower = followBoard({
    dir: options.progressDir,
    pollMs: options.progressPollMs,
    orderByTime: true,
    emit: (event) => up.progress(event),
  });
  let stopped = false;
  let wake = null;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => { clearTimeout(timer); resolve(); };
  }));
  const done = (async () => {
    while (!stopped) {
      up.check();
      if (stopped) break;
      await sleep(options.checkMs || CHECK_MS);
    }
    return up;
  })();
  return {
    up,
    done,
    scanProgress: () => follower?.scan(),
    stop() {
      stopped = true;
      follower?.stop();
      if (wake) wake();
    },
  };
}

module.exports = {
  CHECK_MS,
  DEFAULT_MAX,
  IDLE_CHECK_MS,
  IDLE_EXIT,
  IDLE_MAX_CHECK_MS,
  REQUEUE_MS,
  STALL_MS,
  SUMMARY_MS,
  createMemberUp,
  idleWaitMs,
  memberUpResult,
  memberMaintenance,
  parseMemberUpArgs,
  runMemberUp,
};
