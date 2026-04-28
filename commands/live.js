const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_INTERVAL_SEC = 120;
const DEFAULT_DEBOUNCE_SEC = 30;
const DEFAULT_TIMEOUT_SEC = 600;

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'release', '.next', '__pycache__']);
const IGNORED_FILES = new Set(['.DS_Store']);

function parseNumberFlag(args, name, fallback) {
  const eq = args.find((arg) => arg.startsWith(`--${name}=`));
  if (eq) {
    const value = Number(eq.slice(name.length + 3));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) {
    const value = Number(args[idx + 1]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
  return fallback;
}

function parseStringFlag(args, name) {
  const eq = args.find((arg) => arg.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('-')) return args[idx + 1];
  return null;
}

function firstPositionalArg(args) {
  const flagsWithValues = new Set(['--interval', '--debounce', '--timeout', '--only', '--root']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flagsWithValues.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return null;
}

function readBusinessSlugFromCwd(cwd) {
  const file = path.join(cwd, '.atris', 'business.json');
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data.slug || data.canonical_slug || data.name || null;
  } catch {
    return null;
  }
}

function parseLiveOptions(args, cwd = process.cwd()) {
  const first = firstPositionalArg(args);
  return {
    slug: first || readBusinessSlugFromCwd(cwd),
    once: args.includes('--once'),
    dryRun: args.includes('--dry-run'),
    noDoctor: args.includes('--no-doctor'),
    noPush: args.includes('--no-push'),
    intervalSec: parseNumberFlag(args, 'interval', DEFAULT_INTERVAL_SEC),
    debounceSec: parseNumberFlag(args, 'debounce', DEFAULT_DEBOUNCE_SEC),
    timeoutSec: parseNumberFlag(args, 'timeout', DEFAULT_TIMEOUT_SEC),
    only: parseStringFlag(args, 'only'),
    root: parseStringFlag(args, 'root') || path.dirname(cwd),
    cwd,
  };
}

function printLiveHelp() {
  console.log('Usage: atris live [business] [options]');
  console.log('');
  console.log('Keeps a business brain fresh: doctor, pull, watch local changes, push after quiet, and periodically pull.');
  console.log('');
  console.log('Examples:');
  console.log('  atris live atris-labs');
  console.log('  atris live --once');
  console.log('  atris live atris-labs --dry-run');
  console.log('  atris live atris-labs --interval=120 --debounce=30');
  console.log('');
  console.log('Options:');
  console.log('  --once             Run one freshness cycle and exit');
  console.log('  --dry-run          Print the plan without running pull/push');
  console.log('  --interval <sec>   Seconds between cloud pulls (default: 120)');
  console.log('  --debounce <sec>   Quiet seconds before pushing local changes (default: 30)');
  console.log('  --timeout <sec>    Pull timeout passed through to atris pull (default: 600)');
  console.log('  --only <prefix>    Limit pull/push to a path prefix');
  console.log('  --no-doctor        Skip business doctor --fix');
  console.log('  --no-push          Pull/watch only; never push');
}

function shouldIgnore(relativePath) {
  if (!relativePath) return true;
  const parts = relativePath.split(path.sep);
  if (parts.some((part) => IGNORED_DIRS.has(part))) return true;
  if (IGNORED_FILES.has(path.basename(relativePath))) return true;
  if (relativePath.startsWith(path.join('.atris', 'state'))) return true;
  return false;
}

function collectSnapshot(root) {
  const snapshot = new Map();

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (shouldIgnore(rel)) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          snapshot.set(rel, `${stat.size}:${Math.floor(stat.mtimeMs)}`);
        } catch {
          // Files can disappear while the operator is saving.
        }
      }
    }
  }

  walk(root);
  return snapshot;
}

function snapshotsDiffer(a, b) {
  if (a.size !== b.size) return true;
  for (const [key, value] of a.entries()) {
    if (b.get(key) !== value) return true;
  }
  return false;
}

function commandLine(argv) {
  return ['atris', ...argv].join(' ');
}

function runCli(argv, options) {
  if (options.dryRun) {
    console.log(`  dry-run: ${commandLine(argv)}`);
    return Promise.resolve({ status: 0 });
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), ...argv], {
      cwd: options.cwd,
      stdio: 'inherit',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    child.on('error', reject);
    child.on('exit', (status) => {
      if (status === 0) resolve({ status });
      else reject(new Error(`${commandLine(argv)} exited ${status}`));
    });
  });
}

function buildPullArgs(options) {
  const args = ['pull', options.slug, '--timeout', String(options.timeoutSec)];
  if (options.only) args.push('--only', options.only);
  return args;
}

function buildPushArgs(options) {
  const args = ['push', options.slug, '--from', options.cwd];
  if (options.only) args.push('--only', options.only);
  return args;
}

async function runFreshnessCycle(options, reason) {
  console.log('');
  console.log(`atris live: ${reason}`);
  if (!options.noDoctor) {
    await runCli(['business', 'doctor', '--fix', '--root', options.root], options);
  }
  if (!options.noPush) {
    await runCli(buildPushArgs(options), options);
  }
  await runCli(buildPullArgs(options), options);
}

async function liveCommand(args = process.argv.slice(3)) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    printLiveHelp();
    return;
  }

  const options = parseLiveOptions(args);
  if (!options.slug) {
    console.error('Usage: atris live [business]');
    console.error('Run inside a business workspace or pass a business slug.');
    process.exit(1);
  }

  console.log('');
  console.log(`Atris Live: ${options.slug}`);
  console.log(`  workspace: ${options.cwd}`);
  console.log(`  interval: ${options.intervalSec}s`);
  console.log(`  debounce: ${options.debounceSec}s`);
  console.log(`  push: ${options.noPush ? 'off' : 'on'}`);
  if (options.only) console.log(`  only: ${options.only}`);

  if (options.dryRun) {
    await runFreshnessCycle(options, 'planned startup cycle');
    if (!options.once) console.log(`  dry-run: would watch ${options.cwd} and sync every ${options.intervalSec}s`);
    return;
  }

  await runFreshnessCycle(options, 'startup freshness cycle');
  if (options.once) return;

  console.log('');
  console.log('Brain fresh. Watching for local changes. Press Ctrl+C to stop.');

  let lastSnapshot = collectSnapshot(options.cwd);
  let pendingPush = false;
  let quietTicks = 0;
  let running = false;

  async function guarded(label, fn) {
    if (running) return;
    running = true;
    try {
      await fn();
      lastSnapshot = collectSnapshot(options.cwd);
      pendingPush = false;
      quietTicks = 0;
    } catch (err) {
      console.error(`\natris live paused after ${label}: ${err.message || err}`);
      console.error('Fix the issue, then restart `atris live`.');
      process.exit(1);
    } finally {
      running = false;
    }
  }

  setInterval(() => {
    if (running) return;
    const current = collectSnapshot(options.cwd);
    if (snapshotsDiffer(lastSnapshot, current)) {
      pendingPush = true;
      quietTicks = 0;
      lastSnapshot = current;
      process.stdout.write('\rLocal brain changed. Waiting for quiet before push... ');
      return;
    }
    if (pendingPush) {
      quietTicks += 1;
      if (quietTicks >= options.debounceSec) {
        void guarded('push', async () => {
          console.log('\nLocal brain quiet. Pushing fresh state...');
          if (!options.noPush) await runCli(buildPushArgs(options), options);
        });
      }
    }
  }, 1000);

  setInterval(() => {
    if (pendingPush) {
      process.stdout.write('\rLocal changes pending; skipping cloud pull until local brain is pushed... ');
      return;
    }
    void guarded('periodic pull', async () => {
      console.log('\nChecking cloud for fresher brain...');
      await runCli(buildPullArgs(options), options);
    });
  }, options.intervalSec * 1000);
}

module.exports = {
  collectSnapshot,
  liveCommand,
  parseLiveOptions,
  shouldIgnore,
  snapshotsDiffer,
};
