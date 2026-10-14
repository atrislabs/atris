'use strict';

// `atris member up`: a small foreground supervisor that keeps the team
// working. Each check it looks at every runnable member, and when one has no
// live run and a task with a runnable check fits it, starts
// `atris member go <name> --needs-check` so the member claims and runs that
// task. A member with no such task stays idle; it never falls back to its
// own mission or goal text. The clock, the spawner, the member list and the
// task picker are passed in, so tests drive it with fake time.

const { taskCheck } = require('./member-task-pick');
const { followBoard } = require('./member-board');

const CHECK_MS = 60 * 1000;
const IDLE_CHECK_MS = 5 * 60 * 1000;
const SUMMARY_MS = 10 * 60 * 1000;
const IDLE_AFTER_EMPTY = 3;
const DEFAULT_MAX = 6;
// Exit code `member go --needs-check` uses when it found no task with a check
// to claim (another run took it first). Not a failure, just idle.
const IDLE_EXIT = 75;
// A member name that gets each job by itself, for the add-one hint.
const JOB_MEMBER = { build: 'builder', review: 'reviewer', search: 'researcher' };

function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
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
//   spawn(name, onExit) -> any                         (onExit(code) when it ends)
//   now() -> ms
//   print(line)
//   jobOf(name) -> 'build' | 'review' | 'search'       (optional)
//   waitingTasks() -> [{ id, title, job }]            (optional; open tasks
//                     with a runnable check, any job)
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
  // Members working right now: the runs this supervisor started plus any
  // live run started some other way. Both count toward --max.
  let liveElsewhere = new Set();
  const working = () => new Set([...running.keys(), ...liveElsewhere]).size;

  const seat = (name) => {
    if (!state.has(name)) state.set(name, { empty: 0, idle: false, nextCheckAt: 0 });
    return state.get(name);
  };

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
    const time = new Date(event.at);
    const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
    print(`  ${event.member} ${hhmm}  ${oneLine(event.text)}`);
  }

  function summary() {
    const idle = Array.from(state.values()).filter((s) => s.idle).length;
    return `working ${working()}, idle ${idle}, done today ${doneToday}`;
  }

  // One pass over the team. Returns the members it started (or would start).
  function check() {
    const now = deps.now();
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
      const task = picked && hasRunnableCheck(picked) ? picked : null;
      if (!task) {
        s.empty += 1;
        if (!s.idle && !dryRun) print(idleLine(name));
        s.idle = true;
        if (s.empty >= IDLE_AFTER_EMPTY) s.nextCheckAt = now + IDLE_CHECK_MS;
        continue;
      }
      const title = oneLine(task.title);
      if (task.id) taken.add(task.id);
      if (dryRun) {
        print(`would start ${name} on: ${title}`);
        started.push({ name, task });
        continue;
      }
      if (s.idle) print(`${name} woke up for: ${title}`);
      s.idle = false;
      s.empty = 0;
      s.nextCheckAt = 0;
      running.set(name, { taskId: task.id || null, startedAt: now });
      try {
        deps.spawn(name, (code, result) => {
          deps.flushProgress?.();
          finish(name, code, result);
        });
      } catch (error) {
        running.delete(name);
        print(`${name} failed to start: ${oneLine(error && error.message || error)}`);
        continue;
      }
      print(`${name} started on: ${title}`);
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

// Reads `member up` flags: --max N, --only a,b and --dry-run.
// Returns { max, only, dryRun } or { error }.
function parseMemberUpArgs(args = []) {
  const list = args.map((arg) => String(arg == null ? '' : arg));
  const valueOf = (flag) => {
    const at = list.indexOf(flag);
    if (at >= 0) return list[at + 1] == null ? '' : list[at + 1];
    const inline = list.find((arg) => arg.startsWith(`${flag}=`));
    return inline == null ? null : inline.slice(flag.length + 1);
  };
  const out = { max: undefined, only: null, dryRun: list.includes('--dry-run') };
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
  SUMMARY_MS,
  createMemberUp,
  memberUpResult,
  parseMemberUpArgs,
  runMemberUp,
};
