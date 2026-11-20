'use strict';

// The waiting pile: how many finished changes wait to land in a project, and
// how many of those clash with the default branch.
//
// "Finished and waiting" means what the hourly lander picks up: a local branch
// with commits the default branch does not have, untouched for 48 hours and
// not past the 7 day limit (the board in commands/land.js). The hourly lander
// records its own count after every run. Anything else reads that record, or
// counts with local git only when the record is old, and keeps that count for
// five minutes. Nothing here talks to GitHub, so it works offline.
//
// A clash is `git merge-tree --write-tree <default> <branch>` reporting
// conflicts. Each answer is kept per branch commit and base commit, so a
// branch is only tried again when it or the default branch moves.
//
// Every entry point catches its own errors: a count that cannot be made
// prints nothing and never changes how the caller exits.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_LIMIT = 10;
const SCHEMA = 'atris.waiting_pile.v1';
const FILE = path.join('.atris', 'state', 'waiting-pile.json');
// The lander runs hourly, so its record is good for two runs.
const LANDER_FRESH_MS = 2 * 60 * 60 * 1000;
const LOCAL_FRESH_MS = 5 * 60 * 1000;
// The same windows as the landing board (commands/land.js).
const STALE_HOURS = 48;
const TTL_DAYS = 7;
const PROTECTED = new Set(['main', 'master']);

function git(root, args, timeoutMs) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...(timeoutMs > 0 ? { timeout: Math.max(50, Math.floor(timeoutMs)) } : {}),
  });
  return { status: result.status, ok: result.status === 0, out: String(result.stdout || '').trim() };
}

function remaining(deadline) {
  return deadline ? deadline - Date.now() : 0;
}

function expired(deadline) {
  return Boolean(deadline) && Date.now() >= deadline;
}

// The shared git folder read straight from disk, so the cached path starts
// no process: `.git` is the folder itself in a main checkout, and a file
// naming the copy's own git folder (whose `commondir` names the shared one)
// in a work copy. '' when the layout is anything else.
function commonDirOnDisk(root) {
  try {
    const dotGit = path.join(root, '.git');
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) return fs.existsSync(path.join(dotGit, 'HEAD')) ? dotGit : '';
    const named = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!named) return '';
    const own = path.resolve(root, named[1].trim());
    const pointer = path.join(own, 'commondir');
    return fs.existsSync(pointer) ? path.resolve(own, fs.readFileSync(pointer, 'utf8').trim()) : own;
  } catch {
    return '';
  }
}

// The git folder every checkout shares, and the main checkout that owns it.
function places(root, deadline) {
  let common = commonDirOnDisk(root);
  if (!common) {
    const asked = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], remaining(deadline));
    if (!asked.ok || !asked.out) return null;
    common = asked.out;
  }
  const owner = path.dirname(common);
  const usesAtris = fs.existsSync(path.join(owner, '.atris'));
  return { common, owner, file: usesAtris ? path.join(owner, FILE) : '' };
}

// `waiting_limit` from the project's map, atris/checks.json. 10 when the map
// or the key is missing or not a whole number.
function readLimit(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'atris', 'checks.json'), 'utf8'));
    const value = raw && raw.waiting_limit;
    return Number.isInteger(value) && value >= 0 ? value : DEFAULT_LIMIT;
  } catch {
    return DEFAULT_LIMIT;
  }
}

// For `atris check --lint-map`: '' when the key is fine or absent.
function limitProblem(raw) {
  if (!raw || raw.waiting_limit === undefined) return '';
  const value = raw.waiting_limit;
  return Number.isInteger(value) && value >= 0 ? '' : `waiting_limit must be a whole number of changes, like ${DEFAULT_LIMIT}`;
}

function readRecord(file) {
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.schema !== SCHEMA) return null;
    if (!Number.isInteger(data.waiting) || data.waiting < 0) return null;
    if (!Number.isFinite(Date.parse(data.at))) return null;
    if (data.clashing !== null && !(Number.isInteger(data.clashing) && data.clashing >= 0)) return null;
    return data;
  } catch {
    return null;
  }
}

function isFresh(record, nowMs) {
  const age = nowMs - Date.parse(record.at);
  const limit = record.source === 'lander' ? LANDER_FRESH_MS : LOCAL_FRESH_MS;
  return age > -60 * 1000 && age < limit;
}

function writeRecord(file, record) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record)}\n`);
    fs.renameSync(tmp, file);
  } catch {
    // Only a speedup: a failed write means the next call counts again.
  }
}

function sameBase(a, b) {
  return String(a || '').replace(/^origin\//, '') === String(b || '').replace(/^origin\//, '');
}

function defaultBase(root, deadline) {
  const head = git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], remaining(deadline));
  if (head.ok && head.out) return head.out;
  const found = git(root, ['for-each-ref', '--format=%(refname:short)',
    'refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'], remaining(deadline));
  if (!found.ok) return '';
  const names = found.out.split(/\r?\n/).filter(Boolean);
  return ['origin/main', 'origin/master', 'main', 'master'].find((name) => names.includes(name)) || '';
}

// What `git cherry` already said about a branch, from the board's cache.
function readCherry(common) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(common, 'atris', 'cherry-cache.json'), 'utf8'));
    return parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
  } catch {
    return {};
  }
}

function worktreeMtimes(root, deadline) {
  const listed = git(root, ['worktree', 'list', '--porcelain'], remaining(deadline));
  const byBranch = new Map();
  if (!listed.ok) return byBranch;
  let where = '';
  for (const line of listed.out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) where = line.slice('worktree '.length);
    else if (line.startsWith('branch refs/heads/') && where) {
      try { byBranch.set(line.slice('branch refs/heads/'.length), fs.statSync(where).mtimeMs); } catch {}
    }
  }
  return byBranch;
}

// The branches the lander would pick up, counted with local git only.
function localWaiting(root, base, baseSha, common, { nowMs, deadline }) {
  const listed = git(root, ['for-each-ref', `--no-merged=${baseSha}`, 'refs/heads',
    '--format=%(refname:short)%09%(committerdate:unix)%09%(objectname)'], remaining(deadline));
  if (!listed.ok) return null;
  const local = base.replace(/^origin\//, '');
  const cherry = readCherry(common);
  const mtimes = worktreeMtimes(root, deadline);
  const branches = [];
  for (const line of listed.out.split(/\r?\n/).filter(Boolean)) {
    const [name, unix, sha] = line.split('\t');
    if (!name || !sha || PROTECTED.has(name) || name === local) continue;
    const committedMs = Number(unix) * 1000;
    if (!Number.isFinite(committedMs)) continue;
    if (Math.floor((nowMs - committedMs) / 86400000) > TTL_DAYS) continue;
    const seen = cherry[`${baseSha}:${sha}`];
    if (seen && seen.landedElsewhere > 0 && seen.unique === 0) continue;
    const touched = Math.max(committedMs, mtimes.get(name) || 0);
    if (Math.floor((nowMs - touched) / 3600000) < STALE_HOURS) continue;
    branches.push({ name, sha });
  }
  return branches;
}

// How many of `branches` clash with the base commit. `memo` holds earlier
// answers keyed by branch commit; anything not answered before the deadline
// is counted in `unchecked`, never as clean.
function countClashes(root, baseSha, branches, memo, deadline) {
  const baseKey = baseSha.slice(0, 12);
  const next = {};
  let clashing = 0;
  let unchecked = 0;
  for (const { sha } of branches) {
    const key = sha.slice(0, 12);
    const hit = memo && typeof memo[key] === 'string' ? memo[key] : '';
    let answer = hit.startsWith(`${baseKey}:`) ? hit.slice(baseKey.length + 1) : '';
    if (!answer && !expired(deadline)) {
      const tried = git(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', baseSha, sha], remaining(deadline));
      if (tried.status === 0) answer = '0';
      else if (tried.status === 1) answer = '1';
    }
    if (answer === '1') clashing += 1;
    if (answer) next[key] = `${baseKey}:${answer}`;
    else unchecked += 1;
  }
  return { clashing, unchecked, memo: next };
}

function finish(root, record) {
  return {
    waiting: record.waiting,
    clashing: record.clashing,
    unchecked: Number(record.unchecked) || 0,
    limit: readLimit(root),
    base: record.base,
    source: record.source,
    at: record.at,
  };
}

// The pile for `root`. A fresh record answers at once; otherwise local git
// counts it before `budgetMs` runs out. `clashes: true` also counts clashes.
// null when it cannot be told.
function readPile(root, { base = '', now = Date.now(), clashes = false, budgetMs = 1000, atrisOnly = false } = {}) {
  try {
    const deadline = Date.now() + Math.max(1, budgetMs);
    const where = places(root, deadline);
    if (!where || (atrisOnly && !where.file)) return null;
    const prior = readRecord(where.file);
    if (prior && isFresh(prior, now) && (!base || sameBase(prior.base, base)) && (!clashes || prior.clashing !== null)) {
      return finish(root, prior);
    }
    const against = base || defaultBase(root, deadline);
    if (!against || expired(deadline)) return null;
    const baseSha = git(root, ['rev-parse', '--verify', '--quiet', `${against}^{commit}`], remaining(deadline));
    if (!baseSha.ok || !baseSha.out) return null;
    const branches = localWaiting(root, against, baseSha.out, where.common, { nowMs: now, deadline });
    if (!branches || expired(deadline)) return null;
    let clash = { clashing: null, unchecked: 0, memo: prior && prior.clash ? prior.clash : {} };
    if (clashes) clash = countClashes(root, baseSha.out, branches, prior && prior.clash, deadline);
    const record = {
      schema: SCHEMA,
      at: new Date(now).toISOString(),
      source: 'local',
      base: against,
      waiting: branches.length,
      clashing: clash.clashing,
      unchecked: clash.unchecked,
      clash: clash.memo,
    };
    writeRecord(where.file, record);
    return finish(root, record);
  } catch {
    return null;
  }
}

// Called by the lander after each run with the branches still waiting.
// A dry run counts but writes nothing.
function fromLander(root, { base, names = [], dryRun = false, now = Date.now(), budgetMs = 60 * 1000 } = {}) {
  try {
    const deadline = Date.now() + Math.max(1, budgetMs);
    const where = places(root, deadline);
    if (!where || !base) return null;
    const baseSha = git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], remaining(deadline));
    if (!baseSha.ok || !baseSha.out) return null;
    const heads = git(root, ['for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(objectname)'], remaining(deadline));
    const shaOf = new Map(heads.ok ? heads.out.split(/\r?\n/).filter(Boolean).map((line) => line.split('\t')) : []);
    const wanted = new Set(names);
    const branches = [...wanted].map((name) => ({ name, sha: shaOf.get(name) || '' }));
    const known = branches.filter((b) => b.sha);
    const prior = readRecord(where.file);
    const clash = countClashes(root, baseSha.out, known, prior && prior.clash, deadline);
    const record = {
      schema: SCHEMA,
      at: new Date(now).toISOString(),
      source: 'lander',
      base,
      waiting: branches.length,
      clashing: clash.clashing,
      unchecked: clash.unchecked + (branches.length - known.length),
      clash: clash.memo,
    };
    if (!dryRun) writeRecord(where.file, record);
    const pile = finish(root, record);
    return { ...pile, line: pileLine(pile) };
  } catch {
    return null;
  }
}

// "6 finished changes are waiting to land here, 4 clash with master."
function pileLine(pile) {
  if (!pile || !Number.isInteger(pile.waiting)) return '';
  const n = pile.waiting;
  const head = `${n} finished ${n === 1 ? 'change is' : 'changes are'} waiting to land here`;
  if (!Number.isInteger(pile.clashing)) return `${head}.`;
  const m = pile.clashing;
  const branch = String(pile.base || 'the default branch').replace(/^origin\//, '');
  const some = pile.unchecked ? 'at least ' : '';
  return `${head}, ${some}${m} ${m === 1 && !some ? 'clashes' : 'clash'} with ${branch}.`;
}

// The one line `atris worktree start` prints when the pile is over the limit.
// '' otherwise, and '' whenever the count cannot be made. With no fresh record
// the local count gets one second (ATRIS_WAITING_PILE_BUDGET_MS sets another).
// A project with no .atris folder is not counted, so a plain repo pays nothing.
function startNotice(root, { base = '', now = Date.now(), budgetMs = Number(process.env.ATRIS_WAITING_PILE_BUDGET_MS) || 1000 } = {}) {
  try {
    const pile = readPile(root, { base, now, budgetMs, atrisOnly: true });
    if (!pile || pile.waiting <= pile.limit) return '';
    return `${pile.waiting} ${pile.waiting === 1 ? 'change is' : 'changes are'} waiting to land here. Clear those first.`;
  } catch {
    return '';
  }
}

// The one line `atris check --push` prints after its result.
function reportLine(root, { now = Date.now(), budgetMs = 15 * 1000 } = {}) {
  try {
    return pileLine(readPile(root, { now, clashes: true, budgetMs }));
  } catch {
    return '';
  }
}

module.exports = {
  DEFAULT_LIMIT,
  FILE,
  fromLander,
  limitProblem,
  pileLine,
  readLimit,
  readPile,
  reportLine,
  startNotice,
};
