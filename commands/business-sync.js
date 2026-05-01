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
  const positional = args.filter((arg) => arg && !arg.startsWith('-'));
  const status = args.includes('--status') || positional[0] === 'status' || positional[0] === 'doctor';
  const slug = positional.find((arg) => arg !== 'status' && arg !== 'doctor') || null;
  const dryRun = args.includes('--dry-run');
  const timeout = parseFlagValue(args, '--timeout', '120');
  const allowDelete = args.includes('--delete');
  const watch = args.includes('--watch');
  const intervalSec = Number.parseInt(parseFlagValue(args, '--interval', '60'), 10);
  const debounceSec = Number.parseInt(parseFlagValue(args, '--debounce', '5'), 10);

  return { slug, dryRun, timeout, allowDelete, watch, intervalSec, debounceSec, status };
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

function syncStatusPath(cwd) {
  return path.join(cwd, '.atris', 'sync', 'status.json');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeSyncStatus(cwd, payload = {}) {
  const statusPath = syncStatusPath(cwd);
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify({
    schema: 'atris.company_brain_sync.status.v1',
    updated_at: new Date().toISOString(),
    ...payload,
  }, null, 2) + '\n', 'utf8');
}

function countBrainFiles(cwd) {
  const brainDir = path.join(cwd, 'atris');
  let count = 0;

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
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) count += 1;
    }
  }

  walk(brainDir);
  return count;
}

function listConflictSummaries(cwd) {
  const conflictsDir = path.join(cwd, '.atris', 'sync', 'conflicts');
  const summaries = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name === 'summary.md') {
        summaries.push(path.relative(cwd, full).replace(/\\/g, '/'));
      }
    }
  }

  walk(conflictsDir);
  return summaries.sort();
}

function collectLocalSyncStatus(cwd = process.cwd(), options = {}) {
  const slug = options.slug || readBusinessSlug(cwd);
  const manifest = slug ? loadManifest(slug) : null;
  const heartbeat = readJsonFile(syncStatusPath(cwd));
  const conflictSummaries = listConflictSummaries(cwd);
  const brainDir = path.join(cwd, 'atris');
  const manifestRootMatches = !manifest || !manifest.workspace_root || sameRealPath(manifest.workspace_root, cwd);

  return {
    slug,
    cwd,
    brainDir,
    brainExists: fs.existsSync(brainDir),
    brainFileCount: countBrainFiles(cwd),
    conflictCount: conflictSummaries.length,
    latestConflict: conflictSummaries[conflictSummaries.length - 1] || null,
    lastSync: manifest && manifest.last_sync ? manifest.last_sync : null,
    manifestRoot: manifest && manifest.workspace_root ? manifest.workspace_root : null,
    manifestRootMatches,
    heartbeat,
  };
}

function renderLocalSyncStatus(status) {
  const lines = [];
  const fileLabel = status.brainFileCount === 1 ? 'file' : 'files';
  lines.push('Company brain status');
  lines.push(`  business: ${status.slug || 'not detected'}`);
  lines.push(`  folder: ${status.cwd}`);
  lines.push(`  brain: ${status.brainExists ? `atris/ (${status.brainFileCount} ${fileLabel})` : 'missing atris/'}`);
  lines.push(`  last cloud sync: ${status.lastSync || 'never on this machine'}`);
  if (status.manifestRoot && !status.manifestRootMatches) {
    lines.push(`  manifest: from another folder (${status.manifestRoot})`);
  } else {
    lines.push(`  manifest: ${status.manifestRoot ? 'matches this folder' : 'not created yet'}`);
  }
  if (status.conflictCount > 0) {
    lines.push(`  conflicts: ${status.conflictCount} review packet${status.conflictCount === 1 ? '' : 's'}`);
    lines.push(`  latest: ${status.latestConflict}`);
  } else {
    lines.push('  conflicts: none');
  }
  if (status.heartbeat && status.heartbeat.updated_at) {
    lines.push(`  watcher: last heartbeat ${status.heartbeat.updated_at} (${status.heartbeat.state || 'unknown'})`);
  } else {
    lines.push('  watcher: no heartbeat yet');
  }
  lines.push('');
  lines.push('Next: run `atris sync --dry-run` to preview, or `atris sync --watch` to keep this brain live.');
  return `${lines.join('\n')}\n`;
}

function describeWatchFailure(err) {
  const isConflict = err && err.status === 2;
  return {
    state: isConflict ? 'conflict' : 'retrying',
    headline: `Sync ${isConflict ? 'paused for review' : 'will retry'}: ${err && err.message ? err.message : err}`,
    detail: isConflict
      ? 'Resolve the review packet, then the watcher will pick up the next clean cycle.'
      : 'The watcher is still running and will check again.',
  };
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
      else {
        const err = new Error(`${commandLine(args)} exited ${status}`);
        err.status = status;
        err.args = args;
        reject(err);
      }
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
  if (options.writeStatus) {
    writeSyncStatus(cwd, {
      slug: options.slug,
      state: 'current',
      mode: options.watch ? 'watch' : 'sync',
      last_error: null,
    });
  }
}

async function businessSync(args = process.argv.slice(3), cwd = process.cwd()) {
  const options = resolveBusinessSyncOptions(args, cwd);
  const plan = buildBusinessSyncPlan(options);

  if (!plan) {
    console.error('Usage: atris sync [business] [--dry-run] [--watch] [--status] [--timeout 120]');
    console.error('Run inside a business workspace or pass a business slug.');
    process.exit(1);
  }

  if (options.status) {
    process.stdout.write(renderLocalSyncStatus(collectLocalSyncStatus(cwd, options)));
    return;
  }

  console.log('');
  console.log(`Syncing ${options.slug} knowledge wiki...`);
  console.log('  scope: atris/');
  if (options.watch) {
    console.log(`  watch: on (${options.intervalSec}s interval, ${options.debounceSec}s debounce)`);
  }
  console.log('');

  await runSyncCycle(plan, cwd, {
    dryRun: options.dryRun,
    slug: options.slug,
    writeStatus: !options.dryRun,
    watch: options.watch,
  });
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
      await runSyncCycle(plan, cwd, {
        dryRun: options.dryRun,
        slug: options.slug,
        writeStatus: !options.dryRun,
        watch: true,
      });
      lastSnapshot = collectBrainSnapshot(cwd);
      pendingLocal = false;
      quietTicks = 0;
    } catch (err) {
      const failure = describeWatchFailure(err);
      console.error(`\n${failure.headline}`);
      console.error(failure.detail);
      if (!options.dryRun) {
        writeSyncStatus(cwd, {
          slug: options.slug,
          state: failure.state,
          mode: 'watch',
          last_error: err.message || String(err),
        });
      }
      pendingLocal = false;
      quietTicks = 0;
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
  collectLocalSyncStatus,
  describeWatchFailure,
  parseBusinessSyncArgs,
  readBusinessSlug,
  renderLocalSyncStatus,
  resolveBusinessSyncOptions,
  shouldIgnoreWatchPath,
  snapshotsDiffer,
  writeSyncStatus,
};
