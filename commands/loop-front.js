'use strict';

// `atris loop` is the single front door to the self-improvement loop.
//
// Before this, "start a loop" meant guessing between six commands: run,
// autopilot, mission, improve, pulse, and the old wiki `loop`. This collapses
// the ENTRY to one plain-English verb and delegates to the engines that already
// exist. It does not add a seventh engine.
//
//   atris loop                    home: status + the next moves
//   atris loop start              run it now, here (local)      -> run.js
//   atris loop start --once       one cycle, then stop          -> run.js
//   atris loop start --overnight  durable heartbeat (~15m)      -> pulse.js
//   atris loop status             liveness, last tick, reward   -> pulse.js
//   atris loop stop               remove the durable heartbeat  -> pulse.js
//   atris loop wiki               wiki upkeep (the old `loop`)  -> loop.js
//   atris loop create-next        create + claim the suggested task
//
// The loop reads ROADMAP.md for what to pursue.

function isFlag(arg) {
  return typeof arg === 'string' && arg.startsWith('-');
}

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !isFlag(value) ? value : true;
}

// Pure router: decide what `atris loop ...` means without executing anything.
// Kept side-effect-free so it is trivially testable.
function routeLoop(argv = []) {
  const positional = argv.filter((a) => !isFlag(a));
  const sub = (positional[0] || '').toLowerCase();
  const cloud = argv.includes('--cloud') || argv.includes('--overnight');
  const once = argv.includes('--once');

  switch (sub) {
    case 'start':
      return { action: cloud ? 'start-overnight' : 'start-local', once };
    case 'status':
      return { action: 'status' };
    case 'stop':
      return { action: 'stop' };
    case 'create-next':
    case 'claim-next':
    case 'take-next':
      return { action: 'create-next' };
    case 'wiki':
      // Forward the remaining args (e.g. --json, --limit=) to wiki upkeep.
      return { action: 'wiki', rest: argv.filter((a) => a.toLowerCase() !== 'wiki') };
    case 'add': {
      // Everything after `add` (minus flags) is the item text.
      const i = argv.findIndex((a) => a.toLowerCase() === 'add');
      const text = argv.slice(i + 1).filter((a) => !isFlag(a)).join(' ').trim();
      return { action: 'add', text };
    }
    case 'report':
      return { action: 'report' };
    case '': {
      // A start flag with no `start` verb does nothing on its own; nudge.
      const stray = ['--overnight', '--cloud', '--once'].find((f) => argv.includes(f));
      return stray ? { action: 'home', strayStartFlag: stray } : { action: 'home' };
    }
    default:
      return { action: 'home', unknown: sub };
  }
}

function renderLoopHome(route = { action: 'home' }, moves = []) {
  const lines = [
    '',
    'atris loop: the self-improvement loop',
    '',
    '  one loop: plan, do, review, verify, commit. it ships one small',
    '  verifiable change at a time, then goes again. it reads ROADMAP.md',
    '  for what to pursue.',
    '',
    '  feed it',
    '    atris loop add "<task>"        put a bounded task into the queue',
    '',
    '  start it',
    '    atris loop start              run it now, here (local)',
    '    atris loop start --once       one cycle, then stop',
    '    atris loop start --overnight  install the durable heartbeat (~15m)',
    '    atris loop start --overnight --hours 6',
    '',
    '  watch it',
    '    atris loop status             liveness, last tick, reward',
    '    atris loop report             what the loop has handled and what is next',
    '    atris run logs                read each phase (local runs)',
    '',
    '  stop it',
    '    atris loop stop               remove the durable heartbeat',
    '',
    '  wiki upkeep is at: atris loop wiki',
    '',
  ];
  if (Array.isArray(moves) && moves.length) {
    lines.splice(lines.length - 2, 0, '  ranked next moves');
    moves.slice(0, 3).forEach((move) => {
      lines.splice(lines.length - 2, 0, `    [${move.source}] ${move.title}`);
    });
    lines.splice(lines.length - 2, 0, '');
  }
  lines.splice(lines.length - 2, 0, '  act on it');
  lines.splice(lines.length - 2, 0, '    atris loop create-next       create + claim the suggested task');
  lines.splice(lines.length - 2, 0, '');
  if (route && route.unknown) {
    lines.splice(1, 0, `  (unknown: "${route.unknown}". here is the loop:)`);
  }
  if (route && route.strayStartFlag) {
    lines.splice(1, 0, `  (did you mean: atris loop start ${route.strayStartFlag}?)`);
  }
  return lines.join('\n');
}

function printLoopHome(route) {
  let moves = [];
  try {
    moves = require('../lib/next-moves').nextMoves(process.cwd(), 3);
  } catch { /* next moves are optional on a fresh checkout */ }
  console.log(renderLoopHome(route, moves));
}

// Parse the handful of local-run flags `atris loop start` forwards to run.js.
function startLocalOptions(argv = []) {
  const opts = {
    once: argv.includes('--once'),
    verbose: argv.includes('--verbose') || argv.includes('-v'),
    dryRun: argv.includes('--dry-run'),
    push: !argv.includes('--no-push'),
  };
  const cyclesArg = argv.find((a) => a.startsWith('--cycles='));
  if (cyclesArg) {
    const n = parseInt(cyclesArg.split('=')[1], 10);
    if (!Number.isNaN(n)) opts.maxCycles = n;
  }
  const timeoutArg = argv.find((a) => a.startsWith('--timeout='));
  if (timeoutArg) {
    const n = parseInt(timeoutArg.split('=')[1], 10);
    if (!Number.isNaN(n)) opts.timeout = n * 1000;
  }
  return opts;
}

// Summarize the local plan/do/review run logs (run.js writes these). Pure of
// console, takes the dir, so it is testable.
function localRunSummary(dir) {
  const fs = require('fs');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return { count: 0, latest: null };
  }
  if (!files.length) return { count: 0, latest: null };
  return { count: files.length, latest: files[files.length - 1] };
}

function printLocalRunSummary() {
  try {
    const { getRunLogDir } = require('./run');
    const s = localRunSummary(getRunLogDir());
    if (!s.count) {
      console.log('local runs: none yet. start one with `atris loop start`.');
      return;
    }
    console.log(`local runs: ${s.count} logged, latest ${s.latest}. read them: atris run logs`);
  } catch { /* best-effort: never block status */ }
}

// Combined machine-readable status: the overnight pulse heartbeat and the local
// runs in one object. Best-effort per engine so a missing one does not fail it.
function loopStatusJson(root = process.cwd()) {
  const out = { ok: true, action: 'loop_status', pulse: null, local_runs: { count: 0, latest: null }, next_moves: [] };
  try {
    const lp = require('../lib/pulse');
    const { cronInstalled } = require('./pulse');
    const summary = lp.summarizePulse(lp.readPulseReceipts(root));
    out.pulse = { cron_installed: cronInstalled(), ...summary };
  } catch { /* pulse optional */ }
  try {
    out.local_runs = localRunSummary(require('./run').getRunLogDir());
  } catch { /* runs optional */ }
  try {
    out.next_moves = require('../lib/next-moves').nextMoves(root, 5);
  } catch { /* next moves optional */ }
  return out;
}

function loopSeedMove(root = process.cwd()) {
  const moves = require('../lib/next-moves').nextMoves(root, 5);
  const activeTask = moves.find((move) => move && move.source === 'task');
  if (activeTask) return { ok: false, reason: 'active_task', move: activeTask, moves };
  const seed = moves.find((move) => (
    move
    && move.source === 'mission'
    && (
      move.why === 'active mission has no concrete task queued'
      || move.why === 'latest proof timeline suggested this self-improvement target'
    )
  ));
  if (!seed) return { ok: false, reason: 'no_seed', moves };
  return { ok: true, move: seed, moves };
}

function createNextLoopTask(argv = [], root = process.cwd(), options = {}) {
  const shouldPrint = options.print !== false;
  const json = argv.includes('--json');
  const owner = flagValue(argv, '--as') || flagValue(argv, '--owner') || process.env.ATRIS_AGENT_ID || 'auto-improver';
  const seed = loopSeedMove(root);
  if (!seed.ok) {
    const payload = { ok: false, action: 'create_next_skipped', reason: seed.reason, move: seed.move || null };
    if (shouldPrint) {
      if (json) console.log(JSON.stringify(payload, null, 2));
      else if (seed.reason === 'active_task') console.log(`not created: active task already exists (${seed.move.ref || seed.move.title})`);
      else console.log('not created: no loop seed is available');
    }
    return payload;
  }

  const note = `Goal: ${seed.move.title}. Files: inspect atris/MAP.md first, then the relevant code. Done: one bounded proof-backed self-improvement task is moved to Review. Check: focused verifier; git diff --check; atris clean --dry-run --json; atris brain compile --root . --verify.`;
  const taskArgs = [
    'task',
    'delegate',
    seed.move.title,
    '--tag', 'loop',
    '--claim',
    '--as', String(owner),
    '--note', note,
    '--json',
  ];
  const { spawnSync } = require('child_process');
  const path = require('path');
  const cli = path.join(__dirname, '..', 'bin', 'atris.js');
  const child = spawnSync(process.execPath, [cli, ...taskArgs], {
    cwd: root,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (child.status !== 0) {
    const payload = { ok: false, action: 'create_next_failed', reason: 'task_delegate_failed', stderr: child.stderr, stdout: child.stdout };
    if (shouldPrint) {
      if (json) console.log(JSON.stringify(payload, null, 2));
      else console.error(child.stderr || child.stdout || 'task creation failed');
    }
    return payload;
  }
  let delegated = null;
  try { delegated = JSON.parse(child.stdout); } catch { delegated = null; }
  const task = delegated && delegated.task ? delegated.task : null;
  const payload = { ok: true, action: 'created_next', owner: String(owner), move: seed.move, task, delegated };
  if (shouldPrint) {
    if (json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      const ref = task?.display_id || task?.id || 'task';
      console.log(`created next loop task: ${ref} ${seed.move.title}`);
      console.log(`claimed by: ${owner}`);
      console.log(`next: atris task show ${ref}`);
    }
  }
  return payload;
}

// The evidence that the loop is improving things: ROADMAP items it has handled,
// what is in flight and queued, and the heartbeat's reward/verify trend. Pure of
// console so it is testable.
function loopReport(root = process.cwd()) {
  const status = loopStatusJson(root);
  let roadmap = { open: [], claimed: [], done: [] };
  try {
    roadmap = require('../lib/next-moves').roadmapItemsByState(root);
  } catch { /* roadmap optional */ }
  return { ok: true, action: 'loop_report', roadmap, next_moves: status.next_moves, pulse: status.pulse, local_runs: status.local_runs };
}

function renderLoopReport(rep) {
  const r = rep.roadmap;
  const lines = ['', 'loop report: what the self-improvement loop has done', ''];
  lines.push(`  roadmap: ${r.done.length} done, ${r.claimed.length} in flight, ${r.open.length} queued`);
  if (r.done.length) {
    lines.push('');
    lines.push('  handled:');
    r.done.slice(0, 6).forEach((t) => lines.push(`    [x] ${t}`));
    if (r.done.length > 6) lines.push(`    ... and ${r.done.length - 6} more`);
  }
  if (r.claimed.length) {
    lines.push('');
    lines.push('  in flight:');
    r.claimed.slice(0, 4).forEach((t) => lines.push(`    [~] ${t}`));
  }
  if (r.open.length) {
    lines.push('');
    lines.push('  next up:');
    r.open.slice(0, 4).forEach((t) => lines.push(`    [ ] ${t}`));
  }
  if (Array.isArray(rep.next_moves) && rep.next_moves.length) {
    lines.push('');
    lines.push('  ranked next:');
    rep.next_moves.slice(0, 5).forEach((move) => lines.push(`    [${move.source}] ${move.title}`));
  }
  if (rep.pulse) {
    lines.push('');
    lines.push(`  heartbeat: ${rep.pulse.total_ticks} ticks, reward ${rep.pulse.reward_sum}, verify ${rep.pulse.verify_pass}/${rep.pulse.verify_fail}`);
  }
  lines.push(`  local runs: ${rep.local_runs.count}`);
  lines.push('');
  return lines.join('\n');
}

// Executor. Returns a Promise resolving to an exit code (0 = ok).
function loopFront(argv = []) {
  const route = routeLoop(argv);
  const jsonFlag = argv.includes('--json') ? ['--json'] : [];

  switch (route.action) {
    case 'home':
      printLoopHome(route);
      return Promise.resolve(0);

    case 'wiki':
      return Promise.resolve(require('./loop').loopAtris(route.rest)).then(() => 0);

    case 'report': {
      const rep = loopReport(process.cwd());
      console.log(jsonFlag.length ? JSON.stringify(rep, null, 2) : renderLoopReport(rep));
      return Promise.resolve(0);
    }

    case 'add': {
      if (!route.text) {
        console.log('usage: atris loop add "<one bounded task the loop should pursue>"');
        return Promise.resolve(0);
      }
      const res = require('../lib/next-moves').addRoadmapItem(process.cwd(), route.text);
      if (res.added) {
        console.log(`added to the loop: ${res.title}`);
        console.log('see it: atris moves   |   run it: atris loop start');
      } else {
        console.log(`not added (${res.reason}${res.title ? `: ${res.title}` : ''})`);
      }
      return Promise.resolve(0);
    }

    case 'create-next': {
      const result = createNextLoopTask(argv, process.cwd());
      return Promise.resolve(result.ok ? 0 : 1);
    }

    case 'status': {
      if (jsonFlag.length) {
        // One machine-readable object covering BOTH engines (overnight pulse
        // heartbeat + local runs), for headless agents and web status.
        const out = loopStatusJson(process.cwd());
        console.log(JSON.stringify(out, null, 2));
        return Promise.resolve(out.ok === false ? 1 : 0);
      }
      return Promise.resolve(require('./pulse').pulseCommand(['status']))
        .then((res) => {
          // Pulse covers the overnight heartbeat; also surface local runs so
          // `atris loop status` reflects both engines, not just pulse.
          printLocalRunSummary();
          return res && res.ok === false ? 1 : 0;
        });
    }

    case 'stop':
      return Promise.resolve(require('./pulse').pulseCommand(['uninstall', ...jsonFlag]))
        .then((res) => (res && res.ok === false ? 1 : 0));

    case 'start-overnight': {
      // Durable heartbeat via the pulse OS-cron installer. Pass through any
      // pulse install flags the operator added (e.g. --cadence).
      const passthrough = argv.filter((a) => a !== 'start' && a !== '--overnight' && a !== '--cloud');
      return Promise.resolve(require('./pulse').pulseCommand(['install', ...passthrough]))
        .then((res) => {
          const failed = res && res.ok === false;
          // Keep the front door consistent: the stop verb is `atris loop stop`,
          // not the underlying pulse command.
          if (!failed && !argv.includes('--json')) console.log('to stop: atris loop stop');
          return failed ? 1 : 0;
        });
    }

    case 'start-local':
    default:
      return Promise.resolve(require('./run').runAtris(startLocalOptions(argv))).then(() => 0);
  }
}

module.exports = {
  routeLoop,
  renderLoopHome,
  printLoopHome,
  startLocalOptions,
  localRunSummary,
  loopStatusJson,
  loopSeedMove,
  createNextLoopTask,
  loopReport,
  renderLoopReport,
  loopFront,
};
