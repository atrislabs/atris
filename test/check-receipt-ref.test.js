'use strict';

// atris check --push keeps the receipt as a small git ref next to the staged
// change, so it outlives the work copy and reaches the lander. A local bare
// repo stands in for GitHub; no network, nothing on screen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkCommand } = require('../commands/check');
const { readReceiptRef, storeReceipt, refFor, PREFIX } = require('../lib/check-receipt-ref');
const { recheckReceipt } = require('../lib/check-recompute');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function configure(root) {
  for (const [key, value] of [['user.email', 'check@example.test'], ['user.name', 'check test'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) git(root, 'config', key, value);
}

const MAP = {
  checks: {
    lint: { run: 'node ok.js', always: true, seconds: 1 },
    feature: { run: 'node ok.js', when: ['src/**'] },
    app: { run: 'node ok.js', where: 'no-screen', when: ['src/**'] },
    full: { run: 'node ok.js' },
  },
  risk: { low: ['**/*.md'] },
  gates: { release: ['lint', 'full'] },
  default: ['full'],
};

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-receipt-ref-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  const root = path.join(dir, 'work');
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=master', remote);
  git(dir, 'init', '--quiet', '--initial-branch=master', root);
  configure(root);
  git(root, 'remote', 'add', 'origin', remote);
  write(root, 'ok.js', 'process.exit(0);\n');
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 1;\n};\n');
  write(root, 'proof.test.js', "const assert = require('assert');\nassert.ok(require('./src/feature')() >= 1);\n");
  write(root, 'atris/checks.json', JSON.stringify(MAP, null, 2));
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'start');
  git(root, 'push', '--quiet', 'origin', 'master');
  git(root, 'remote', 'set-head', 'origin', 'master');
  git(root, 'switch', '--quiet', '-c', 'feature');
  return { dir, root, remote };
}

async function check(root, args) {
  const lines = [];
  const saved = process.env.ATRIS_CHECK_PERSON;
  process.env.ATRIS_CHECK_PERSON = '1';
  try {
    const code = await checkCommand(args, { cwd: root, log: (line) => lines.push(String(line)) });
    return { code, out: lines.join('\n') };
  } finally {
    if (saved === undefined) delete process.env.ATRIS_CHECK_PERSON; else process.env.ATRIS_CHECK_PERSON = saved;
  }
}

test('a staged push keeps its receipt on origin as refs/atris/receipts/<sha>, and a fresh clone reads it back and verifies it', async (t) => {
  const { dir, root, remote } = project(t);
  write(root, 'src/feature.js', 'module.exports = function feature() {\n  return 2;\n};\n');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'Feature two\n\nProof: node proof.test.js');
  const pushed = await check(root, ['push']);
  assert.equal(pushed.code, 3, pushed.out);
  const sha = git(root, 'rev-parse', 'HEAD');
  assert.match(pushed.out, new RegExp(`receipt: kept on origin as ${refFor(sha)}`));
  assert.equal(git(remote, 'for-each-ref', '--format=%(refname)', PREFIX), refFor(sha));
  // Not a branch: nothing under refs/heads names it.
  assert.doesNotMatch(git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/'), /receipts/);
  // The work copy goes; another clone (the lander elsewhere) fetches it.
  fs.rmSync(path.join(root, '.atris'), { recursive: true, force: true });
  const lander = path.join(dir, 'lander');
  git(dir, 'clone', '--quiet', remote, lander);
  configure(lander);
  git(lander, 'fetch', '--quiet', 'origin', `refs/heads/atris/ready/${sha.slice(0, 12)}`);
  git(lander, 'checkout', '--quiet', '--detach', sha);
  const found = readReceiptRef(lander, sha);
  assert.ok(found, 'fetched from origin');
  assert.equal(found.source, 'origin');
  assert.equal(found.receipt.head_sha, sha);
  const checked = recheckReceipt(lander, found.receipt, { sha, trustLane: false });
  assert.equal(checked.ok, true, checked.why);
  assert.equal(checked.verdict, 'partly', 'the no-screen check still needs its lane');
  assert.equal(readReceiptRef(lander, 'f'.repeat(40)), null, 'no receipt for an unknown commit');
});

test('sweep removes a receipt ref whose commit has been on the default branch over 7 days, and keeps a young one', async (t) => {
  const { root, remote } = project(t);
  const landed = git(root, 'rev-parse', 'master');
  const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
  const receipt = (sha) => ({ kind: 'atris.check.v1', head_sha: sha, tree: git(root, 'rev-parse', `${sha}^{tree}`), checks: [], verdict: 'proven' });
  const saved = process.env.GIT_COMMITTER_DATE;
  process.env.GIT_COMMITTER_DATE = old;
  let stored;
  try { stored = storeReceipt(root, receipt(landed)); } finally { if (saved === undefined) delete process.env.GIT_COMMITTER_DATE; else process.env.GIT_COMMITTER_DATE = saved; }
  git(root, 'push', '--quiet', 'origin', `${stored.commit}:${stored.ref}`);
  write(root, 'src/feature.js', 'module.exports = 7;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'young');
  const young = git(root, 'rev-parse', 'HEAD');
  const fresh = storeReceipt(root, receipt(young));
  git(root, 'push', '--quiet', 'origin', `${fresh.commit}:${fresh.ref}`);
  const result = await check(root, ['sweep']);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /removed 1 receipt ref/);
  assert.equal(git(remote, 'for-each-ref', '--format=%(refname)', PREFIX), refFor(young));
});
