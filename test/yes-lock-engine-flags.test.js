'use strict';

// 3.74.0 to 3.74.2 held every member woken by a handoff within minutes: the
// engines harden their own git calls with -c flags that only switch things
// off, and run reads, index plumbing, git init, and a branch push the
// allowlist did not name. test/fixtures/held-by-lock-20261023.json is every
// real command that was held (67), with the repo path replaced by <repo>.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const yesLock = require('../lib/yes-lock');

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
for (const k of Object.keys(GIT_ENV)) if (/^GIT_CONFIG/.test(k)) delete GIT_ENV[k];
const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const HELD = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'held-by-lock-20261023.json'), 'utf8'));

function world(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yes-engine-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const origin = path.join(base, 'origin.git');
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, env: GIT_ENV, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  git('init', '-q', '-b', 'master');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'master');
  git('checkout', '-q', '-b', 'feature');
  const seal = yesLock.handoffSeal();
  yesLock.writeYesLocks(stateDir, 'm-woken', { seal });
  const verdict = (tool, args) => yesLock.check({ stateDir, missionId: 'm-woken', seal, tool, args, gitBin, cwd: root, env: GIT_ENV });
  return { root, verdict };
}

const held = v => Boolean(v && v.hold);
const runs = v => !v || (!v.hold && !v.consume);

test('every command the engines ran on 2026-10-23 runs in a woken run', (t) => {
  const w = world(t);
  assert.equal(HELD.length, 67);
  const stillHeld = [];
  for (const row of HELD) {
    const args = row.args.map(a => a.split('<repo>').join(w.root));
    const v = w.verdict(row.tool, args);
    if (!runs(v)) stillHeld.push(`${row.tool} ${args.join(' ').slice(-160)}: ${v.message}`);
  }
  assert.deepEqual(stillHeld, []);
});

test('the branch push the engines ran goes to a branch, written out in full', (t) => {
  const w = world(t);
  const v = w.verdict('git', ['push', 'origin', 'HEAD:codex/validator-fix']);
  assert.deepEqual(v.args.slice(-2), ['origin', 'HEAD:refs/heads/codex/validator-fix']);
  for (const args of [['push', 'origin', 'HEAD:master'], ['push', 'origin', 'HEAD:refs/tags/v1'], ['push', 'origin', 'HEAD:@{-1}'], ['push', 'origin', 'HEAD:Master']]) {
    assert.ok(held(w.verdict('git', args)), args.join(' '));
  }
});

test('a -c that only turns something off runs; one that names a program, path, or route is held', (t) => {
  const w = world(t);
  for (const args of [['-c', 'core.hooksPath=/dev/null', 'status'], ['-c', 'core.fsmonitor=', 'status'], ['-c', 'core.fsmonitor=false', 'status'],
    ['-c', 'hook.pre-commit.enabled=false', 'commit', '-m', 'x'], ['-c', 'format.pretty=medium', 'log'], ['-c', 'color.ui=never', 'log'],
    ['init', '-q', '-b', 'master'], ['update-index', '--refresh'], ['write-tree']]) {
    assert.ok(runs(w.verdict('git', args)), args.join(' '));
  }
  for (const args of [['-c', 'core.hooksPath=/tmp/hooks', 'commit', '-m', 'x'], ['-c', 'core.fsmonitor=git push origin HEAD:refs/heads/master; false', 'status'],
    ['-c', 'core.pager=less', 'log'], ['-c', 'core.sshCommand=ssh -i k', 'fetch'], ['-c', 'hook.pre-commit.command=./x', 'commit', '-m', 'x'],
    ['-c', 'url.https://example.com/.insteadOf=', 'status'], ['-c', 'alias.st=', 'status'], ['-c', 'credential.helper=store', 'status'],
    ['-c', 'remote.origin.pushurl=', 'status'], ['-c', 'push.followTags=true', 'push', 'origin', 'feature'], ['-c', 'include.path=/tmp/x', 'status'],
    ['-c', 'core.editor=vim', 'commit'], ['init', '--template=/tmp/t'], ['init', '--separate-git-dir=/tmp/g']]) {
    assert.ok(held(w.verdict('git', args)), args.join(' '));
  }
  assert.ok(runs(w.verdict('atris', ['atris.md'])), 'the boot read runs');
  assert.ok(held(w.verdict('atris', ['atris.md', 'publish'])), 'only the boot read');
});
