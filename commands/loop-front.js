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
//
// The loop reads ROADMAP.md for what to pursue.

function isFlag(arg) {
  return typeof arg === 'string' && arg.startsWith('-');
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
    case 'wiki':
      // Forward the remaining args (e.g. --json, --limit=) to wiki upkeep.
      return { action: 'wiki', rest: argv.filter((a) => a.toLowerCase() !== 'wiki') };
    case '': {
      // A start flag with no `start` verb does nothing on its own; nudge.
      const stray = ['--overnight', '--cloud', '--once'].find((f) => argv.includes(f));
      return stray ? { action: 'home', strayStartFlag: stray } : { action: 'home' };
    }
    default:
      return { action: 'home', unknown: sub };
  }
}

function renderLoopHome(route = { action: 'home' }) {
  const lines = [
    '',
    'atris loop: the self-improvement loop',
    '',
    '  one loop: plan, do, review, verify, commit. it ships one small',
    '  verifiable change at a time, then goes again. it reads ROADMAP.md',
    '  for what to pursue.',
    '',
    '  start it',
    '    atris loop start              run it now, here (local)',
    '    atris loop start --once       one cycle, then stop',
    '    atris loop start --overnight  install the durable heartbeat (~15m)',
    '',
    '  watch it',
    '    atris loop status             liveness, last tick, reward',
    '    atris run logs                read each phase (local runs)',
    '',
    '  stop it',
    '    atris loop stop               remove the durable heartbeat',
    '',
    '  wiki upkeep is at: atris loop wiki',
    '',
  ];
  if (route && route.unknown) {
    lines.splice(1, 0, `  (unknown: "${route.unknown}". here is the loop:)`);
  }
  if (route && route.strayStartFlag) {
    lines.splice(1, 0, `  (did you mean: atris loop start ${route.strayStartFlag}?)`);
  }
  return lines.join('\n');
}

function printLoopHome(route) {
  console.log(renderLoopHome(route));
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

    case 'status':
      return Promise.resolve(require('./pulse').pulseCommand(['status', ...jsonFlag]))
        .then((res) => {
          // Pulse covers the overnight heartbeat; also surface local runs so
          // `atris loop status` reflects both engines, not just pulse.
          if (!jsonFlag.length) printLocalRunSummary();
          return res && res.ok === false ? 1 : 0;
        });

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
  loopFront,
};
