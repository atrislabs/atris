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
const pr = {number:41,url:'https://example.test/pull/41',baseRefName:'master',title:'Check combined changes',headRefName:'feature',headRefOid:fs.existsSync(process.env.HEAD_FILE) ? fs.readFileSync(process.env.HEAD_FILE,'utf8').trim() : process.env.SOURCE,headRepositoryOwner:{login:'example'},autoMergeRequest:process.env.AUTO === '1' ? {enabledAt:'today'} : null};
if (args[1] === 'list') console.log(JSON.stringify(process.env.OPEN === '1' && !merged ? [pr] : []));
else if (args[1] === 'view' && args.includes('--jq')) console.log('41 https://example.test/pull/41 OPEN');
else if (args[1] === 'view') console.log(JSON.stringify({...pr,state:merged && process.env.PR_PENDING !== '1' ? 'MERGED' : 'OPEN',mergedAt:merged && process.env.PR_PENDING !== '1' ? '2026-10-31T00:00:00Z' : null,mergeCommit:merged ? {oid:git(['rev-parse','master']).stdout.trim()} : null}));
else if (args[1] === 'merge') process.exit(0);
else process.exit(1);
`, { mode: 0o755 });
  const env = { ...scrubAgentEnv(), PATH: `${bin}${path.delimiter}${process.env.PATH}`, GH_LOG: ghLog, REMOTE: remote, PRIMARY: primary, SOURCE: source, HEAD_FILE: path.join(dir, 'pr-head'), EVENTS: events, AUTO: auto ? '1' : '0', OPEN: open ? '1' : '0', ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_WORKTREE_KEEP_AFTER_SHIP: '1' };
  const ship = (args, verify = 'printf "verify:%s\\n" "$(git rev-parse HEAD)" >> "$EVENTS"', extra = {}) => spawnSync(process.execPath, [CLI, 'worktree', 'ship', '--message', 'feature change', '--verify', verify, '--no-map-refresh', ...args], { cwd: work, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  return { dir, primary, work, remote, events, ghLog, git, source, base, ship, env };
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

test('a noisy failing gate prints at most four kilobytes', (t) => {
  const gate = `#!/bin/sh\n"${process.execPath}" -e 'process.stdout.write("x".repeat(100000),()=>process.exitCode=19)'\n`;
  const c = fixture(t, { gate });
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exit code 19/);
  assert.ok(Buffer.byteLength(result.stderr) < 4600, `diagnostic was ${Buffer.byteLength(result.stderr)} bytes`);
});

test('a changed local target is rechecked before the candidate lands', (t) => {
  const gate = `#!/bin/sh\n${marker}if test ! -f "$EVENTS.moved"; then\n  touch "$EVENTS.moved"\n  old=$(git rev-parse refs/heads/master)\n  tree=$(git rev-parse refs/heads/master^{tree})\n  next=$(git commit-tree "$tree" -p "$old" -m moved)\n  git update-ref refs/heads/master "$next" "$old"\nfi\n`;
  const c = fixture(t, { gate });
  const result = c.ship(localArgs);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const landed = c.git(['rev-parse', 'master']);
  const events = fs.readFileSync(c.events, 'utf8').trim().split('\n');
  assert.equal(events.length, 4);
  assert.equal(events[2], `verify:${landed}`);
  assert.equal(events[3], `gate:${landed}`);
  assert.notEqual(events[0], events[2]);
  assert.equal(c.git(['status', '--porcelain'], c.primary), '');
});

test('a target that keeps moving stops after three checked candidates', (t) => {
  const c = fixture(t, { gate: pass });
  const hooks = path.join(c.dir, 'hooks');
  fs.mkdirSync(hooks);
  c.git(['config', 'core.hooksPath', hooks]);
  fs.writeFileSync(path.join(hooks, 'pre-push'), `#!/bin/sh\nold=$(git --git-dir "$REMOTE" rev-parse master)\ntree=$(git --git-dir "$REMOTE" rev-parse master^{tree})\nnext=$(git --git-dir "$REMOTE" -c user.name=Test -c user.email=test@example.com commit-tree "$tree" -p "$old" -m moved)\ngit --git-dir "$REMOTE" update-ref refs/heads/master "$next" "$old"\n`, { mode: 0o755 });
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /target kept moving.*left unmerged/);
  assert.equal(fs.readFileSync(c.events, 'utf8').trim().split('\n').length, 6);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'feature'], c.dir), c.source);
  const landed = spawnSync('git', ['--git-dir', c.remote, 'merge-base', '--is-ancestor', c.source, 'master']);
  assert.notEqual(landed.status, 0);
});

test('an armed review push is refused when the gate exists only on the target', (t) => {
  const c = fixture(t, { gate: pass, targetOnly: true, auto: true });
  const result = c.ship(['--no-pr']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /auto-merge/);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'feature'], c.dir), c.source);
});

for (const local of [false, true]) {
  test(`${local ? 'local' : 'remote'} allows a successful gate with five megabytes of output`, (t) => {
    const gate = `#!/bin/sh\n"${process.execPath}" -e 'process.stdout.write("x".repeat(5*1024*1024))'\n`;
    const c = fixture(t, { gate });
    const result = c.ship(local ? localArgs : ['--merge']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /merge gate: passed/);
  });
}

test('gate failure reports no more than the last forty lines', (t) => {
  const gate = '#!/bin/sh\ni=1\nwhile test "$i" -le 60; do echo "gate-line-$i"; i=$((i + 1)); done\nexit 19\n';
  const c = fixture(t, { gate });
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gate-line-60/);
  assert.doesNotMatch(result.stderr, /gate-line-20(?:\n|$)/);
  assert.equal((result.stderr.match(/gate-line-/g) || []).length, 40);
});

test('an existing push hook can reject the checked landing', (t) => {
  const c = fixture(t, { gate: pass });
  const hooks = path.join(c.dir, 'hooks');
  fs.mkdirSync(hooks);
  c.git(['config', 'core.hooksPath', hooks]);
  fs.writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\necho hook refused >&2\nexit 41\n', { mode: 0o755 });
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hook refused/);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), c.base);
});

test('a gate cannot move the source branch during the check', (t) => {
  const gate = '#!/bin/sh\nold=$(git rev-parse refs/heads/feature)\ntree=$(git rev-parse "$old^{tree}")\nnext=$(git commit-tree "$tree" -p "$old" -m moved)\ngit update-ref refs/heads/feature "$next" "$old"\n';
  const c = fixture(t, { gate });
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /branch moved during the check/);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), c.base);
});


test('a gate cannot leave new conductor files behind', (t) => {
  const c = fixture(t, { gate: '#!/bin/sh\necho changed > .codex-last-message.txt\n' });
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /changed files.*\.codex-last-message\.txt/);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), c.base);
});

test('a pull request head that moves during the gate stops the landing', (t) => {
  const gate = '#!/bin/sh\ntree=$(git rev-parse HEAD^{tree})\ngit commit-tree "$tree" -p "$SOURCE" -m changed > "$HEAD_FILE"\n';
  const c = fixture(t, { gate });
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /pull request.*changed|pull request.*moved/);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), c.base);
});

test('a passing check with no pull request lands without creating one', (t) => {
  const c = fixture(t, { gate: pass, open: false });
  const result = c.ship(['--merge']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const landed = c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir);
  assert.deepEqual(fs.readFileSync(c.events, 'utf8').trim().split('\n'), [`verify:${landed}`, `gate:${landed}`]);
  assert.doesNotMatch(fs.readFileSync(c.ghLog, 'utf8'), /\"create\"|\"merge\"/);
});

test('a gate cannot alter a pre-existing conductor file', (t) => {
  const c = fixture(t, { gate: '#!/bin/sh\necho altered > .codex-last-message.txt\n' });
  fs.writeFileSync(path.join(c.work, '.codex-last-message.txt'), 'original\n');
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /changed files.*\.codex-last-message\.txt/);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), c.base);
});


for (const local of [false, true]) {
  test(`${local ? 'local' : 'remote'} notices a gate added to the target during verification`, (t) => {
    const c = fixture(t);
    const verify = 'if ! test -f ../added; then mkdir -p "$PRIMARY/scripts"; printf "#!/bin/sh\\necho late gate >&2\\nexit 57\\n" > "$PRIMARY/scripts/merge-gate.sh"; git -C "$PRIMARY" add scripts/merge-gate.sh; git -C "$PRIMARY" commit -qm "add gate"; git -C "$PRIMARY" push -q origin master; touch ../added; fi';
    const result = c.ship(local ? localArgs : ['--merge'], verify);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /late gate/);
    assert.match(result.stderr, /left unmerged/);
    assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'feature'], c.dir), c.source);
  });
}

test('a review push checks auto-merge if verification adds a gate to the target', (t) => {
  const c = fixture(t, { auto: true });
  const verify = 'mkdir -p "$PRIMARY/scripts"; printf "#!/bin/sh\\nexit 0\\n" > "$PRIMARY/scripts/merge-gate.sh"; git -C "$PRIMARY" add scripts/merge-gate.sh; git -C "$PRIMARY" commit -qm "add gate"; git -C "$PRIMARY" push -q origin master';
  fs.writeFileSync(path.join(c.work, 'a.txt'), 'newer\n');
  const result = c.ship(['--no-pr'], verify);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /auto-merge/);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'feature'], c.dir), c.source);
});


test('a changed checkout after verification stops before the gate', (t) => {
  const c = fixture(t, { gate: pass });
  const result = c.ship(['--merge'], 'echo dirty >> a.txt');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /verifier changed.*a\.txt/);
  assert.equal(fs.existsSync(c.events), false);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), c.base);
});

test('a landed commit without pull request confirmation keeps the source branch', (t) => {
  const c = fixture(t, { gate: pass });
  const result = c.ship(['--merge'], undefined, { PR_PENDING: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /commit landed.*could not be confirmed.*source branch was kept/);
  const target = c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir);
  assert.notEqual(target, c.base);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'feature'], c.dir), c.source);
  assert.doesNotMatch(result.stdout, /done: worktree shipped/);
});

test('an ignored local file cannot replace a gate removed from the candidate', (t) => {
  const c = fixture(t, { gate: pass });
  c.git(['rm', 'scripts/merge-gate.sh'], c.work);
  fs.appendFileSync(path.join(c.work, '.gitignore'), 'scripts/merge-gate.sh\n');
  c.git(['add', '.gitignore'], c.work);
  c.git(['commit', '-qm', 'remove gate'], c.work);
  fs.mkdirSync(path.join(c.work, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(c.work, 'scripts', 'merge-gate.sh'), '#!/bin/sh\nexit 0\n');
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /gate.*missing|gate.*commit/);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), c.base);
});

test('a gate symlink cannot run a file outside the checked repository', (t) => {
  const c = fixture(t, { gate: pass });
  const outside = path.join(c.dir, 'outside-gate');
  fs.writeFileSync(outside, '#!/bin/sh\nexit 0\n');
  fs.unlinkSync(path.join(c.primary, 'scripts', 'merge-gate.sh'));
  fs.symlinkSync(outside, path.join(c.primary, 'scripts', 'merge-gate.sh'));
  c.git(['add', 'scripts/merge-gate.sh']);
  c.git(['commit', '-qm', 'replace gate with link']);
  c.git(['push', 'origin', 'master']);
  const expected = c.git(['rev-parse', 'master']);
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /gate.*outside|gate.*commit/);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), expected);
});

test('a gate symlink may point to another file in the checked commit', (t) => {
  const c = fixture(t, { gate: pass });
  fs.writeFileSync(path.join(c.primary, 'actual-gate.sh'), pass);
  fs.unlinkSync(path.join(c.primary, 'scripts', 'merge-gate.sh'));
  fs.symlinkSync('../actual-gate.sh', path.join(c.primary, 'scripts', 'merge-gate.sh'));
  c.git(['add', 'actual-gate.sh', 'scripts/merge-gate.sh']);
  c.git(['commit', '-qm', 'link the checked gate']);
  c.git(['push', 'origin', 'master']);
  const result = c.ship(['--merge']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /merge gate: passed/);
  const landed = c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir);
  assert.deepEqual(fs.readFileSync(c.events, 'utf8').trim().split('\n'), [`verify:${landed}`, `gate:${landed}`]);
});

test('local landing can switch a clean primary checkout to its target', (t) => {
  const c = fixture(t, { gate: pass });
  c.git(['switch', '-qc', 'other']);
  const result = c.ship(localArgs);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(c.git(['branch', '--show-current']), 'master');
  const landed = c.git(['rev-parse', 'master']);
  assert.deepEqual(fs.readFileSync(c.events, 'utf8').trim().split('\n'), [`verify:${landed}`, `gate:${landed}`]);
});


test('a map refresh cannot change a source tree bound to independent review', (t) => {
  const c = fixture(t, { gate: pass });
  fs.mkdirSync(path.join(c.work, 'atris'));
  fs.writeFileSync(path.join(c.work, 'src.js'), '\n'.repeat(10) + 'function knownSymbol() {}\n');
  fs.writeFileSync(path.join(c.work, 'atris', 'MAP.md'), 'see `src.js:1` (`knownSymbol`)\n');
  c.git(['add', 'src.js', 'atris/MAP.md'], c.work);
  c.git(['commit', '-qm', 'reviewed tree'], c.work);
  const commit = c.git(['rev-parse', 'HEAD'], c.work);
  const tree = c.git(['rev-parse', 'HEAD^{tree}'], c.work);
  const ref = `refs/atris/one-lap/${commit}`;
  c.git(['update-ref', ref, commit], c.work);
  c.git(['config', 'branch.feature.atris-proof-ref', ref], c.work);
  fs.mkdirSync(path.join(c.work, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(c.work, '.atris', 'agent-worktree.json'), JSON.stringify({one_lap_proof:{ref,commit,tree}}));
  const result = spawnSync(process.execPath, [CLI, 'worktree', 'ship', '--message', 'reviewed tree', '--verify', 'true', '--merge'],
    {cwd:c.work, env:c.env, encoding:'utf8', timeout:30000});
  assert.equal(result.status, 3, result.stderr || result.stdout);
  assert.match(result.stdout, /map: refreshed/);
  assert.match(result.stderr, /one-lap head tree differs/);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), c.base);
});
