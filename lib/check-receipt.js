'use strict';

// atris check, part two: what changed, which code that is, and the receipt.
//
// The receipt is the only proof. It names the exact code it checked by the
// git tree of the working copy (committed plus uncommitted files), so a
// receipt made for one state of the code never vouches for another. It records
// every picked check with its status; a check that could not run here is
// `needs-lane`, and needs-lane never makes the verdict `proven`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RECEIPT_KIND = 'atris.check.v1';
const RECEIPTS_DIR = path.join('.atris', 'receipts');
const EXIT = { proven: 0, failed: 1, usage: 2, partly: 3 };
// Printed with exit code 3. Landing tools match the code and this line
// together (lib/task-proof.js checkSkippedHere), so a stray exit 3 from some
// other command still counts as a failure, never as "needs a lane".
const CHECK_NEEDS_LANE_LINE = 'atris check: not proven here; needs a lane';

function git(root, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: options.env || process.env,
  });
  return { ok: result.status === 0, out: String(result.stdout || ''), err: String(result.stderr || '').trim() };
}

function repoRootOf(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  return top.ok ? top.out.trim() : null;
}

function refExists(root, ref) {
  return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok;
}

// The project's default branch: what origin/HEAD points at, else the first of
// origin/main, origin/master, main, master that exists.
function defaultBase(root) {
  const head = git(root, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
  if (head.ok) {
    const ref = head.out.trim().replace(/^refs\/remotes\//, '');
    if (ref && refExists(root, ref)) return ref;
  }
  return ['origin/main', 'origin/master', 'main', 'master'].find((ref) => refExists(root, ref)) || null;
}

// atris check's own files (receipts, import cache) are never part of the change.
function inReceipts(file) {
  return ['.atris/receipts', '.atris/cache'].some((dir) => file === dir || file.startsWith(`${dir}/`));
}

function splitZ(text) {
  return String(text || '').split('\0').filter(Boolean);
}

function uncommittedFiles(root) {
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  if (!status.ok) return [];
  return splitZ(status.out).map((row) => row.slice(3)).filter((file) => file && !inReceipts(file));
}

// The files this change touches: everything since the merge base with the
// default branch, plus every uncommitted file. Deleted files count.
function changeSet(root, options = {}) {
  if (!git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) {
    return { ok: false, error: 'this repo has no commit yet, so there is nothing to compare against' };
  }
  if (options.files) {
    return { ok: true, base: null, mergeBase: null, files: [...new Set(options.files)].sort(), filesOverride: true, baseOverride: false };
  }
  const base = options.base || defaultBase(root);
  if (!base) return { ok: false, error: 'could not find the default branch; pass --base <ref>' };
  if (!refExists(root, base)) return { ok: false, error: `base ${base} is not a commit here` };
  const mb = git(root, ['merge-base', base, 'HEAD']);
  if (!mb.ok) return { ok: false, error: `no merge base between ${base} and HEAD` };
  const mergeBase = mb.out.trim();
  const committed = splitZ(git(root, ['diff', '--name-only', '-z', '--no-renames', mergeBase, 'HEAD']).out);
  const files = [...new Set([...committed, ...uncommittedFiles(root)])].filter((file) => !inReceipts(file)).sort();
  return { ok: true, base, mergeBase, files, filesOverride: false, baseOverride: Boolean(options.base) };
}

// The git tree of the working copy as it is right now, uncommitted and
// untracked files included, ignored files left out. Built in a throwaway index
// (a copy of the real one, so unchanged files are not re-read), so the real
// index and the branch are never touched.
function codeIdentity(root) {
  const headSha = git(root, ['rev-parse', 'HEAD']).out.trim();
  const headTree = git(root, ['rev-parse', 'HEAD^{tree}']).out.trim();
  const indexPath = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']).out.trim());
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-check-index-'));
  const tempIndex = path.join(tempDir, 'index');
  try {
    if (fs.existsSync(indexPath)) {
      const fd = fs.openSync(indexPath, 'r');
      try {
        const mtime = Number(fs.fstatSync(fd, { bigint: true }).mtimeNs / 1_000_000_000n);
        fs.writeFileSync(tempIndex, fs.readFileSync(fd));
        // A newer timestamp would hide same-tick edits from Git's stat cache.
        // Round down so the copy's timestamp is never later than the original's.
        fs.utimesSync(tempIndex, mtime, mtime);
      } finally {
        fs.closeSync(fd);
      }
    }
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
    if (!fs.existsSync(tempIndex)) git(root, ['read-tree', 'HEAD'], { env });
    git(root, ['add', '-A', '--', '.', ':(exclude).atris/receipts', ':(exclude).atris/cache'], { env });
    const tree = git(root, ['write-tree'], { env }).out.trim();
    const dirty = Boolean(tree) && tree !== headTree;
    return { headSha, tree, dirty, uncommittedHash: dirty ? tree : 'none' };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function verdictOf(results) {
  // not-run: a later stage that never ran because an earlier one failed.
  if (results.some((entry) => entry.status === 'failed' || entry.status === 'not-run')) return 'failed';
  if (results.some((entry) => entry.status === 'needs-lane')) return 'partly';
  return 'proven';
}

function receiptPath(root, headSha) {
  return path.join(root, RECEIPTS_DIR, `check-${String(headSha).slice(0, 12)}.json`);
}

const KEEP_RECEIPTS = 200;
const KEEP_RECEIPT_DAYS = 14;

// Commits waiting on a staged atris/ready ref: their receipts are never pruned.
function stagedTips(root) {
  const refs = git(root, ['for-each-ref', '--format=%(objectname)', 'refs/heads/atris/ready/', 'refs/remotes/origin/atris/ready/']);
  return new Set(refs.out.split('\n').map((line) => line.trim()).filter(Boolean));
}

// Keep the newest 200 receipts and nothing older than 14 days, except a
// receipt whose commit still waits on a staged ref. Runs on every write.
function pruneReceipts(root, { now = Date.now(), keep = KEEP_RECEIPTS, days = KEEP_RECEIPT_DAYS } = {}) {
  const dir = path.join(root, RECEIPTS_DIR);
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => /^check-.*\.json$/.test(name)); } catch { return []; }
  const rows = names.map((name) => {
    const file = path.join(dir, name);
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch {}
    return { file, mtime };
  }).sort((a, b) => b.mtime - a.mtime);
  const staged = stagedTips(root);
  const removed = [];
  rows.forEach((row, index) => {
    const old = now - row.mtime > days * 24 * 3600 * 1000;
    if (index < keep && !old) return;
    const receipt = readReceipt(row.file);
    if (receipt && staged.has(receipt.head_sha)) return;
    try { fs.rmSync(row.file, { force: true }); removed.push(row.file); } catch {}
  });
  return removed;
}

// Receipts are local proof, never committed: the folder ignores itself.
function writeReceipt(root, receipt) {
  const dir = path.join(root, RECEIPTS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  const file = receiptPath(root, receipt.head_sha);
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  pruneReceipts(root);
  return file;
}

function folderBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else { try { total += fs.statSync(full).size; } catch {} }
    }
  }
  return total;
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// One short line: what atris check keeps on disk in this repo.
function storageLine(root) {
  return `storage: receipts ${humanBytes(folderBytes(path.join(root, RECEIPTS_DIR)))}, cache ${humanBytes(folderBytes(path.join(root, '.atris', 'cache')))}`;
}

function readReceipt(file) {
  try {
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    return receipt && receipt.kind === RECEIPT_KIND ? receipt : null;
  } catch {
    return null;
  }
}

// The newest receipt in this copy whose code is exactly the code here now.
function findReceiptForTree(root, tree) {
  const dir = path.join(root, RECEIPTS_DIR);
  if (!tree || !fs.existsSync(dir)) return null;
  const found = fs.readdirSync(dir)
    .filter((name) => /^check-.*\.json$/.test(name))
    .map((name) => path.join(dir, name))
    .map((file) => ({ file, receipt: readReceipt(file) }))
    .filter((row) => row.receipt && row.receipt.tree === tree)
    .sort((a, b) => String(b.receipt.finished_at || '').localeCompare(String(a.receipt.finished_at || '')));
  return found[0] || null;
}

function exitForVerdict(verdict) {
  if (verdict === 'proven') return EXIT.proven;
  if (verdict === 'partly') return EXIT.partly;
  return EXIT.failed;
}

function truthy(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text !== '' && text !== '0' && text !== 'false' && text !== 'no';
}

// Is a person at this machine's screen? macOS or Windows, not CI, and on a Mac
// someone logged in at the console. ATRIS_CHECK_PERSON=1 or 0 overrides.
function onPersonsMachine({ env = process.env, platform = process.platform, consoleOwnerUid } = {}) {
  const forced = String(env.ATRIS_CHECK_PERSON ?? '').trim();
  if (forced === '1') return true;
  if (forced === '0') return false;
  if (truthy(env.CI)) return false;
  if (platform === 'win32') return true;
  if (platform !== 'darwin') return false;
  let uid = consoleOwnerUid;
  if (uid === undefined) {
    try { uid = fs.statSync('/dev/console').uid; } catch { uid = null; }
  }
  // Nobody logged in at the screen leaves the console owned by root.
  return uid !== 0;
}

module.exports = {
  RECEIPT_KIND,
  EXIT,
  CHECK_NEEDS_LANE_LINE,
  repoRootOf,
  defaultBase,
  changeSet,
  uncommittedFiles,
  git,
  codeIdentity,
  verdictOf,
  writeReceipt,
  pruneReceipts,
  storageLine,
  readReceipt,
  findReceiptForTree,
  exitForVerdict,
  onPersonsMachine,
};
