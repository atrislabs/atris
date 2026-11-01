'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');

function fixture(t, { gate = null, targetOnly = false, auto = false, open = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-candidate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const primary = path.join(dir, 'primary');
  const work = path.join(dir, 'work');
  const remote = path.join(dir, 'remote.git');
  const bin = path.join(dir, 'bin');
  const events = path.join(dir, 'events');
  const ghLog = path.join(dir, 'gh.log');
  fs.mkdirSync(primary);
  fs.mkdirSync(bin);
  const git = (args, cwd = primary) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git(['init', '--bare', '-q', remote]);
  git(['init', '-q']);
  git(['config', 'user.name', 'Test User']);
  git(['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(primary, '.gitignore'), '.atris/\n');
  fs.writeFileSync(path.join(primary, 'a.txt'), 'old\n');
  fs.writeFileSync(path.join(primary, 'b.txt'), 'old\n');
  if (gate && !targetOnly) {
    fs.mkdirSync(path.join(primary, 'scripts'));
    fs.writeFileSync(path.join(primary, 'scripts', 'merge-gate.sh'), gate);
  }
  git(['add', '.']);
  git(['commit', '-qm', 'initial']);
  git(['branch', '-M', 'master']);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-u', 'origin', 'master']);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master']);
  git(['worktree', 'add', '-qb', 'feature', work, 'master']);
  fs.writeFileSync(path.join(work, 'a.txt'), 'new\n');
  git(['add', 'a.txt'], work);
  git(['commit', '-qm', 'feature change'], work);
  const source = git(['rev-parse', 'HEAD'], work);
  git(['push', 'origin', 'HEAD:refs/heads/feature'], work);
  if (targetOnly) {
    fs.mkdirSync(path.join(primary, 'scripts'));
    fs.writeFileSync(path.join(primary, 'scripts', 'merge-gate.sh'), gate);
  }
  fs.writeFileSync(path.join(primary, 'b.txt'), 'new\n');
  git(['add', '.']);
  git(['commit', '-qm', 'advance target']);
  git(['push', 'origin', 'master']);
  const base = git(['rev-parse', 'master']);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
const git = (a) => spawnSync('git', ['--git-dir', process.env.REMOTE, ...a], {encoding:'utf8'});
const merged = git(['merge-base', '--is-ancestor', 'feature', 'master']).status === 0;
const pr = {number:41,url:'https://example.test/pull/41',baseRefName:'master',title:'Check combined changes',headRefName:'feature',headRefOid:process.env.SOURCE,headRepositoryOwner:{login:'example'},autoMergeRequest:process.env.AUTO === '1' ? {enabledAt:'today'} : null};
if (args[1] === 'list') console.log(JSON.stringify(process.env.OPEN === '1' && !merged ? [pr] : []));
else if (args[1] === 'view' && args.includes('--jq')) console.log('41 https://example.test/pull/41 OPEN');
else if (args[1] === 'view') console.log(JSON.stringify({...pr,state:merged ? 'MERGED' : 'OPEN',mergedAt:merged ? '2026-10-31T00:00:00Z' : null,mergeCommit:merged ? {oid:git(['rev-parse','master']).stdout.trim()} : null}));
else if (args[1] === 'merge') process.exit(0);
else process.exit(1);
`, { mode: 0o755 });
  const env = { ...scrubAgentEnv(), PATH: `${bin}${path.delimiter}${process.env.PATH}`, GH_LOG: ghLog, REMOTE: remote, SOURCE: source, EVENTS: events, AUTO: auto ? '1' : '0', OPEN: open ? '1' : '0', ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_WORKTREE_KEEP_AFTER_SHIP: '1' };
  const ship = (args, verify = 'printf "verify:%s\\n" "$(git rev-parse HEAD)" >> "$EVENTS"', extra = {}) => spawnSync(process.execPath, [CLI, 'worktree', 'ship', '--message', 'feature change', '--verify', verify, '--no-map-refresh', ...args], { cwd: work, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  return { dir, primary, work, remote, events, ghLog, git, source, base, ship };
}

const marker = 'printf "gate:%s\\n" "$(git rev-parse HEAD)" >> "$EVENTS"\n';
const incompatible = '#!/bin/sh\n' + marker + 'if test "$(cat a.txt)" = new && test "$(cat b.txt)" = new; then echo incompatible >&2; exit 31; fi\n';
const pass = '#!/bin/sh\n' + marker + 'exit 0\n';
const localArgs = ['--local', '--merge', '--target', 'master'];

for (const local of [false, true]) {
  const name = local ? 'local' : 'remote';
  const args = local ? localArgs : ['--merge'];
  test(`${name} refuses the incompatible combined tree`, (t) => {
    const c = fixture(t, { gate: incompatible });
    const result = c.ship(args);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /incompatible/);
    assert.match(result.stderr, /left unmerged/);
    assert.equal(c.git(['rev-parse', 'master']), c.base);
    assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), c.base);
    assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'feature'], c.dir), c.source);
  });
  test(`${name} enforces a gate added only on the target`, (t) => {
    const c = fixture(t, { gate: '#!/bin/sh\necho target gate >&2\nexit 37\n', targetOnly: true });
    const result = c.ship(args);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /target gate/);
    assert.equal(c.git(['rev-parse', 'master']), c.base);
    assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), c.base);
  });
  test(`${name} verifies and lands the same combined merge commit`, (t) => {
    const c = fixture(t, { gate: pass });
    const result = c.ship(args, 'test "$(cat b.txt)" = new && printf "verify:%s\\n" "$(git rev-parse HEAD)" >> "$EVENTS"');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const landed = c.git(local ? ['rev-parse', 'master'] : ['--git-dir', c.remote, 'rev-parse', 'master'], local ? c.primary : c.dir);
    const events = fs.readFileSync(c.events, 'utf8').trim().split('\n');
    assert.deepEqual(events, [`verify:${landed}`, `gate:${landed}`]);
    assert.deepEqual(c.git(['show', '-s', '--format=%P', landed]).split(' '), [c.base, c.source]);
    assert.match(c.git(['show', '-s', '--format=%B', landed]), /Merge pull request #41/);
    assert.equal(c.git(['rev-parse', 'feature'], c.work), c.source);
  });
}

for (const noPr of [false, true]) {
  test(`review push refuses auto-merge${noPr ? ' with no-pr' : ''}`, (t) => {
    const c = fixture(t, { gate: pass, auto: true });
    const before = c.git(['--git-dir', c.remote, 'rev-parse', 'feature'], c.dir);
    fs.writeFileSync(path.join(c.work, 'a.txt'), 'newer\n');
    const result = c.ship(noPr ? ['--no-pr'] : []);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /auto-merge/);
    assert.match(result.stderr, /gated merge|turn auto-merge off/);
    assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'feature'], c.dir), before);
    assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), c.base);
  });
}

test('a review push fails closed when pull requests cannot be read', (t) => {
  const c = fixture(t, { gate: pass });
  fs.writeFileSync(path.join(c.dir, 'bin', 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = c.ship(['--no-pr']);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /cannot tell/);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'feature'], c.dir), c.source);
});

test('a changed target is rechecked before the remote candidate lands', (t) => {
  const c = fixture(t, { gate: pass });
  const hooks = path.join(c.dir, 'hooks');
  fs.mkdirSync(hooks);
  c.git(['config', 'core.hooksPath', hooks]);
  fs.writeFileSync(path.join(hooks, 'pre-push'), `#!/bin/sh\nif test ! -f "$EVENTS.moved"; then\n  touch "$EVENTS.moved"\n  old=$(git --git-dir "$REMOTE" rev-parse master)\n  tree=$(git --git-dir "$REMOTE" rev-parse master^{tree})\n  next=$(git --git-dir "$REMOTE" -c user.name=Test -c user.email=test@example.com commit-tree "$tree" -p "$old" -m moved)\n  git --git-dir "$REMOTE" update-ref refs/heads/master "$next" "$old"\nfi\n`, { mode: 0o755 });
  const result = c.ship(['--merge']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const landed = c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir);
  const events = fs.readFileSync(c.events, 'utf8').trim().split('\n');
  assert.equal(events.length, 4);
  assert.equal(events[2], `verify:${landed}`);
  assert.equal(events[3], `gate:${landed}`);
  assert.notEqual(events[0], events[2]);
});

test('a successful noisy gate is allowed and failure output stays below four kilobytes', (t) => {
  const gate = `#!/bin/sh\n"${process.execPath}" -e 'process.stdout.write("x".repeat(100000),()=>process.exitCode=19)'\n`;
  const c = fixture(t, { gate });
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exit code 19/);
  assert.ok(Buffer.byteLength(result.stderr) < 4600, `diagnostic was ${Buffer.byteLength(result.stderr)} bytes`);
});
