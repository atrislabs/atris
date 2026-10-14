'use strict';

// Engine work folders are never removed while a run is inside them, and every
// removal leaves one line saying who removed it and why. Git mid-operation in
// the folder (lock held, rebase or merge paused) holds removal the same way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { reap, removalsTodayLine } = require('../commands/land');
const { cleanupWorktrees } = require('../commands/worktree');
const { disposeReviewSandbox } = require('../lib/fleet');
const { regressionCheck } = require('../commands/autopilot');
const { dropScratch } = require('../lib/land-green');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

// A repo with one landed branch checked out in an aged sibling folder.
function landedWorktree() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-removal-guard-')));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'master']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'init']);
  git(repo, ['branch', 'engine-run']);
  const wt = path.join(base, 'engine-wt');
  git(repo, ['worktree', 'add', '-q', wt, 'engine-run']);
  const aged = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(wt, aged, aged);
  return { base, repo, wt };
}

function removalLines(repo) {
  const file = path.join(repo, '.atris', 'state', 'worktree_removals.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('reap keeps a folder a run is working in, even with --force', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    const receipt = reap(repo, { remote: false, force: true, activeCwds: [path.join(wt, 'sub')] });
    assert.ok(fs.existsSync(wt));
    assert.deepEqual(receipt.removedWorktrees, []);
    assert.ok(receipt.keptWorktrees.some((line) => line.includes('active_process')), JSON.stringify(receipt));
    assert.ok(!receipt.deletedBranches.includes('engine-run'));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('reap sees a real live process in the folder without being told', async () => {
  const { base, repo, wt } = landedWorktree();
  const child = spawn('sleep', ['30'], { cwd: wt, stdio: 'ignore' });
  try {
    await new Promise((resolve) => child.once('spawn', resolve));
    const receipt = reap(repo, { remote: false });
    assert.ok(fs.existsSync(wt), JSON.stringify(receipt));
    assert.ok(receipt.keptWorktrees.some((line) => line.includes('active_process')), JSON.stringify(receipt));
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('reap names who removed a folder and why', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    const receipt = reap(repo, { remote: false, activeCwds: [], by: 'atris autoland' });
    assert.deepEqual(receipt.removedWorktrees, [wt]);
    const [line] = removalLines(repo);
    assert.equal(line.path, wt);
    assert.equal(line.branch, 'engine-run');
    assert.equal(line.by, 'atris autoland');
    assert.equal(line.reason, 'branch_landed');
    assert.equal(line.pid, process.pid);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// The log is read back: one line counts today's removals by who did them,
// leaving out yesterday and skipping a torn last write.
test('reap summary counts folders removed today and by whom', () => {
  const { base, repo } = landedWorktree();
  try {
    const now = new Date(2026, 9, 14, 15, 0).getTime();
    const at = (day, hour) => new Date(2026, 9, day, hour).toISOString();
    const file = path.join(repo, '.atris', 'state', 'worktree_removals.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      { at: at(13, 23), by: 'atris worktree cleanup' },
      { at: at(14, 1), by: 'atris land --reap' },
      { at: at(14, 9), by: 'atris member tidy' },
      { at: at(14, 10), by: 'atris member tidy' },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n{"at":"2026-10-14T1');
    assert.equal(removalsTodayLine(repo, now), '  folders removed today: 3 (atris member tidy 2, atris land --reap 1)');
    fs.rmSync(file);
    assert.equal(removalsTodayLine(repo, now), '');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('worktree cleanup names who removed a folder and why', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    const result = cleanupWorktrees({ root: repo, base: 'HEAD', apply: true, activeCwds: [] });
    assert.equal(result.removed.length, 1);
    assert.equal(fs.existsSync(wt), false);
    const [line] = removalLines(repo);
    assert.equal(line.path, wt);
    assert.equal(line.by, 'atris worktree cleanup');
    assert.equal(line.reason, 'merged_into_base');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function worktreeGitDir(wt) {
  return git(wt, ['rev-parse', '--path-format=absolute', '--git-dir']);
}

test('reap keeps a folder while git holds its lock, even with --force', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    const lock = path.join(worktreeGitDir(wt), 'index.lock');
    fs.writeFileSync(lock, '');
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(lock, stale, stale);
    const receipt = reap(repo, { remote: false, force: true, activeCwds: [] });
    assert.ok(fs.existsSync(wt), JSON.stringify(receipt));
    assert.ok(receipt.keptWorktrees.includes(`${wt} (git_lock: ${lock}, 3 h old)`), JSON.stringify(receipt));
    assert.ok(!receipt.deletedBranches.includes('engine-run'));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('reap says which git work is paused in a folder it keeps', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    fs.writeFileSync(path.join(worktreeGitDir(wt), 'MERGE_HEAD'), `${git(repo, ['rev-parse', 'HEAD'])}\n`);
    const receipt = reap(repo, { remote: false, force: true, activeCwds: [] });
    assert.ok(fs.existsSync(wt));
    assert.ok(receipt.keptWorktrees.includes(`${wt} (git_merge_in_progress: a merge is paused)`), JSON.stringify(receipt.keptWorktrees));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('worktree cleanup names the lock holding a folder and how old it is', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    const lock = path.join(worktreeGitDir(wt), 'index.lock');
    fs.writeFileSync(lock, '');
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(lock, stale, stale);
    const result = cleanupWorktrees({ root: repo, base: 'HEAD', apply: true, activeCwds: [] });
    const held = result.kept.find((item) => item.path === wt);
    assert.equal(held.reason, 'git_lock', JSON.stringify(result.kept));
    assert.equal(held.lock, lock);
    assert.ok(held.lock_age_ms >= 3 * 60 * 60 * 1000 - 1000, String(held.lock_age_ms));
    assert.ok(fs.existsSync(wt));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('worktree cleanup keeps a clean folder paused mid-rebase', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    fs.mkdirSync(path.join(worktreeGitDir(wt), 'rebase-merge'));
    const result = cleanupWorktrees({ root: repo, base: 'HEAD', apply: true, activeCwds: [] });
    assert.deepEqual(result.removed, []);
    assert.ok(fs.existsSync(wt));
    assert.ok(result.kept.some((item) => item.path === wt && item.reason === 'git_rebase_in_progress'), JSON.stringify(result.kept));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Shaped like the fleet review sandbox. Its own git dir points at a throwaway
// path so disposal never deletes the fixture repo's .git.
function reviewSandbox() {
  const { base, repo, wt } = landedWorktree();
  const quarantine = path.join(base, 'quarantine.git');
  fs.mkdirSync(quarantine);
  return { base, repo, wt, boundary: { trustedRoot: repo, sandboxRoot: path.join(base, 'sandbox'), worktreePath: wt, gitDir: path.join(base, 'sandbox.git'), quarantine } };
}

test('fleet review cleanup keeps a sandbox while git holds its lock', () => {
  const { base, repo, wt, boundary } = reviewSandbox();
  try {
    const lock = path.join(worktreeGitDir(wt), 'index.lock');
    fs.writeFileSync(lock, '');
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(lock, stale, stale);
    const { lock_age_ms: age, ...result } = disposeReviewSandbox(boundary);
    assert.deepEqual(result, { removed: false, reason: 'git_lock', lock });
    assert.ok(age >= 3 * 60 * 60 * 1000 - 1000, String(age));
    assert.ok(fs.existsSync(wt));
    assert.ok(fs.existsSync(boundary.quarantine));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('fleet review cleanup says which git work is paused in a copy it keeps', () => {
  const { base, repo, wt, boundary } = reviewSandbox();
  try {
    fs.writeFileSync(path.join(worktreeGitDir(wt), 'MERGE_HEAD'), `${git(repo, ['rev-parse', 'HEAD'])}\n`);
    const result = disposeReviewSandbox(boundary);
    assert.deepEqual(result, { removed: false, reason: 'git_merge_in_progress', paused: 'a merge is paused' });
    assert.ok(fs.existsSync(wt));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('fleet review cleanup keeps a sandbox while git holds its quarantine store', () => {
  const { base, repo, wt, boundary } = reviewSandbox();
  try {
    git(base, ['init', '-q', '--bare', boundary.quarantine]);
    const lock = path.join(boundary.quarantine, 'HEAD.lock');
    fs.writeFileSync(lock, '');
    const { lock_age_ms: age, ...result } = disposeReviewSandbox(boundary);
    assert.deepEqual(result, { removed: false, reason: 'git_lock', lock });
    assert.equal(typeof age, 'number');
    assert.ok(fs.existsSync(wt));
    assert.ok(fs.existsSync(path.join(boundary.quarantine, 'HEAD')));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('fleet review cleanup keeps a sandbox while git updates a branch in either store', () => {
  for (const store of ['gitDir', 'quarantine']) {
    for (const marker of ['packed-refs.lock', 'refs/heads/review.lock']) {
      const { base, repo, wt, boundary } = reviewSandbox();
      try {
        git(base, ['init', '-q', '--bare', boundary.gitDir]);
        git(base, ['init', '-q', '--bare', boundary.quarantine]);
        const lock = path.join(boundary[store], marker);
        fs.writeFileSync(lock, '');
        const { lock_age_ms: age, ...result } = disposeReviewSandbox(boundary);
        assert.deepEqual(result, { removed: false, reason: 'git_lock', lock }, `${store} ${marker}`);
        assert.equal(typeof age, 'number', `${store} ${marker}`);
        assert.ok([wt, boundary.gitDir, boundary.quarantine].every((folder) => fs.existsSync(folder)), `${store} ${marker}`);
        assert.deepEqual(removalLines(repo), []);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    }
  }
});

test('fleet review cleanup names who removed a sandbox and why', () => {
  const { base, repo, wt, boundary } = reviewSandbox();
  try {
    const result = disposeReviewSandbox(boundary);
    assert.deepEqual(result, { removed: true });
    assert.equal(fs.existsSync(wt), false);
    const [line] = removalLines(repo);
    assert.equal(line.path, wt);
    assert.equal(line.by, 'atris fleet review');
    assert.equal(line.reason, 'review_sandbox_imported');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// One recorded tick whose verify command runs inside the regression folder.
function regressionRepo(verifyCmd) {
  const { base, repo } = landedWorktree();
  const hash = git(repo, ['rev-parse', 'HEAD']);
  fs.mkdirSync(path.join(repo, 'atris'));
  fs.writeFileSync(path.join(repo, 'atris', 'tick-registry.json'), JSON.stringify([{ hash, verifyCmd, slug: 'fixture' }]));
  return { base, repo, folder: path.join(repo, `.regression-worktree-${hash.slice(0, 8)}`) };
}

test('autopilot regression check keeps its folder while git holds its lock', () => {
  const { base, repo, folder } = regressionRepo('touch "$(git rev-parse --git-dir)/index.lock"');
  try {
    const [row] = regressionCheck(repo, { activeCwds: [] });
    assert.equal(row.kept, 'git_lock', JSON.stringify(row));
    assert.ok(fs.existsSync(folder));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('autopilot regression check keeps its folder while a run is inside it', () => {
  const { base, repo, folder } = regressionRepo('true');
  try {
    const [row] = regressionCheck(repo, { activeCwds: [path.join(folder, 'sub')] });
    assert.equal(row.kept, 'active_process', JSON.stringify(row));
    assert.ok(fs.existsSync(folder));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// The verify step leaves a real child running in the folder, the way a
// timed-out verify can. No process list is passed in, so the real scan runs.
test('autopilot regression check sees a real leftover process without being told', () => {
  const { base, repo, folder } = regressionRepo('');
  const pidFile = path.join(base, 'leftover.pid');
  const registry = path.join(repo, 'atris', 'tick-registry.json');
  const [entry] = JSON.parse(fs.readFileSync(registry, 'utf8'));
  entry.verifyCmd = `nohup sleep 30 >/dev/null 2>&1 & echo $! > "${pidFile}"`;
  fs.writeFileSync(registry, JSON.stringify([entry]));
  try {
    const [row] = regressionCheck(repo);
    assert.equal(row.kept, 'active_process', JSON.stringify(row));
    assert.ok(fs.existsSync(folder));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    if (fs.existsSync(pidFile)) {
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {}
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('autopilot regression check names who removed its folder and why', () => {
  const { base, repo, folder } = regressionRepo('true');
  try {
    const [row] = regressionCheck(repo, { activeCwds: [] });
    assert.equal(row.pass, true);
    assert.equal(row.kept, undefined);
    assert.equal(fs.existsSync(folder), false);
    const [line] = removalLines(repo);
    assert.equal(line.path, folder);
    assert.equal(line.by, 'atris autopilot regression check');
    assert.equal(line.reason, 'regression_check_done');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

for (const dirty of [false, true]) {
  test(`autopilot regression check keeps an existing ${dirty ? 'dirty' : 'clean'} folder when creation fails`, () => {
    const { base, repo, folder } = regressionRepo('touch verify-ran');
    try {
      git(repo, ['worktree', 'add', '-q', '--detach', folder, 'HEAD']);
      const head = git(folder, ['rev-parse', 'HEAD']);
      if (dirty) fs.writeFileSync(path.join(folder, 'unfinished.txt'), 'keep this work\n');
      const [row] = regressionCheck(repo, { activeCwds: [] });
      assert.equal(row.skipped, true, JSON.stringify(row));
      assert.ok(fs.existsSync(folder), 'the folder existed before this invocation');
      assert.equal(git(folder, ['rev-parse', 'HEAD']), head);
      assert.ok(git(repo, ['worktree', 'list']).includes(folder));
      assert.equal(fs.existsSync(path.join(folder, 'verify-ran')), false);
      if (dirty) assert.equal(fs.readFileSync(path.join(folder, 'unfinished.txt'), 'utf8'), 'keep this work\n');
      assert.deepEqual(removalLines(repo), []);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
}

// Tripwire: a work folder removal anywhere in lib/ or commands/, by git or by a
// raw delete of a worktree path, must sit in a function whose git-activity
// check, written above the delete with an answer that can stop it, and removal
// log name the folder it deletes. A new file that removes folders is caught
// too. Exceptions need a reason; stale entries fail.
function sourceFiles(dir) {
  return fs.readdirSync(path.join(__dirname, '..', dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(relative);
    return relative.endsWith('.js') ? [relative] : [];
  });
}
// An exemption names a function and lists the folder each of its deletes
// removes today, so a new delete added to an exempt function fails, naming its
// line and folder, until someone reviews it.
const UNGUARDED_REMOVALS = {
  'commands/worktree.js:createAgentWorktree': { deletes: ['target'], why: 'drops a folder it just made before any engine entered; plain remove refuses dirt' },
  'lib/fleet.js:prepareReviewSandbox': { deletes: ['seedDir', 'worktreePath', 'gitDir', 'quarantine', 'sandboxRoot', 'seedDir'], why: 'wipes its own temp sandbox when setup fails, and its seed folder after; only that call touched them, so any lock is stale' },
  'commands/drill.js:landingShippedLocal': { deletes: ['ctx.landingWorktree'], why: 'removes a worktree inside the drill\'s own throwaway practice repo' },
  'lib/land-green.js:scratchCheckout': { deletes: ['dir'], why: 'drops its fresh temp folder only after git failed to make it a worktree' },
};
// Real work folder removals still waiting for the guard. Each one is a gap;
// guard it and delete its line here.
const NOT_YET_GUARDED = {
};
const WORKTREE_REMOVAL = /worktree['"]?\s*,\s*['"]remove['"]|git worktree remove|\brm(?:dir)?(?:Sync)?\(\s*[^,)]*(?:worktree|wtPath|\bwt\b|\bw\.path)|\brm\s+-[a-z]*r[^;&|\n]*(?:worktree|wtPath|\bwt\b)|['"]rm['"]\s*,\s*\[[^\]]*(?:worktree|wtPath|\bwt\b)/i;
// A recursive delete with a plain name (dir, target) still counts when its
// function lists, adds, removes, or walks worktrees, so renaming a variable can't hide one.
// Asking git for the worktree list directly counts as listing them.
// Callback and promise deletes (fs.rm, fs.promises.rm) count the same as rmSync,
// and so does a shell rm -r, typed out or passed to spawn as arguments.
// A path built by a call, like rmSync(path.join(root, x), { recursive }), is read through.
// The older rmdir with the recursive option counts as a delete too.
const RECURSIVE_DELETE = /\brm(?:dir)?(?:Sync)?\((?:[^()]|\([^()]*\))*recursive|\brm\s+-[a-zA-Z]*[rR]|['"]rm['"]\s*,\s*\[\s*['"]-[a-zA-Z]*[rR]/;
const HANDLES_WORKTREES = /listWorktrees\(|parseWorktrees\(|agent-worktrees|['"]worktree['"]\s*,\s*['"](?:add|list|remove)['"]|git worktree (?:add|list|remove)/;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

// A delete split across lines is read from its opening line to the line that
// closes the call, so moving arguments onto their own lines can't hide one.
function callText(lines, index) {
  let depth = 0;
  for (let end = index; end < lines.length && end < index + 12; end++) {
    for (const ch of lines[end]) depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    if (depth <= 0) return lines.slice(index, end + 1).join('\n');
  }
  return lines.slice(index, index + 12).join('\n');
}

function worktreeRemovalSites(file) {
  const lines = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\n');
  const starts = lines.flatMap((line, index) => {
    const match = line.match(/^(?:async\s+)?function\s+(\w+)/);
    return match ? [{ name: match[1], index }] : [];
  });
  const sites = [];
  lines.forEach((line, index) => {
    if (COMMENT_LINE.test(line)) return;
    const call = /\brm(?:dir)?(?:Sync)?\(|['"]rm['"]\s*,/.test(line) ? callText(lines, index) : line;
    const named = WORKTREE_REMOVAL.test(call);
    if (!named && !RECURSIVE_DELETE.test(call)) return;
    const owner = starts.filter((start) => start.index <= index).pop();
    const next = starts.find((start) => start.index > index);
    // Comments are dropped so a note naming the check never counts as the check.
    const code = (from, to) => lines.slice(from, to)
      .filter((text) => !COMMENT_LINE.test(text))
      .map((text) => text.replace(/\s\/\/.*$/, ''))
      .join('\n');
    const body = code(owner ? owner.index : 0, next ? next.index : lines.length);
    if (!named && !HANDLES_WORKTREES.test(body)) return;
    // The function's code above the delete, where its git check has to sit.
    const before = code(owner ? owner.index : 0, index);
    sites.push({ key: `${file}:${owner ? owner.name : '(top level)'}`, line: index + 1, call, body, before });
  });
  return sites;
}

// A cleanup that deletes a set of folders together checks every git store
// before the first delete and writes one log line for the set. Each listed
// check must be present, the log must name the work folder, and the deletes
// are listed by folder so a new delete in the set gets reviewed.
const GROUPED_REMOVALS = {
  'lib/fleet.js:disposeReviewSandbox': {
    deletes: ['boundary.worktreePath', 'boundary.worktreePath', 'boundary.gitDir', 'boundary.quarantine', 'boundary.sandboxRoot'],
    checks: ['worktreeGitActivity(boundary.worktreePath)', 'gitStoreActivity(boundary.gitDir)', 'gitStoreActivity(boundary.quarantine)'],
    logs: 'boundary.worktreePath',
    why: 'review sandbox: work folder, its git store, the quarantine store, and their parent go together',
  },
};

// The first argument of a call, read up to the comma or paren that closes it.
function firstArgument(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ('([{'.includes(ch)) depth++;
    else if (depth === 0 && (ch === ',' || ch === ')')) return text.slice(0, i).replace(/\s+/g, '');
    else if (')]}'.includes(ch)) depth--;
  }
  return '';
}

// The folder a delete removes, as written in the source. An empty answer
// means the scan could not read it, which counts as a gap, never a pass.
function removedTarget(call, body) {
  const typed = call.match(/(?:git worktree remove|\brm\s+-[a-zA-Z]*[rR])[^`\n]*?\$\{([^}]+)\}/);
  if (typed) return typed[1].replace(/\s+/g, '');
  const rm = call.match(/\brm(?:dir)?(?:Sync)?\(/);
  if (rm) return firstArgument(call.slice(rm.index + rm[0].length));
  const list = call.match(/(?:['"]worktree['"]\s*,\s*['"]remove['"]|['"]rm['"]\s*,\s*\[)([^\]]*)\]/);
  if (!list) return '';
  const unquoted = (part) => part && !/^['"`]/.test(part);
  // The folder is the last unquoted entry; options like '--force' may follow it.
  const last = list[1].split(',').map((part) => part.trim()).filter(unquoted).pop();
  if (last) return last.replace(/\s+/g, '');
  // Arguments pushed onto a named list after it is built, like removeArgs.push(wt.path).
  const named = call.match(/([\w$]+)\s*=\s*\[\s*['"]worktree['"]/);
  if (!named) return '';
  const pushed = [...body.matchAll(new RegExp(`\\b${named[1]}\\.push\\(([^()]*)\\)`, 'g'))]
    .map((match) => match[1].trim()).filter(unquoted);
  return pushed.length ? pushed.pop().replace(/\s+/g, '') : '';
}

// Names made by path.resolve or realpath of another name point at the same folder.
function sameFolder(body) {
  const from = new Map();
  for (const [, alias, original] of body.matchAll(/([\w$]+)\s*=\s*(?:path\.resolve|fs\.realpathSync(?:\.native)?)\(\s*([\w$.]+)\s*\)/g)) {
    from.set(alias, original);
  }
  return (name) => {
    const seen = new Set();
    while (from.has(name) && !seen.has(name)) { seen.add(name); name = from.get(name); }
    return name;
  };
}

function checkedCalls(body) {
  return [...body.matchAll(/worktreeGitActivity\(\s*([^()]*?)\s*\)/g)]
    .map((match) => ({ arg: match[1].replace(/\s+/g, ''), index: match.index }));
}

// Just past the bracket that closes the one at start, or -1 when the text ends
// first, which means the delete sits inside it.
function closing(text, start) {
  const open = text[start];
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return i + 1;
  }
  return -1;
}

// A check protects only when its answer can stop the delete: an if on the
// answer that returns, continues, breaks, or throws, or an if on the negated
// answer whose branch holds the delete. The answer is read in place or through
// the name it was stored under.
function answerStops(before, at) {
  const start = Math.max(before.lastIndexOf(';', at), before.lastIndexOf('{', at), before.lastIndexOf('}', at)) + 1;
  const stored = before.slice(start, at).match(/^\s*(?:(?:const|let|var)\s+)?([\w$]+)\s*=(?!=)/);
  for (const match of before.matchAll(/\bif\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const end = closing(before, open);
    if (end < 0) continue;
    const condition = before.slice(open, end);
    const inPlace = open < at && at < end;
    const byName = stored && match.index > at && new RegExp(`(?:^|[^\\w$.])${stored[1]}\\b`).test(condition);
    if (!inPlace && !byName) continue;
    const negated = inPlace
      ? /!\s*(?:[\w$]+\.)?$/.test(before.slice(open + 1, at))
      : new RegExp(`!\\s*${stored[1]}\\b`).test(condition);
    let from = end;
    while (/\s/.test(before[from] || '')) from++;
    const stop = before[from] === '{' ? closing(before, from) : before.indexOf(';', from) + 1;
    const holdsDelete = stop <= 0;
    const branch = before.slice(from, holdsDelete ? before.length : stop);
    if (!negated && !holdsDelete && /\b(?:return|continue|break|throw)\b/.test(branch)) return true;
    if (negated && holdsDelete) return true;
  }
  return false;
}

function loggedPaths(body) {
  return [...body.matchAll(/recordWorktreeRemoval\([^{]*\{[^}]*?\bpath:\s*([\w$.]+)/g)].map((match) => match[1]);
}

// Why a delete is not covered, in words a builder can act on, or '' when it
// is: the scan cannot tell which folder is deleted, no git check names it, the
// check only runs after the delete, its answer never stops the delete, the
// log names some other folder, or a group lost a check or its log.
function removalGap(site) {
  const group = GROUPED_REMOVALS[site.key];
  if (group) {
    for (const check of group.checks) {
      const written = new RegExp(check.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\\(/g, '\\(\\s*').replace(/\\\)/g, '\\s*\\)')).exec(site.before);
      if (!written) return `group check ${check} is missing above this delete`;
      if (!answerStops(site.before, written.index)) return `group check ${check} never stops this delete`;
    }
    return loggedPaths(site.body).includes(group.logs) ? '' : `group removal log does not name ${group.logs}`;
  }
  const target = removedTarget(site.call, site.body);
  if (!target) return 'could not tell which folder is deleted';
  const folder = sameFolder(site.body);
  const naming = (calls) => calls.filter((check) => folder(check.arg) === folder(target));
  const above = naming(checkedCalls(site.before));
  if (!above.length) {
    return naming(checkedCalls(site.body)).length
      ? `git check on ${target} only comes after the delete`
      : `no git check names ${target}`;
  }
  if (!above.some((check) => answerStops(site.before, check.index))) return `git check answer on ${target} never stops the delete`;
  return loggedPaths(site.body).some((logged) => folder(logged) === folder(target)) ? '' : `removal log does not name ${target}`;
}

// Deletes found in a listed function, matched against its list by folder.
// Anything left over on either side is named with its line or folder.
function listedDeleteDrift(key, listed, found) {
  const left = [...listed];
  const added = [];
  for (const site of found) {
    const target = removedTarget(site.call, site.body) || '(unreadable folder)';
    const at = left.indexOf(target);
    if (at >= 0) left.splice(at, 1);
    else added.push(`${key} (line ${site.line}): new delete of ${target}`);
  }
  return [...added, ...left.map((target) => `${key}: listed delete of ${target} is gone`)];
}

test('every work folder removal goes through the git check and the removal log', () => {
  const sites = [...sourceFiles('lib'), ...sourceFiles('commands')].flatMap(worktreeRemovalSites);
  assert.ok(sites.length >= 8, `expected the known removal sites, found ${sites.length}`);
  const bypasses = sites
    .filter((site) => !UNGUARDED_REMOVALS[site.key] && !NOT_YET_GUARDED[site.key])
    .filter((site) => removalGap(site))
    .map((site) => `${site.key} (line ${site.line}): ${removalGap(site)}`);
  assert.deepEqual(bypasses, [], 'removal without a git check and removal log naming the deleted folder');
  const stale = [...Object.keys(UNGUARDED_REMOVALS), ...Object.keys(GROUPED_REMOVALS), ...Object.keys(NOT_YET_GUARDED)]
    .filter((key) => !sites.some((site) => site.key === key));
  assert.deepEqual(stale, [], 'exception names a function that no longer removes a folder');
  const drifted = Object.entries({ ...UNGUARDED_REMOVALS, ...GROUPED_REMOVALS })
    .flatMap(([key, { deletes }]) => listedDeleteDrift(key, deletes, sites.filter((site) => site.key === key)));
  assert.deepEqual(drifted, [], 'an exempt or grouped function gained or lost a delete; review it, then update its list');
  const nowGuarded = Object.keys(NOT_YET_GUARDED).filter((key) => sites
    .filter((site) => site.key === key)
    .every((site) => !removalGap(site)));
  assert.deepEqual(nowGuarded, [], 'guarded now: delete its line from NOT_YET_GUARDED');
});

test('saved scanner examples reject missed removals in the required checks', () => {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '../atris/receipts/work-folder-scan-probe.js'),
    '--require-protection',
  ], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /review gaps: 0; synthetic source only, no folders removed/);
});

test('a git check that comes late, names another folder, or is ignored does not count as protection', () => {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '../atris/receipts/work-folder-scan-binding-probe.js'),
    '--require-protection',
  ], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /review gaps: 0; synthetic source only, never executed/);
});

test('grouped sandbox cleanup exposes every recursive target to the scan', () => {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '../atris/receipts/work-folder-scan-group-probe.js'),
    '--require-protection',
  ], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /group: 4 recursive targets; 0 missing from scan; source only, no folders removed/);
});

test('green landing keeps its scratch folder while a test is still running in it', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    assert.deepEqual(dropScratch(repo, wt, { activeCwds: [path.join(wt, 'node_modules')] }), { removed: false, reason: 'active_process' });
    fs.writeFileSync(path.join(worktreeGitDir(wt), 'index.lock'), '');
    assert.deepEqual(dropScratch(repo, wt, { activeCwds: [] }), { removed: false, reason: 'git_lock' });
    assert.ok(fs.existsSync(wt));
    assert.deepEqual(removalLines(repo), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('green landing names who removed its scratch folder and why', () => {
  const { base, repo, wt } = landedWorktree();
  try {
    assert.deepEqual(dropScratch(repo, wt, { activeCwds: [] }), { removed: true });
    assert.equal(fs.existsSync(wt), false);
    assert.ok(!git(repo, ['worktree', 'list']).includes(wt));
    const [line] = removalLines(repo);
    assert.equal(line.path, wt);
    assert.equal(line.by, 'atris land --auto');
    assert.equal(line.reason, 'green_landing_scratch_done');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
