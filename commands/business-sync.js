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
  const review = args.includes('--review') || positional[0] === 'review';
  const resolveIdx = positional.indexOf('resolve');
  const resolveFlag = parseFlagValue(args, '--resolve', null);
  const resolve = resolveFlag || (resolveIdx !== -1 ? positional[resolveIdx + 1] : null);
  const commandWords = new Set(['status', 'doctor', 'review', 'resolve', 'local', 'cloud', 'both', 'merge']);
  const slug = positional.find((arg) => !commandWords.has(arg)) || null;
  const dryRun = args.includes('--dry-run');
  const timeout = parseFlagValue(args, '--timeout', '120');
  const allowDelete = args.includes('--delete');
  const watch = args.includes('--watch');
  const intervalSec = Number.parseInt(parseFlagValue(args, '--interval', '60'), 10);
  const debounceSec = Number.parseInt(parseFlagValue(args, '--debounce', '5'), 10);
  const help = args.includes('--help') || args.includes('-h') || positional[0] === 'help';

  return { slug, dryRun, timeout, allowDelete, watch, intervalSec, debounceSec, status, review, resolve, help };
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

function collectWorkspaceSnapshot(root) {
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

  walk(root);
  return snapshot;
}

const collectBrainSnapshot = collectWorkspaceSnapshot;

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

function countWorkspaceFiles(cwd) {
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
      const rel = path.relative(cwd, full);
      if (shouldIgnoreWatchPath(rel)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) count += 1;
    }
  }

  walk(cwd);
  return count;
}

function countFilesUnder(dir) {
  let count = 0;

  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) count += 1;
    }
  }

  walk(dir);
  return count;
}

function collectWorkspaceWarnings(cwd, slug) {
  const warnings = [];
  if (slug) {
    const nested = path.join(cwd, slug);
    if (fs.existsSync(nested)) {
      try {
        if (fs.statSync(nested).isDirectory()) {
          warnings.push(`nested workspace folder: ${slug}/ (${countFilesUnder(nested)} files)`);
        }
      } catch {
        // Ignore races while editors or sync tools move folders.
      }
    }
  }

  const syncArtifacts = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(cwd, full);
      if (shouldIgnoreWatchPath(rel)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && ['.remote', '.local', '.base', '.cloud'].some((suffix) => entry.name.endsWith(suffix))) {
        syncArtifacts.push(rel.replace(/\\/g, '/'));
      }
    }
  }
  walk(cwd);
  if (syncArtifacts.length > 0) {
    warnings.push(`sync review artifacts outside .atris/: ${syncArtifacts.length}`);
  }
  return warnings;
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
  const workspaceFileCount = countWorkspaceFiles(cwd);
  const manifestRootMatches = !manifest || !manifest.workspace_root || sameRealPath(manifest.workspace_root, cwd);
  const warnings = collectWorkspaceWarnings(cwd, slug);

  return {
    slug,
    cwd,
    brainDir,
    brainExists: fs.existsSync(brainDir),
    brainFileCount: workspaceFileCount,
    workspaceFileCount,
    conflictCount: conflictSummaries.length,
    latestConflict: conflictSummaries[conflictSummaries.length - 1] || null,
    lastSync: manifest && manifest.last_sync ? manifest.last_sync : null,
    manifestRoot: manifest && manifest.workspace_root ? manifest.workspace_root : null,
    manifestRootMatches,
    heartbeat,
    warnings,
  };
}

function renderLocalSyncStatus(status) {
  const lines = [];
  const fileLabel = status.workspaceFileCount === 1 ? 'file' : 'files';
  lines.push('Business workspace sync status');
  lines.push(`  business: ${status.slug || 'not detected'}`);
  lines.push(`  folder: ${status.cwd}`);
  lines.push(`  workspace: ${status.workspaceFileCount} ${fileLabel} (${status.brainExists ? 'atris/ present' : 'missing atris/'})`);
  lines.push('  loop: Pull -> Review -> Publish');
  lines.push('  quest gate: exact files beat broad pushes');
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
  if (status.warnings && status.warnings.length > 0) {
    lines.push(`  warnings: ${status.warnings.length}`);
    status.warnings.slice(0, 3).forEach((warning) => lines.push(`    - ${warning}`));
  } else {
    lines.push('  warnings: none');
  }
  if (status.heartbeat && status.heartbeat.updated_at) {
    lines.push(`  watcher: last heartbeat ${status.heartbeat.updated_at} (${status.heartbeat.state || 'unknown'})`);
  } else {
    lines.push('  watcher: no heartbeat yet');
  }
  lines.push('');
  lines.push('Next: run `atris sync --dry-run` to preview the quest, or `atris sync --review` if conflicts exist.');
  return `${lines.join('\n')}\n`;
}

function renderBusinessSyncHelp() {
  return [
    'Usage: atris sync [business] [--dry-run] [--watch] [--status] [--review] [--resolve local|cloud|both|merge] [--timeout 120]',
    '',
    'Safe loop:',
    '  Pull -> Review -> Publish',
    '',
    'Commands:',
    '  atris sync --status       Show local sync health',
    '  atris sync --dry-run      Preview pull and publish plans without writing cloud',
    '  atris sync --review       Read the latest conflict packet',
    '  atris sync --resolve cloud|local|merge',
    '  atris sync --watch        Keep the workspace live with the same safety gates',
    '',
    'Publish safety:',
    '  Large unscoped pushes, nested workspace folders, and *.remote artifacts are blocked.',
    '  Use exact --only paths for repairs, or explicit push override flags after review.',
    '',
  ].join('\n');
}

function renderLatestConflictReview(cwd = process.cwd()) {
  const summaries = listConflictSummaries(cwd);
  if (summaries.length === 0) {
    return 'No sync conflicts need review.\n';
  }

  const latest = summaries[summaries.length - 1];
  const fullPath = path.join(cwd, latest);
  const content = fs.readFileSync(fullPath, 'utf8');
  return [
    `Latest sync conflict review: ${latest}`,
    '',
    content.trimEnd(),
    '',
    'Resolve the local file, then run `atris sync --dry-run` before publishing.',
    '',
  ].join('\n');
}

function latestConflictDir(cwd = process.cwd()) {
  const summaries = listConflictSummaries(cwd);
  if (summaries.length === 0) return null;
  return path.dirname(path.join(cwd, summaries[summaries.length - 1]));
}

function collectConflictResolutionEntries(cwd = process.cwd()) {
  const dir = latestConflictDir(cwd);
  if (!dir) return [];
  const entries = [];

  function walk(current) {
    let items;
    try {
      items = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) {
        walk(full);
      } else if (item.isFile() && item.name.endsWith('.local')) {
        const localPath = full;
        const remotePath = full.replace(/\.local$/, '.remote');
        const targetRel = path.relative(dir, full).replace(/\\/g, '/').replace(/\.local$/, '');
        if (!targetRel.startsWith('atris/')) continue;
        entries.push({
          targetRel,
          basePath: full.replace(/\.local$/, '.base'),
          localPath,
          remotePath,
        });
      }
    }
  }

  walk(dir);
  return entries.sort((a, b) => a.targetRel.localeCompare(b.targetRel));
}

function assertWorkspaceTarget(cwd, targetRel) {
  const targetPath = path.resolve(cwd, targetRel);
  const root = path.resolve(cwd);
  if (!targetPath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to resolve outside workspace: ${targetRel}`);
  }
  return targetPath;
}

function changedRange(baseLines, changedLines) {
  let start = 0;
  while (start < baseLines.length && start < changedLines.length && baseLines[start] === changedLines[start]) {
    start += 1;
  }

  let baseEnd = baseLines.length;
  let changedEnd = changedLines.length;
  while (
    baseEnd > start
    && changedEnd > start
    && baseLines[baseEnd - 1] === changedLines[changedEnd - 1]
  ) {
    baseEnd -= 1;
    changedEnd -= 1;
  }

  return {
    start,
    end: baseEnd,
    replacement: changedLines.slice(start, changedEnd),
  };
}

function safeLineMerge(baseContent, localContent, remoteContent) {
  if (localContent === remoteContent) return { ok: true, content: localContent };
  if (localContent === baseContent) return { ok: true, content: remoteContent };
  if (remoteContent === baseContent) return { ok: true, content: localContent };

  const baseLines = baseContent.split('\n');
  const localRange = changedRange(baseLines, localContent.split('\n'));
  const remoteRange = changedRange(baseLines, remoteContent.split('\n'));
  const sameRange = localRange.start === remoteRange.start && localRange.end === remoteRange.end;
  const sameReplacement = localRange.replacement.join('\n') === remoteRange.replacement.join('\n');
  if (sameRange && sameReplacement) return { ok: true, content: localContent };

  const overlaps = localRange.start < remoteRange.end && remoteRange.start < localRange.end;
  const sameInsertionPoint = localRange.start === localRange.end
    && remoteRange.start === remoteRange.end
    && localRange.start === remoteRange.start;
  if (overlaps || sameInsertionPoint) {
    return { ok: false, reason: 'local and cloud edits overlap' };
  }

  const merged = baseLines.slice();
  for (const range of [localRange, remoteRange].sort((a, b) => b.start - a.start)) {
    merged.splice(range.start, range.end - range.start, ...range.replacement);
  }
  return { ok: true, content: merged.join('\n') };
}

function markdownSectionRanges(content) {
  const lines = content.split('\n');
  const ranges = [];
  const headingPattern = /^(#{1,6})\s+(.+?)\s*$/;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(headingPattern);
    if (!match) continue;
    const level = match[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j].match(headingPattern);
      if (next && next[1].length <= level) {
        end = j;
        break;
      }
    }
    ranges.push({
      key: lines[i].trim().toLowerCase(),
      level,
      start: i,
      end,
    });
  }
  return ranges;
}

function changedMarkdownSections(baseContent, changedContent) {
  const baseLines = baseContent.split('\n');
  const changedLines = changedContent.split('\n');
  const range = changedRange(baseLines, changedLines);
  if (range.start === range.end && range.replacement.length === 0) return new Set();
  const touchedStart = range.start;
  const touchedEnd = Math.max(range.end, range.start + 1);
  const touched = markdownSectionRanges(baseContent)
    .filter((section) => section.start < touchedEnd && touchedStart < section.end);
  const deepestLevel = touched.reduce((max, section) => Math.max(max, section.level), 0);
  const sections = touched
    .filter((section) => section.level === deepestLevel)
    .map((section) => section.key);
  return new Set(sections.length ? sections : ['__preamble__']);
}

function replaceMarkdownSection(content, sectionKey, replacementContent) {
  const lines = content.split('\n');
  const ranges = markdownSectionRanges(content);
  const range = ranges.find((section) => section.key === sectionKey);
  if (!range) return null;
  const replacementRange = markdownSectionRanges(replacementContent)
    .find((section) => section.key === sectionKey);
  if (!replacementRange) return null;
  const replacementLines = replacementContent.split('\n').slice(replacementRange.start, replacementRange.end);
  const merged = lines.slice();
  merged.splice(range.start, range.end - range.start, ...replacementLines);
  return merged.join('\n');
}

function safeMarkdownMerge(baseContent, localContent, remoteContent) {
  const lineMerge = safeLineMerge(baseContent, localContent, remoteContent);
  if (lineMerge.ok) return { ...lineMerge, mode: 'line' };

  const localSections = changedMarkdownSections(baseContent, localContent);
  const remoteSections = changedMarkdownSections(baseContent, remoteContent);
  if (localSections.has('__preamble__') || remoteSections.has('__preamble__')) {
    return { ok: false, reason: 'local and cloud edits overlap outside markdown sections' };
  }
  for (const section of localSections) {
    if (remoteSections.has(section)) {
      return { ok: false, reason: `local and cloud both edited ${section}` };
    }
  }

  let merged = baseContent;
  for (const section of localSections) {
    const next = replaceMarkdownSection(merged, section, localContent);
    if (next === null) return { ok: false, reason: `could not apply local section ${section}` };
    merged = next;
  }
  for (const section of remoteSections) {
    const next = replaceMarkdownSection(merged, section, remoteContent);
    if (next === null) return { ok: false, reason: `could not apply cloud section ${section}` };
    merged = next;
  }
  return { ok: true, content: merged, mode: 'markdown' };
}

function resolveLatestConflict(cwd = process.cwd(), strategy = 'local') {
  if (!['local', 'cloud', 'both', 'merge'].includes(strategy)) {
    throw new Error('Use `atris sync --resolve local`, `atris sync --resolve cloud`, `atris sync --resolve both`, or `atris sync --resolve merge`.');
  }

  const entries = collectConflictResolutionEntries(cwd);
  if (entries.length === 0) {
    return {
      resolved: [],
      message: 'No sync conflicts need resolution.\n',
    };
  }

  const resolved = [];
  const unresolved = [];
  for (const entry of entries) {
    const targetPath = assertWorkspaceTarget(cwd, entry.targetRel);
    if (strategy === 'both') {
      if (fs.existsSync(entry.localPath)) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(entry.localPath, targetPath);
      }
      if (fs.existsSync(entry.remotePath)) {
        const remoteCopyRel = `${entry.targetRel}.cloud`;
        const remoteCopyPath = assertWorkspaceTarget(cwd, remoteCopyRel);
        fs.mkdirSync(path.dirname(remoteCopyPath), { recursive: true });
        fs.copyFileSync(entry.remotePath, remoteCopyPath);
      }
      resolved.push(entry.targetRel);
      continue;
    }

    if (strategy === 'merge') {
      if (!fs.existsSync(entry.basePath) || !fs.existsSync(entry.localPath) || !fs.existsSync(entry.remotePath)) {
        unresolved.push(`${entry.targetRel} (missing base/local/cloud artifact)`);
        continue;
      }
      const merged = safeMarkdownMerge(
        fs.readFileSync(entry.basePath, 'utf8'),
        fs.readFileSync(entry.localPath, 'utf8'),
        fs.readFileSync(entry.remotePath, 'utf8')
      );
      if (!merged.ok) {
        unresolved.push(`${entry.targetRel} (${merged.reason})`);
        continue;
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, merged.content, 'utf8');
      resolved.push(entry.targetRel);
      continue;
    }

    const sourcePath = strategy === 'local' ? entry.localPath : entry.remotePath;
    if (!fs.existsSync(sourcePath)) continue;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    resolved.push(entry.targetRel);
  }

  return {
    resolved,
    unresolved,
    message: [
      `Resolved ${resolved.length} conflict${resolved.length === 1 ? '' : 's'} using ${strategy === 'both' ? 'both versions' : `${strategy === 'merge' ? 'safe merge' : `${strategy === 'local' ? 'local' : 'cloud'} version`}`}.`,
      ...resolved.map((rel) => `  - ${rel}`),
      ...(unresolved.length ? ['', 'Still needs review:', ...unresolved.map((rel) => `  - ${rel}`)] : []),
      '',
      'Next: run `atris sync --dry-run` before publishing.',
      '',
    ].join('\n'),
  };
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

  if (options.help) {
    process.stdout.write(renderBusinessSyncHelp());
    return;
  }

  if (options.status) {
    process.stdout.write(renderLocalSyncStatus(collectLocalSyncStatus(cwd, options)));
    return;
  }

  if (options.review) {
    process.stdout.write(renderLatestConflictReview(cwd));
    return;
  }

  if (options.resolve) {
    process.stdout.write(resolveLatestConflict(cwd, options.resolve).message);
    return;
  }

  const plan = buildBusinessSyncPlan(options);

  if (!plan) {
    console.error(renderBusinessSyncHelp().trimEnd());
    console.error('Run inside a business workspace or pass a business slug.');
    process.exit(1);
  }

  console.log('');
  console.log(`Syncing ${options.slug} business workspace...`);
  console.log('  scope: full workspace');
  console.log('  loop: Pull -> Review -> Publish');
  console.log('  quest gate: exact files beat broad pushes');
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

  let lastSnapshot = collectWorkspaceSnapshot(cwd);
  let running = false;
  let quietTicks = 0;
  let pendingLocal = false;

  console.log('');
  console.log('Business workspace sync is watching this folder. Press Ctrl+C to stop.');

  const tickMs = 1000;
  setInterval(async () => {
    if (running) return;
    const current = collectWorkspaceSnapshot(cwd);
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
      console.log(shouldLocalSync ? 'Local workspace changed. Syncing...' : 'Checking cloud workspace...');
      await runSyncCycle(plan, cwd, {
        dryRun: options.dryRun,
        slug: options.slug,
        writeStatus: !options.dryRun,
        watch: true,
      });
      lastSnapshot = collectWorkspaceSnapshot(cwd);
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
  collectWorkspaceSnapshot,
  collectWorkspaceWarnings,
  collectLocalSyncStatus,
  collectConflictResolutionEntries,
  describeWatchFailure,
  parseBusinessSyncArgs,
  readBusinessSlug,
  renderLatestConflictReview,
  renderLocalSyncStatus,
  renderBusinessSyncHelp,
  resolveLatestConflict,
  resolveBusinessSyncOptions,
  safeLineMerge,
  safeMarkdownMerge,
  shouldIgnoreWatchPath,
  snapshotsDiffer,
  writeSyncStatus,
};
