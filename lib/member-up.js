'use strict';

// `atris member up`: a small foreground supervisor that keeps the team
// working. Each check it looks at every runnable member, and when one has no
// live run and a task fits it, starts `atris member go <name>` so the member
// claims and runs that task. The clock, the spawner, the member list and the
// task picker are passed in, so tests drive it with fake time.

const CHECK_MS = 60 * 1000;
const IDLE_CHECK_MS = 5 * 60 * 1000;
const SUMMARY_MS = 10 * 60 * 1000;
const IDLE_AFTER_EMPTY = 3;
const DEFAULT_MAX = 6;

function dayOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// deps:
//   listMembers() -> [{ name, parked, human, sleeping, live }]
//   pickTask(name, takenIds) -> { id, title } | null   (looks only, never claims)
//   spawn(name, onExit) -> any                         (onExit(code) when it ends)
//   now() -> ms
//   print(line)
function createMemberUp(deps, options = {}) {
  const max = Math.max(1, Number(options.max) || DEFAULT_MAX);
  const dryRun = options.dryRun === true;
  const print = deps.print || ((line) => console.log(line));
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

  function finish(name, code) {
    if (!running.has(name)) return;
    running.delete(name);
    const now = deps.now();
    if (dayOf(now) !== doneDay) {
      doneDay = dayOf(now);
      doneToday = 0;
    }
    const s = seat(name);
    s.empty = 0;
    s.nextCheckAt = 0;
    if (code === 0) {
      doneToday += 1;
      print(`${name} finished ok`);
    } else {
      print(`${name} failed${code == null ? '' : ` (exit ${code})`}`);
    }
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
    const members = deps.listMembers();
    liveElsewhere = new Set(members.filter((m) => m && m.name && m.live).map((m) => m.name));
    for (const member of members) {
      const name = member && member.name;
      if (!name || member.parked || member.human || member.sleeping) continue;
      if (running.has(name) || member.live) continue;
      if (working() + (dryRun ? started.length : 0) >= max) break;
      const s = seat(name);
      if (now < s.nextCheckAt) continue;
      const task = deps.pickTask(name, taken);
      if (!task) {
        s.empty += 1;
        if (s.empty >= IDLE_AFTER_EMPTY) {
          if (!s.idle && !dryRun) print(`${name} is idle, nothing to do`);
          s.idle = true;
          s.nextCheckAt = now + IDLE_CHECK_MS;
        }
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
        deps.spawn(name, (code) => finish(name, code));
      } catch (error) {
        running.delete(name);
        print(`${name} failed to start: ${oneLine(error && error.message || error)}`);
        continue;
      }
      print(`${name} started on: ${title}`);
      started.push({ name, task });
    }
    if (!dryRun && now - lastSummaryAt >= SUMMARY_MS) {
      lastSummaryAt = now;
      print(summary());
    }
    return started;
  }

  return {
    check,
    summary,
    running: () => Array.from(running.keys()),
    working,
    max,
    idle: () => Array.from(state.entries()).filter(([, s]) => s.idle).map(([name]) => name),
  };
}

// Runs checks every minute until stop() is called. `sleep(ms)` must resolve
// after ms or as soon as the returned stop fires.
function runMemberUp(deps, options = {}) {
  const up = createMemberUp(deps, options);
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
    stop() {
      stopped = true;
      if (wake) wake();
    },
  };
}

module.exports = {
  CHECK_MS,
  DEFAULT_MAX,
  IDLE_AFTER_EMPTY,
  IDLE_CHECK_MS,
  SUMMARY_MS,
  createMemberUp,
  runMemberUp,
};
