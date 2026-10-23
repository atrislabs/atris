'use strict';

// 3.74.4 froze the team again: 479 more harmless commands were held, from
// test suites making scratch repos and from reads in the job's own
// worktree. A run woken by a handoff now guards only git push (and the -c
// and environment that could run a push past the wrapper); every other git
// command passes, since nothing local publishes anything and landing goes
// through origin/master. atris holds only the outward and spend verbs.
// Both fixtures are every real held command, with repo paths as <repo>.

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
const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

// A repo on a feature branch. origin is a bare repo on disk; `network`
// points origin at a network URL instead (nothing is pushed in these tests).
function world(t, { network = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yes-push-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const origin = path.join(base, 'origin.git');
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, env: GIT_ENV, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin]);
  git('init', '-q', '-b', 'master');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  git('tag', 'v1');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'master');
  git('checkout', '-q', '-b', 'feature');
  if (network) git('remote', 'set-url', 'origin', 'git@github.com:example/repo.git');
  const seal = yesLock.handoffSeal();
  yesLock.writeYesLocks(stateDir, 'm-woken', { seal });
  const verdict = (tool, args, env = GIT_ENV) => yesLock.check({ stateDir, missionId: 'm-woken', seal, tool, args, gitBin, cwd: root, env });
  return { base, root, git, verdict };
}

const held = v => Boolean(v && v.hold);
const runs = v => !v || (!v.hold && !v.consume);

test('every command held on 2026-10-23, both rounds, runs in a woken run', (t) => {
  const w = world(t, { network: true });
  const rows = [...fixture('held-by-lock-20261023.json'), ...fixture('held-by-lock-20261023-round2.json')];
  assert.equal(rows.length, 67 + 479);
  const stillHeld = [];
  for (const row of rows) {
    const args = row.args.map(a => a.split('<repo>').join(w.root));
    const v = w.verdict(row.tool, args);
    if (!runs(v)) stillHeld.push(`${row.tool} ${args.join(' ').slice(-140)}: ${v.message}`);
  }
  assert.deepEqual(stillHeld, []);
});

test('a push to a remote on disk runs as written: tests push tags and master to scratch repos', (t) => {
  const w = world(t);
  for (const args of [['push', 'origin', 'master'], ['push', 'origin', 'v1'], ['push', '--tags', 'origin'], ['push', '--mirror', 'origin'], ['push', w.base + '/origin.git', 'HEAD:master']]) {
    const v = w.verdict('git', args);
    assert.equal(v, null, args.join(' '));
  }
});

test('a push to a network remote runs only as a branch push that is not master', (t) => {
  const w = world(t, { network: true });
  const v = w.verdict('git', ['push', '-u', 'origin', 'HEAD:codex/fix']);
  assert.ok(v.args.includes('--no-follow-tags') && v.args.includes('push.followTags=false') && v.args.includes('remote.origin.mirror=false'), JSON.stringify(v));
  assert.deepEqual(v.args.slice(-2), ['origin', 'HEAD:refs/heads/codex/fix']);
  for (const args of [['push', 'origin', 'feature'], ['push', 'origin', 'HEAD'], ['push', '--force', 'origin', 'feature'], ['push', 'origin', '+feature'],
    ['push', 'origin', 'feature:other'], ['push', 'origin', '--delete', 'old-branch'], ['push', 'origin', 'feature', 'other']]) {
    assert.ok(runs(w.verdict('git', args)), args.join(' '));
  }
  for (const args of [['push', 'origin', 'master'], ['push', 'origin', 'HEAD:master'], ['push', 'origin', 'HEAD:refs/heads/master'], ['push', 'origin', 'feature:Master'],
    ['push', 'origin', 'v1'], ['push', 'origin', 'refs/tags/v1'], ['push', 'origin', 'HEAD:refs/tags/v2'], ['push', '--tags', 'origin'], ['push', '--follow-tags', 'origin', 'feature'],
    ['push', '--all', 'origin'], ['push', '--mirror', 'origin'], ['push', 'origin', '--delete', 'master'], ['push', 'origin', ':master'], ['push', 'origin', 'refs/heads/*:refs/heads/*'],
    ['push', 'origin', ':'], ['push', '--prune', 'origin', 'feature'], ['push', 'origin', 'HEAD:@{-1}']]) {
    assert.ok(held(w.verdict('git', args)), args.join(' '));
  }
  w.git('config', 'remote.origin.mirror', 'true');
  assert.ok(held(w.verdict('git', ['push', 'origin', 'feature'])), 'origin set up as a mirror pushes everything');
});

test('local git passes in a woken run; -c and environment that could run a push past the wrapper are held when git reaches a network remote', (t) => {
  const w = world(t, { network: true });
  for (const args of [['checkout', 'master'], ['branch', '-f', 'master', 'HEAD'], ['tag', 'v2'], ['symbolic-ref', 'refs/heads/master', 'refs/heads/feature'], ['reset', '--hard', 'master'],
    ['merge', 'master'], ['config', 'user.email', 'test@example.com'], ['remote', 'add', 'other', 'git@github.com:o/r.git'], ['init', '--template=/tmp/t'], ['--exec-path'],
    ['-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'x'], ['fetch', 'origin', 'feature:master']]) {
    assert.ok(runs(w.verdict('git', args)), args.join(' '));
  }
  for (const pre of [['-c', 'core.fsmonitor=git push origin HEAD:refs/heads/master; false'], ['-c', 'core.pager=less'], ['--exec-path=/tmp'], ['--config-env=core.pager=P']]) {
    assert.ok(held(w.verdict('git', [...pre, 'push', 'origin', 'feature'])), `${pre.join(' ')} push`);
    assert.ok(held(w.verdict('git', [...pre, 'fetch', 'origin'])), `${pre.join(' ')} fetch`);
    assert.ok(runs(w.verdict('git', [...pre, 'status'])), `local work passes: ${pre.join(' ')}`);
  }
  assert.ok(held(w.verdict('git', ['push', 'origin', 'feature'], { ...GIT_ENV, GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='x'" })));
  assert.ok(runs(w.verdict('git', ['status'], { ...GIT_ENV, GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='x'" })));
});

test('atris holds only the outward and spend verbs in a woken run', (t) => {
  const w = world(t);
  for (const args of [['task', 'list'], ['frobnicate'], ['fix', 'the', 'bug'], ['member', 'run', 'builder', 'x'], ['mission', 'start', 'x'], ['log', 'sync'], ['engine', 'dispatch', 'x'],
    ['youtube', 'search', 'topic'], ['wish', 'x'], ['task', 'review-lane-run'], ['atris.md']]) {
    assert.ok(runs(w.verdict('atris', args)), args.join(' '));
  }
  for (const args of [['business', 'status'], ['business', 'deploy', 'acme'], ['site', 'publish'], ['site', 'status'], ['pay', 'vendor', '5'], ['feed'], ['feed', 'post', 'x'],
    ['deploy'], ['release'], ['publish'], ['land'], ['autoland'], ['merge'], ['accept'], ['spend'], ['task', 'accept', 'T1'], ['task', 'auto-accept-certified'],
    ['task', 'accept-group', 'g'], ['task', 'sweep', '--auto-accept'], ['task', 'landing', '--accept'], ['approve', '1'], ['x-search', 'q'], ['youtube', 'search', '--paid', 'q'], ['buy', 'x']]) {
    assert.ok(held(w.verdict('atris', args)), args.join(' '));
  }
});

// A yes card is read by the owner on the phone: who, what goes out, and
// where, in plain words. The raw command stays in the lock record.
test('a yes card says who wants what to go where, never the raw command', (t) => {
  const w = world(t, { network: true });
  const stateDir = path.join(w.base, 'cards');
  const seal = yesLock.handoffSeal();
  yesLock.writeYesLocks(stateDir, 'm-builder', { seal, owner: 'builder' });
  w.git('checkout', '-q', '-b', 'builder-job-deck-20261023-102420');
  fs.writeFileSync(path.join(w.root, 'package.json'), JSON.stringify({ name: 'atris', version: '1.0.0' }));
  const hold = (tool, args) => yesLock.check({ stateDir, missionId: 'm-builder', seal, tool, args, gitBin, cwd: w.root, env: GIT_ENV });
  const commands = [
    ['git', ['-c', 'core.askPass=', '-c', 'protocol.ext.allow=never', '-c', 'core.sshCommand=ssh -i k', 'fetch', 'origin']],
    ['git', ['push', '--prune', 'origin', 'builder-job-deck-20261023-102420']],
    ['git', ['push', 'origin', 'HEAD:master']],
    ['git', ['push', '--tags', 'origin']],
    ['gh', ['pr', 'merge', '5', '--squash']],
    ['npm', ['publish', '--access', 'public']],
    ['npx', ['vercel', 'deploy']],
    ['atris', ['x-search', 'competitors']],
    ['atris', ['business', 'deploy', 'acme']],
  ];
  for (const [tool, args] of commands) assert.ok(hold(tool, args).hold, `${tool} ${args.join(' ')}`);
  const cards = yesLock.handoffYesCards(stateDir).filter(c => c.mission_id === 'm-builder');
  assert.equal(cards.length, commands.length);
  for (const c of cards) {
    assert.match(c.ask, /^builder wants to [a-z]/, c.ask);
    assert.doesNotMatch(c.ask, /(^|\s)-{1,2}[A-Za-z]|=|\/|\\/, `no flag, setting, or path: ${c.ask}`);
    assert.doesNotMatch(c.ask, /\b(git|gh|npx|npm publish)\b/, `no command words: ${c.ask}`);
  }
  const asks = cards.map(c => c.ask);
  assert.ok(asks.includes('builder wants to push its job deck branch to GitHub'), asks.join('\n'));
  assert.ok(asks.includes('builder wants to publish atris to npm'), asks.join('\n'));
  assert.ok(asks.includes('builder wants to push to master on GitHub'), asks.join('\n'));
  assert.ok(cards.every(c => c.command && c.command.length), 'the raw command is still on record');
});
