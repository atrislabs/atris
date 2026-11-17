'use strict';

// atris check, the feature proof and the secret scan.
//
// A change carries its own proof: one command that shows the feature works.
// It comes from --proof, a `Proof: <command>` line in a commit message of the
// change, or the --verify of the task on this branch. The proof is checked
// cheaply, on this code only:
//   1. it is about this change: the command, or a file it runs, was changed by
//      the diff or names a changed file;
//   2. it passes when run once;
//   3. for node, coverage comes free (NODE_V8_COVERAGE): it must run at least
//      one changed line of a non-test file, and the number is always reported;
//   4. a small static guard: a proof test with no assertion, or one that mocks
//      the very file it claims to prove, is flagged.
// --deep adds the strong form: the proof fails on the base code and passes here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec)\/|(?:^|\/)test[-_][^/]*$|[._-](?:test|spec)\.[a-z]+$|_test\.py$/i;
const ASSERTION = /\bassert\b|\bassert\.|\bexpect\s*\(|\.should\b|\bt\.(?:is|true|false|deepEqual|equal|ok|throws)\s*\(|self\.assert\w+\(|pytest\.raises|\bthrow new Error\b|process\.exit\(\s*1\s*\)/;
const SECRET_PATTERNS = [
  ['anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ['github token', /\bghp_[A-Za-z0-9]{30,}/],
  ['github token', /\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['aws key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['slack token', /\bxox[bpas]-[A-Za-z0-9-]{20,}/],
  ['stripe key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/],
];

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { ok: result.status === 0, out: String(result.stdout || '') };
}

function isTestFile(file) {
  return TEST_FILE.test(file);
}

function selfCheck(command) {
  return /(?:^|\s|\/)atris(?:\.js)?\s+check\b/.test(command);
}

// Where the proof comes from, first match wins.
function findProof(root, change, options = {}) {
  if (options.proof) return { command: options.proof, source: '--proof' };
  if (change.mergeBase) {
    const log = git(root, ['log', '--format=%B%x00', `${change.mergeBase}..HEAD`]).out;
    for (const body of log.split('\0')) {
      const line = body.split('\n').map((text) => text.trim()).reverse().find((text) => /^Proof:\s*\S/i.test(text));
      if (line) {
        const command = line.replace(/^Proof:\s*/i, '').trim();
        if (!selfCheck(command)) return { command, source: 'commit Proof: line' };
      }
    }
  }
  const task = taskVerify(root);
  if (task) return task;
  return null;
}

// The --verify of an open task on this branch (or the named one), from the
// task list snapshot.
function taskVerify(root, named = '') {
  const branch = named || git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
  if (!branch || branch === 'HEAD') return null;
  const places = [path.join(root, '.atris', 'state', 'tasks.projection.json')];
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(root, '.atris', 'agent-worktree.json'), 'utf8'));
    if (meta && meta.workspace_root) places.push(path.join(meta.workspace_root, '.atris', 'state', 'tasks.projection.json'));
  } catch {}
  for (const file of places) {
    let tasks = [];
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      tasks = Array.isArray(data.tasks) ? data.tasks : Object.values(data.tasks || {});
    } catch { continue; }
    const hit = tasks
      .filter((task) => task && task.metadata && task.metadata.branch === branch && task.metadata.verify && !selfCheck(String(task.metadata.verify)))
      .filter((task) => !['done', 'archived', 'cancelled'].includes(String(task.status)))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0];
    if (hit) return { command: String(hit.metadata.verify), source: `task ${hit.display_id || hit.id} --verify` };
  }
  return null;
}

// Files named in the proof command that exist here.
function filesInCommand(root, command) {
  return [...new Set(String(command).split(/\s+/)
    .map((word) => word.replace(/^['"]|['"]$/g, '').replace(/^\.\//, ''))
    .filter((word) => word && !word.startsWith('-') && /[./]/.test(word))
    .filter((word) => { try { return fs.statSync(path.join(root, word)).isFile(); } catch { return false; } }))];
}

function needleHit(source, changed) {
  return changed.find((file) => {
    const needle = file.replace(/\.[A-Za-z0-9]+$/, '');
    return source.includes(needle) || source.includes(`${path.basename(needle)}.`);
  }) || null;
}

// Rule 1: the proof is about this change.
function proofRelevance(root, command, changed) {
  const named = filesInCommand(root, command);
  const touched = named.find((file) => changed.includes(file));
  if (touched) return { ok: true, why: `runs ${touched}, which this change touches` };
  const inCommand = needleHit(command, changed);
  if (inCommand) return { ok: true, why: `names ${inCommand}` };
  for (const file of named) {
    let source = '';
    try { source = fs.readFileSync(path.join(root, file), 'utf8'); } catch {}
    const hit = needleHit(source, changed.filter((name) => !isTestFile(name)));
    if (hit) return { ok: true, why: `${file} names ${hit}` };
  }
  return { ok: false, why: 'the proof neither runs a changed file nor names one' };
}

// Rule 4: a proof test that cannot fail, or that mocks what it proves.
function staticGuard(root, command, changed) {
  const flags = [];
  const tests = filesInCommand(root, command).filter(isTestFile);
  const changedCode = changed.filter((file) => !isTestFile(file));
  for (const test of tests) {
    let source = '';
    try { source = fs.readFileSync(path.join(root, test), 'utf8'); } catch { continue; }
    if (!ASSERTION.test(source)) flags.push(`${test} has no assertion, so it cannot fail`);
    const mocks = [...source.matchAll(/\b(?:jest\.mock|vi\.mock|mock\.module|mock\.patch|patch)\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const target of mocks) {
      const asPath = target.replace(/\./g, '/');
      const hit = changedCode.find((file) => {
        const stem = file.replace(/\.[A-Za-z0-9]+$/, '');
        return stem.endsWith(asPath.replace(/^\.\.?\//, '')) || stem.endsWith(target.replace(/^\.\.?\//, '').replace(/\.[A-Za-z0-9]+$/, ''));
      });
      if (hit) flags.push(`${test} mocks ${hit}, the file it claims to prove`);
    }
  }
  return flags;
}

// New line numbers this change adds or edits, per file (merge base to working copy).
function changedLines(root, mergeBase, files) {
  const lines = new Map();
  if (!files.length) return lines;
  const diff = git(root, ['diff', '-U0', '--no-color', '--no-renames', mergeBase || 'HEAD', '--', ...files]).out;
  let current = null;
  for (const row of diff.split('\n')) {
    if (row.startsWith('+++ ')) {
      current = row.startsWith('+++ b/') ? row.slice(6) : null;
      if (current && !lines.has(current)) lines.set(current, new Set());
      continue;
    }
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let n = start; n < start + count; n += 1) lines.get(current).add(n);
    }
  }
  // Untracked new files: every line is new.
  for (const file of files) {
    if (lines.has(file)) continue;
    try {
      const count = fs.readFileSync(path.join(root, file), 'utf8').split('\n').length;
      lines.set(file, new Set(Array.from({ length: count }, (_, i) => i + 1)));
    } catch {}
  }
  return lines;
}

// Lines V8 ran, from NODE_V8_COVERAGE output, for the files asked about.
// The innermost range over a line's first character decides it.
function executedLines(root, coverageDir, files) {
  const wanted = new Map(files.map((file) => [path.join(root, file), file]));
  const ranges = new Map(files.map((file) => [file, []]));
  let entries = [];
  try { entries = fs.readdirSync(coverageDir).filter((name) => name.endsWith('.json')); } catch {}
  for (const name of entries) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(coverageDir, name), 'utf8')); } catch { continue; }
    for (const script of data.result || []) {
      let file = null;
      try { file = wanted.get(script.url.startsWith('file:') ? require('url').fileURLToPath(script.url) : script.url); } catch {}
      if (!file) continue;
      for (const fn of script.functions || []) for (const range of fn.ranges || []) ranges.get(file).push(range);
    }
  }
  const executed = new Map();
  for (const [file, list] of ranges) {
    if (!list.length) continue;
    let source = '';
    try { source = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    const ran = new Set();
    let offset = 0;
    source.split('\n').forEach((text, index) => {
      const at = offset + (text.length - text.trimStart().length);
      offset += text.length + 1;
      if (!text.trim()) return;
      let best = null;
      for (const range of list) {
        if (range.startOffset <= at && at < range.endOffset && (!best || range.endOffset - range.startOffset < best.endOffset - best.startOffset)) best = range;
      }
      if (best && best.count > 0) ran.add(index + 1);
    });
    executed.set(file, ran);
  }
  return executed;
}

function runsNode(command) {
  return /^(?:\S*\/)?(?:node|npm|npx|tsx)\b/.test(String(command).trim());
}

// Changed-line coverage of non-test JS files: { measured, ran, total, files }.
function changedLineCoverage(root, mergeBase, changed, coverageDir) {
  const code = changed.filter((file) => /\.(?:c?js|mjs)$/.test(file) && !isTestFile(file) && fs.existsSync(path.join(root, file)));
  if (!code.length) return { measured: false, why: 'no changed JavaScript outside tests to measure' };
  const want = changedLines(root, mergeBase, code);
  const ran = executedLines(root, coverageDir, code);
  let total = 0;
  let hit = 0;
  for (const [file, lines] of want) {
    const source = (() => { try { return fs.readFileSync(path.join(root, file), 'utf8').split('\n'); } catch { return []; } })();
    for (const n of lines) {
      if (!source[n - 1] || !source[n - 1].trim()) continue;
      total += 1;
      if (ran.has(file) && ran.get(file).has(n)) hit += 1;
    }
  }
  return { measured: total > 0, ran: hit, total, why: total ? '' : 'the changed lines are blank' };
}

// --deep: the proof must fail on the base code with this change's test files
// copied in, and pass here. The base code is a detached worktree in the OS temp
// folder; installed packages come in the same copy-on-write way work copies
// get them (lib/worktree-space.js seedNodeModules). It is removed in finally,
// and one a crash left behind is removed by the next run after an hour.
const DEEP_PREFIX = 'atris-check-deep-';
const DEEP_STALE_MS = 60 * 60 * 1000;

function sweepStaleDeepCopies(root, { now = Date.now(), tmp = os.tmpdir() } = {}) {
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(tmp).filter((name) => name.startsWith(DEEP_PREFIX)); } catch { return 0; }
  for (const name of names) {
    const dir = path.join(tmp, name);
    try {
      if (now - fs.statSync(dir).mtimeMs < DEEP_STALE_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {}
  }
  if (removed && root) git(root, ['worktree', 'prune']);
  return removed;
}

function seedDeps(root, target) {
  try {
    const space = require('./worktree-space');
    const core = require('./worktree-core');
    const primary = core.findPrimaryRoot(root);
    return space.seedNodeModules({
      target,
      workspace: path.dirname(primary),
      repoName: path.basename(primary),
      sources: [primary, ...core.listWorktrees(root).map((wt) => wt.path)],
      isIgnored: (dir) => spawnSync('git', ['check-ignore', '-q', '--', 'node_modules/'], { cwd: dir }).status === 0,
    });
  } catch (error) {
    return { status: 'skipped', reason: String((error && error.message) || error) };
  }
}

function deepProof(root, mergeBase, command, changed, env) {
  sweepStaleDeepCopies(root);
  const dir = path.join(os.tmpdir(), `${DEEP_PREFIX}${process.pid}-${Date.now().toString(36)}`);
  try {
    const added = spawnSync('git', ['worktree', 'add', '--quiet', '--detach', dir, mergeBase], { cwd: root, encoding: 'utf8' });
    if (added.status !== 0) return { ok: false, why: 'could not check out the base code' };
    const deps = seedDeps(root, dir);
    for (const file of changed.filter(isTestFile)) {
      const from = path.join(root, file);
      if (!fs.existsSync(from)) continue;
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(from, path.join(dir, file));
    }
    const result = spawnSync(command, { cwd: dir, shell: true, encoding: 'utf8', env, timeout: 300000 });
    if (result.status === 0) return { ok: false, why: 'the proof also passes on the base code, so it does not show this change', deps: deps.status };
    return { ok: true, why: `fails on the base code (exit ${result.status}) and passes here`, deps: deps.status };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    git(root, ['worktree', 'prune']);
  }
}

// Added lines that look like keys. Reports file, line and kind; never the text.
function secretScan(root, mergeBase, files) {
  const hits = [];
  if (!files.length) return hits;
  const diff = git(root, ['diff', '-U0', '--no-color', '--no-renames', mergeBase || 'HEAD', '--', ...files]).out;
  let current = null;
  let line = 0;
  const scanLine = (file, n, text) => {
    for (const [kind, pattern] of SECRET_PATTERNS) if (pattern.test(text)) { hits.push({ file, line: n, kind }); break; }
  };
  const seen = new Set();
  for (const row of diff.split('\n')) {
    if (row.startsWith('+++ ')) { current = row.startsWith('+++ b/') ? row.slice(6) : null; if (current) seen.add(current); continue; }
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!current) continue;
    if (row.startsWith('+')) { scanLine(current, line, row.slice(1)); line += 1; }
  }
  // Untracked files are not in the diff: scan them whole.
  for (const file of files) {
    if (seen.has(file)) continue;
    let text = '';
    try {
      const stat = fs.statSync(path.join(root, file));
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch { continue; }
    text.split('\n').forEach((row, index) => scanLine(file, index + 1, row));
  }
  return hits;
}

module.exports = {
  isTestFile,
  findProof,
  proofRelevance,
  staticGuard,
  changedLines,
  changedLineCoverage,
  runsNode,
  deepProof,
  sweepStaleDeepCopies,
  secretScan,
  taskVerify,
};
