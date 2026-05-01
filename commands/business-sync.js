const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadManifest } = require('../lib/manifest');

const WATCH_IGNORED_DIRS = new Set(['.git', '.atris', '.claude', 'node_modules', '__pycache__']);
const WATCH_IGNORED_FILES = new Set(['.DS_Store']);

function commandLine(args) {
  return ['atris', ...args].join(' ');
}

function parseFlagValue(args, name, fallback) {
  const eq = args.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('-')) return args[idx + 1];
  return fallback;
}

function parseBusinessSyncArgs(args = []) {
  const slug = args.find((arg) => arg && !arg.startsWith('-')) || null;
  const dryRun = args.includes('--dry-run');
  const timeout = parseFlagValue(args, '--timeout', '120');
  const allowDelete = args.includes('--delete');
  const watch = args.includes('--watch');
  const intervalSec = Number.parseInt(parseFlagValue(args, '--interval', '60'), 10);
  const debounceSec = Number.parseInt(parseFlagValue(args, '--debounce', '5'), 10);

  return { slug, dryRun, timeout, allowDelete, watch, intervalSec, debounceSec };
}

function readBusinessSlug(cwd = process.cwd()) {
  const bizFile = path.join(cwd, '.atris', 'business.json');
  if (!fs.existsSync(bizFile)) return null;
  try {
    const biz = JSON.parse(fs.readFileSync(bizFile, 'utf8'));
    return biz.slug || biz.name || null;
  } catch {
    return null;
  }
}

function resolveBusinessSyncOptions(args = [], cwd = process.cwd()) {
  const options = parseBusinessSyncArgs(args);
  if (!options.slug) options.slug = readBusinessSlug(cwd);
  return options;
}

function buildBusinessSyncPlan(options) {
  if (!options.slug) return null;

  const pullArgs = ['pull', options.slug, '--keep-local', '--fail-on-conflict', '--timeout', String(options.timeout)];
  const pushArgs = ['push', options.slug];
  if (options.dryRun) {
    pullArgs.push('--dry-run');
    pushArgs.push('--dry-run');
  }
  if (options.allowDelete) pushArgs.push('--delete');

  return { pullArgs, pushArgs };
}

function shouldIgnoreWatchPath(relativePath) {
  if (!relativePath) return true;
  const parts = relativePath.split(path.sep);
  if (parts.some((part) => WATCH_IGNORED_DIRS.has(part))) return true;
  return WATCH_IGNORED_FILES.has(path.basename(relativePath));
}

function collectBrainSnapshot(root) {
  const brainDir = path.join(root, 'atris');
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
      const rel = path.relative(brainDir, full);
      if (shouldIgnoreWatchPath(rel)) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          snapshot.set(rel, `${stat.size}:${Math.floor(stat.mtimeMs)}`);
        } catch {
          // Files can move while the editor is saving.
        }
      }
    }
  }

  walk(brainDir);
  return snapshot;
}

function snapshotsDiffer(before, after) {
  if (before.size !== after.size) return true;
  for (const [key, value] of before.entries()) {
    if (after.get(key) !== value) return true;
  }
  return false;
}

function sameRealPath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a || '') === path.resolve(b || '');
  }
}

function canPreviewPush(cwd, slug) {
  const manifest = loadManifest(slug);
  if (!manifest || !manifest.workspace_root) return true;
  return sameRealPath(manifest.workspace_root, cwd);
}

function runCli(args, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'atris.js'), ...args], {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    child.on('error', reject);
    child.on('exit', (status) => {
      if (status === 0) resolve({ status });
      else reject(new Error(`${commandLine(args)} exited ${status}`));
    });
  });
}

async function runSyncCycle(plan, cwd, options = {}) {
  await runCli(plan.pullArgs, cwd);
  if (options.dryRun) {
    if (!canPreviewPush(cwd, options.slug)) {
      console.log('');
      console.log('Publish preview skipped until the pull preview is applied.');
      console.log('  This folder is not the source of the current sync manifest yet.');
      return;
    }
    try {
      await runCli(plan.pushArgs, cwd);
    } catch (err) {
      console.log('');
      console.log('Publish preview skipped until the pull preview is applied.');
      console.log(`  ${err.message || err}`);
    }
    return;
  }
  await runCli(plan.pushArgs, cwd);
}

async function businessSync(args = process.argv.slice(3), cwd = process.cwd()) {
  const options = resolveBusinessSyncOptions(args, cwd);
  const plan = buildBusinessSyncPlan(options);

  if (!plan) {
    console.error('Usage: atris sync [business] [--dry-run] [--watch] [--timeout 120]');
    console.error('Run inside a business workspace or pass a business slug.');
    process.exit(1);
  }

  console.log('');
  console.log(`Syncing ${options.slug} knowledge wiki...`);
  console.log('  scope: atris/');
  if (options.watch) {
    console.log(`  watch: on (${options.intervalSec}s interval, ${options.debounceSec}s debounce)`);
  }
  console.log('');

  await runSyncCycle(plan, cwd, { dryRun: options.dryRun, slug: options.slug });
  if (!options.watch) return;

  let lastSnapshot = collectBrainSnapshot(cwd);
  let running = false;
  let quietTicks = 0;
  let pendingLocal = false;

  console.log('');
  console.log('Company brain sync is watching atris/. Press Ctrl+C to stop.');

  const tickMs = 1000;
  setInterval(async () => {
    if (running) return;
    const current = collectBrainSnapshot(cwd);
    if (snapshotsDiffer(lastSnapshot, current)) {
      pendingLocal = true;
      quietTicks = 0;
      lastSnapshot = current;
      return;
    }

    if (pendingLocal) {
      quietTicks += 1;
      if (quietTicks < options.debounceSec) return;
    }

    const shouldPeriodicSync = !pendingLocal && quietTicks >= options.intervalSec;
    const shouldLocalSync = pendingLocal && quietTicks >= options.debounceSec;
    quietTicks += 1;
    if (!shouldLocalSync && !shouldPeriodicSync) return;

    running = true;
    try {
      console.log('');
      console.log(shouldLocalSync ? 'Local brain changed. Syncing...' : 'Checking cloud brain...');
      await runSyncCycle(plan, cwd, { dryRun: options.dryRun, slug: options.slug });
      lastSnapshot = collectBrainSnapshot(cwd);
      pendingLocal = false;
      quietTicks = 0;
    } catch (err) {
      console.error(`\nSync paused: ${err.message || err}`);
      console.error('Resolve the issue, then restart `atris sync --watch`.');
      process.exit(1);
    } finally {
      running = false;
    }
  }, tickMs);
}

module.exports = {
  businessSync,
  buildBusinessSyncPlan,
  canPreviewPush,
  collectBrainSnapshot,
  parseBusinessSyncArgs,
  readBusinessSlug,
  resolveBusinessSyncOptions,
  shouldIgnoreWatchPath,
  snapshotsDiffer,
};
