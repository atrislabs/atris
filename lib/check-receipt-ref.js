'use strict';

// atris check, part four: how a receipt reaches the lander.
//
// A worker's .atris/receipts folder goes away with its work copy, so `atris
// check --push` also keeps the receipt in git, as one small ref per commit:
//
//   refs/atris/receipts/<full sha>  ->  a commit with no parent whose tree
//                                       holds one file, receipt.json
//
// Plain git, no cryptography: the lander reads it back and works the plan out
// again (lib/check-recompute.js), so a forged receipt gains nothing. The ref
// lives outside refs/heads, so it starts no workflow and lists as no branch.
// Work copies share refs with their main checkout, so a lander on the same
// machine reads it without the network; one elsewhere fetches it.
//
// Storage: `atris check sweep` removes a receipt ref once its commit has been
// on the default branch for 7 days, and any receipt ref older than 30 days.

const { spawnSync } = require('child_process');
const receipts = require('./check-receipt');

const PREFIX = 'refs/atris/receipts/';
const FILE = 'receipt.json';
const LANDED_DAYS = 7;
const MAX_DAYS = 30;
const IDENTITY = {
  GIT_AUTHOR_NAME: 'atris check',
  GIT_AUTHOR_EMAIL: 'check@atris.invalid',
  GIT_COMMITTER_NAME: 'atris check',
  GIT_COMMITTER_EMAIL: 'check@atris.invalid',
};

function git(root, args, { input, env, timeout } = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    input,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(env || {}) },
  });
  return { ok: result.status === 0, out: String(result.stdout || '').trim(), err: String(result.stderr || '').trim() || (result.error ? result.error.message : '') };
}

function refFor(sha) {
  return `${PREFIX}${sha}`;
}

function hasOrigin(root) {
  return git(root, ['remote', 'get-url', 'origin']).ok;
}

// Write the receipt into this repo's objects and point its ref at it.
function storeReceipt(root, receipt) {
  const sha = String(receipt && receipt.head_sha || '');
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return { ok: false, detail: 'the receipt names no full commit' };
  const blob = git(root, ['hash-object', '-w', '--stdin'], { input: `${JSON.stringify(receipt, null, 2)}\n` });
  if (!blob.ok) return { ok: false, detail: blob.err };
  const tree = git(root, ['mktree'], { input: `100644 blob ${blob.out}\t${FILE}\n` });
  if (!tree.ok) return { ok: false, detail: tree.err };
  const commit = git(root, ['commit-tree', tree.out, '-m', `atris check receipt for ${sha.slice(0, 12)}`], { env: IDENTITY });
  if (!commit.ok) return { ok: false, detail: commit.err };
  const ref = refFor(sha);
  const moved = git(root, ['update-ref', ref, commit.out]);
  if (!moved.ok) return { ok: false, detail: moved.err };
  return { ok: true, ref, commit: commit.out };
}

// Keep the receipt here and on origin. A receipt replaces the one before it
// for the same commit (a fresh check of the same code), so the push forces
// that one ref only.
function publishReceipt(root, receipt) {
  const stored = storeReceipt(root, receipt);
  if (!stored.ok) return stored;
  if (!hasOrigin(root)) return { ...stored, pushed: false, detail: 'no origin remote; kept here' };
  const pushed = git(root, ['push', '--quiet', 'origin', `+${stored.commit}:${stored.ref}`], { timeout: 60000 });
  return { ...stored, pushed: pushed.ok, ok: pushed.ok, detail: pushed.ok ? '' : pushed.err.split('\n')[0] };
}

function readAtRef(root, ref) {
  const text = git(root, ['cat-file', 'blob', `${ref}:${FILE}`]);
  if (!text.ok) return null;
  try {
    const receipt = JSON.parse(text.out);
    return receipt && receipt.kind === receipts.RECEIPT_KIND ? receipt : null;
  } catch {
    return null;
  }
}

// The receipt kept for one commit: this repo's ref first, then origin's.
function readReceiptRef(root, sha, { fetch = true } = {}) {
  if (!/^[0-9a-f]{40,64}$/.test(String(sha || ''))) return null;
  const ref = refFor(sha);
  let receipt = readAtRef(root, ref);
  if (receipt) return { receipt, source: 'this repo' };
  if (!fetch || !hasOrigin(root)) return null;
  const fetched = git(root, ['fetch', '--quiet', '--no-tags', 'origin', `+${ref}:${ref}`], { timeout: 30000 });
  if (!fetched.ok) return null;
  receipt = readAtRef(root, ref);
  return receipt ? { receipt, source: 'origin' } : null;
}

function isAncestor(root, older, newer) {
  return spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd: root }).status === 0;
}

// Receipt refs go once their commit has been on the default branch 7 days,
// and any that is 30 days old (a receipt can be made again; work cannot).
function sweepReceiptRefs(root, { target, now = Date.now(), landedDays = LANDED_DAYS, maxDays = MAX_DAYS } = {}) {
  const origin = hasOrigin(root);
  if (origin) git(root, ['fetch', '--quiet', '--no-tags', '--prune', 'origin', `+${PREFIX}*:${PREFIX}*`], { timeout: 60000 });
  const rows = git(root, ['for-each-ref', '--format=%(refname) %(committerdate:unix)', PREFIX]).out
    .split('\n').filter(Boolean).map((line) => {
      const [ref, when] = line.split(' ');
      return { ref, sha: ref.slice(PREFIX.length), days: (now / 1000 - Number(when)) / 86400 };
    });
  let removed = 0;
  let kept = 0;
  for (const row of rows) {
    const known = git(root, ['cat-file', '-e', `${row.sha}^{commit}`]).ok;
    const landed = known && target && isAncestor(root, row.sha, target);
    if (!((landed && row.days > landedDays) || row.days > maxDays)) { kept += 1; continue; }
    if (origin) {
      const gone = git(root, ['push', '--quiet', 'origin', `:${row.ref}`], { timeout: 60000 });
      if (!gone.ok) { kept += 1; continue; }
    }
    git(root, ['update-ref', '-d', row.ref]);
    removed += 1;
  }
  return { removed, kept };
}

module.exports = { PREFIX, refFor, storeReceipt, publishReceipt, readReceiptRef, sweepReceiptRefs, LANDED_DAYS, MAX_DAYS };
