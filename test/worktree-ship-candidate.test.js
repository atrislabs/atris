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

test('local landing works without a pull request service for a local remote', (t) => {
  const c = fixture(t, { gate: pass });
  fs.writeFileSync(path.join(c.dir, 'bin', 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = c.ship(localArgs);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const landed = c.git(['rev-parse', 'master']);
  assert.deepEqual(fs.readFileSync(c.events, 'utf8').trim().split('\n'), [`verify:${landed}`, `gate:${landed}`]);
});

test('local mode alone lands the checked candidate on the target', (t) => {
  const c = fixture(t, { gate: pass });
  const result = c.ship(['--local', '--target', 'master']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const landed = c.git(['rev-parse', 'master']);
  assert.notEqual(landed, c.base);
  assert.deepEqual(fs.readFileSync(c.events, 'utf8').trim().split('\n'), [`verify:${landed}`, `gate:${landed}`]);
});

test('local landing rechecks when the target checkout gains a real commit', (t) => {
  const gate = `#!/bin/sh\n${marker}if test ! -f "$EVENTS.moved"; then\n  touch "$EVENTS.moved"\n  echo advanced > "$PRIMARY/b.txt"\n  git -C "$PRIMARY" add b.txt\n  git -C "$PRIMARY" commit -qm 'advance while checking'\nfi\n`;
  const c = fixture(t, { gate });
  const result = c.ship(localArgs);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const landed = c.git(['rev-parse', 'master']);
  const events = fs.readFileSync(c.events, 'utf8').trim().split('\n');
  assert.equal(events.length, 4);
  assert.equal(events[2], `verify:${landed}`);
  assert.equal(events[3], `gate:${landed}`);
  assert.equal(c.git(['show', 'master:b.txt']), 'advanced');
});

test('local landing retries when an unselected target moves during the gate', (t) => {
  const gate = `#!/bin/sh\n${marker}if test ! -f "$EVENTS.moved"; then\n  touch "$EVENTS.moved"\n  old=$(git rev-parse refs/heads/master)\n  GIT_INDEX_FILE="$EVENTS.index" git read-tree "$old"\n  blob=$(printf 'advanced\\n' | git hash-object -w --stdin)\n  GIT_INDEX_FILE="$EVENTS.index" git update-index --add --cacheinfo 100644 "$blob" b.txt\n  tree=$(GIT_INDEX_FILE="$EVENTS.index" git write-tree)\n  next=$(git commit-tree "$tree" -p "$old" -m moved)\n  git update-ref refs/heads/master "$next" "$old"\nfi\n`;
  const c = fixture(t, { gate });
  c.git(['switch', '-qc', 'other']);
  const result = c.ship(localArgs);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const landed = c.git(['rev-parse', 'master']);
  const events = fs.readFileSync(c.events, 'utf8').trim().split('\n');
  assert.equal(events.length, 4);
  assert.equal(events[2], `verify:${landed}`);
  assert.equal(events[3], `gate:${landed}`);
  assert.equal(c.git(['show', 'master:b.txt']), 'advanced');
});

test('a push hook that moves the source cannot land the old candidate', (t) => {
  const c = fixture(t, { gate: pass });
  const hooks = path.join(c.dir, 'hooks');
  fs.mkdirSync(hooks);
  c.git(['config', 'core.hooksPath', hooks]);
  fs.writeFileSync(path.join(hooks, 'pre-push'), '#!/bin/sh\nold=$(git rev-parse refs/heads/feature)\ntree=$(git rev-parse "$old^{tree}")\nnext=$(git commit-tree "$tree" -p "$old" -m moved)\ngit update-ref refs/heads/feature "$next" "$old"\n', { mode: 0o755 });
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /source branch moved/);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), c.base);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'feature'], c.dir), c.source);
});

for (const local of [false, true]) {
  test(`${local ? 'local' : 'remote'} preserves an ignored source file when the target adds that path`, (t) => {
    const c = fixture(t, { gate: '#!/bin/sh\nexit 37\n' });
    fs.appendFileSync(path.join(c.primary, '.git', 'info', 'exclude'), '\nnotes.local\n');
    fs.writeFileSync(path.join(c.work, 'notes.local'), 'precious source notes\n');
    fs.writeFileSync(path.join(c.primary, 'notes.local'), 'target file\n');
    c.git(['add', '-f', 'notes.local']);
    c.git(['commit', '-qm', 'add target file']);
    c.git(['push', 'origin', 'master']);
    const base = c.git(['rev-parse', 'master']);
    const result = c.ship(local ? localArgs : ['--merge']);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /notes\.local/);
    assert.equal(fs.readFileSync(path.join(c.work, 'notes.local'), 'utf8'), 'precious source notes\n');
    assert.equal(c.git(['rev-parse', 'HEAD'], c.work), c.source);
    assert.equal(c.git(['rev-parse', 'master']), base);
    assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), base);
  });
}

for (const switched of [false, true]) {
  test(`local landing preserves ignored primary files ${switched ? 'on another branch' : 'on the target'}`, (t) => {
    const c = fixture(t, { gate: pass, open: false });
    fs.appendFileSync(path.join(c.primary, '.git', 'info', 'exclude'), '\nnotes.local\n');
    fs.writeFileSync(path.join(c.work, 'notes.local'), 'checked-in replacement\n');
    c.git(['add', '-f', 'notes.local'], c.work);
    c.git(['commit', '-qm', 'add source file'], c.work);
    if (switched) c.git(['switch', '-qc', 'other']);
    fs.writeFileSync(path.join(c.primary, 'notes.local'), 'precious primary notes\n');
    const result = c.ship(localArgs);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /notes\.local/);
    assert.equal(fs.readFileSync(path.join(c.primary, 'notes.local'), 'utf8'), 'precious primary notes\n');
    assert.equal(c.git(['branch', '--show-current']), switched ? 'other' : 'master');
    assert.equal(c.git(['rev-parse', 'master']), c.base);
  });
}

test('a hidden remote target refuses a merge instead of trusting a stale target', (t) => {
  const c = fixture(t, { gate: '#!/bin/sh\necho mandatory gate >&2\nexit 37\n', targetOnly: true });
  c.git(['update-ref', 'refs/remotes/origin/master', `${c.source}^`], c.work);
  c.git(['--git-dir', c.remote, 'config', 'uploadpack.hideRefs', 'refs/heads/master'], c.dir);
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /target|fetch|read/i);
  assert.match(result.stderr, /left unmerged/);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), c.base);
  assert.doesNotMatch(fs.existsSync(c.ghLog) ? fs.readFileSync(c.ghLog, 'utf8') : '', /"merge"/);
});

for (const noPr of [false, true]) {
  test(`a hidden remote target still checks auto-merge${noPr ? ' with no-pr' : ''}`, (t) => {
    const c = fixture(t, { gate: pass, targetOnly: true, auto: true });
    c.git(['update-ref', 'refs/remotes/origin/master', `${c.source}^`], c.work);
    c.git(['--git-dir', c.remote, 'config', 'uploadpack.hideRefs', 'refs/heads/master'], c.dir);
    const result = c.ship(noPr ? ['--no-pr'] : []);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /auto-merge/);
    assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'feature'], c.dir), c.source);
  });
}

test('local landing reads its target without access to the remote', (t) => {
  const c = fixture(t, { gate: pass, open: false });
  c.git(['--git-dir', c.remote, 'config', 'uploadpack.hideRefs', 'refs/heads/master'], c.dir);
  const result = c.ship(localArgs);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.notEqual(c.git(['rev-parse', 'master']), c.base);
});

test('a moving target without a gate keeps the original merge check and refs', (t) => {
  const c = fixture(t);
  const index = path.join(c.dir, 'moving-index');
  const run = (args, input) => {
    const result = spawnSync('git', args, { cwd: c.work, env: { ...c.env, GIT_INDEX_FILE: index }, input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  run(['read-tree', c.base]);
  const blob = run(['hash-object', '-w', '--stdin'], 'conflicting target\n');
  run(['update-index', '--add', '--cacheinfo', '100644', blob, 'a.txt']);
  const tree = run(['write-tree']);
  const next = run(['commit-tree', tree, '-p', c.base, '-m', 'move target']);
  c.git(['--git-dir', c.remote, 'fetch', '--no-write-fetch-head', c.primary, next], c.dir);
  const verify = 'git --git-dir "$REMOTE" update-ref refs/heads/master "$NEXT" "$BASE"';
  const result = c.ship(['--merge'], verify, { NEXT: next, BASE: c.base });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, `commit: skipped (no local changes)\nverify: ${verify}\nmerge_check: origin/master clean\npush: origin feature\npr: 41 https://example.test/pull/41\nmerge: requested\nmerge: pending; kept the source branch while required checks finish\n`);
  assert.equal(result.stderr, '');
  assert.equal(c.git(['rev-parse', 'refs/remotes/origin/master']), c.base);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), next);
  assert.match(fs.readFileSync(c.ghLog, 'utf8'), /"merge"/);
});

for (const shape of ['file-for-directory', 'directory-for-file']) {
  test(`a candidate preserves ignored source data when a ${shape} blocks it`, (t) => {
    const c = fixture(t, { gate: pass });
    fs.appendFileSync(path.join(c.primary, '.git', 'info', 'exclude'), '\ncollision\n');
    if (shape === 'file-for-directory') {
      fs.writeFileSync(path.join(c.work, 'collision'), 'precious\n');
      fs.mkdirSync(path.join(c.primary, 'collision'));
      fs.writeFileSync(path.join(c.primary, 'collision', 'child'), 'target\n');
    } else {
      fs.mkdirSync(path.join(c.work, 'collision'));
      fs.writeFileSync(path.join(c.work, 'collision', 'precious'), 'precious\n');
      fs.writeFileSync(path.join(c.primary, 'collision'), 'target\n');
    }
    c.git(['add', '-f', 'collision']);
    c.git(['commit', '-qm', 'add target path']);
    c.git(['push', 'origin', 'master']);
    const result = c.ship(['--merge']);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /collision/);
    const kept = shape === 'file-for-directory' ? 'collision' : 'collision/precious';
    assert.equal(fs.readFileSync(path.join(c.work, kept), 'utf8'), 'precious\n');
  });
}

test('local landing checks the switch to the target before changing the primary branch', (t) => {
  const c = fixture(t, { gate: pass, open: false });
  fs.appendFileSync(path.join(c.primary, '.git', 'info', 'exclude'), '\nnotes.local\n');
  c.git(['switch', '-qc', 'other']);
  fs.writeFileSync(path.join(c.primary, 'notes.local'), 'precious\n');
  const targetWork = path.join(c.dir, 'target-work');
  c.git(['worktree', 'add', '--detach', targetWork, 'master']);
  fs.writeFileSync(path.join(targetWork, 'notes.local'), 'target\n');
  c.git(['add', '-f', 'notes.local'], targetWork);
  c.git(['commit', '-qm', 'target adds file'], targetWork);
  const target = c.git(['rev-parse', 'HEAD'], targetWork);
  c.git(['update-ref', 'refs/heads/master', target, c.base]);
  const result = c.ship(localArgs);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /notes\.local/);
  assert.equal(c.git(['branch', '--show-current']), 'other');
  assert.equal(fs.readFileSync(path.join(c.primary, 'notes.local'), 'utf8'), 'precious\n');
  assert.equal(c.git(['rev-parse', 'master']), target);
});

test('local landing does not require a reachable pull request service', (t) => {
  const c = fixture(t, { gate: pass, open: false });
  c.git(['remote', 'set-url', 'origin', 'https://example.invalid/repository.git']);
  fs.writeFileSync(path.join(c.dir, 'bin', 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const result = c.ship(localArgs);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.notEqual(c.git(['rev-parse', 'master']), c.base);
});

test('a moved local target cannot overwrite ignored data while switching the primary folder', (t) => {
  const gate = `#!/bin/sh
if test ! -f "$EVENTS.moved"; then
  touch "$EVENTS.moved"
  old=$(git rev-parse refs/heads/master)
  GIT_INDEX_FILE="$EVENTS.index" git read-tree "$old"
  blob=$(printf 'target file\\n' | git hash-object -w --stdin)
  GIT_INDEX_FILE="$EVENTS.index" git update-index --add --cacheinfo 100644 "$blob" notes.local
  tree=$(GIT_INDEX_FILE="$EVENTS.index" git write-tree)
  next=$(git commit-tree "$tree" -p "$old" -m moved)
  git update-ref refs/heads/master "$next" "$old"
fi
`;
  const c = fixture(t, { gate, open: false });
  fs.appendFileSync(path.join(c.primary, '.git', 'info', 'exclude'), '\nnotes.local\n');
  c.git(['switch', '-qc', 'other']);
  fs.writeFileSync(path.join(c.primary, 'notes.local'), 'precious\n');
  const result = c.ship(localArgs);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /notes\.local/);
  assert.equal(fs.readFileSync(path.join(c.primary, 'notes.local'), 'utf8'), 'precious\n');
  assert.equal(c.git(['branch', '--show-current']), 'other');
});

test('a candidate preserves hidden changes to an assumed-unchanged tracked file', (t) => {
  const c = fixture(t, { gate: '#!/bin/sh\nexit 37\n' });
  c.git(['update-index', '--assume-unchanged', 'b.txt'], c.work);
  fs.writeFileSync(path.join(c.work, 'b.txt'), 'precious tracked data\n');
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /b\.txt/);
  assert.equal(fs.readFileSync(path.join(c.work, 'b.txt'), 'utf8'), 'precious tracked data\n');
  assert.equal(c.git(['rev-parse', 'HEAD'], c.work), c.source);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), c.base);
});

test('returning from the check preserves an ignored file created where the branch has a file', (t) => {
  const c = fixture(t, { gate: '#!/bin/sh\ntest ! -e notes.local || exit 70\necho new-data > notes.local\n' });
  fs.appendFileSync(path.join(c.primary, '.git', 'info', 'exclude'), '\nnotes.local\n');
  fs.writeFileSync(path.join(c.work, 'notes.local'), 'tracked branch data\n');
  c.git(['add', '-f', 'notes.local'], c.work);
  c.git(['commit', '-qm', 'add source file'], c.work);
  c.git(['merge', '--no-ff', '-m', 'include source', 'feature']);
  c.git(['rm', 'notes.local']);
  c.git(['commit', '-qm', 'remove target file']);
  c.git(['push', 'origin', 'master']);
  const base = c.git(['rev-parse', 'master']);
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /overwrite existing file notes\.local/);
  assert.equal(fs.readFileSync(path.join(c.work, 'notes.local'), 'utf8'), 'new-data\n');
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), base);
});

test('a gate committed by verification is checked before merging', (t) => {
  const c = fixture(t, { open: false });
  const verify = 'if ! test -e scripts/merge-gate.sh; then mkdir -p scripts; printf "#!/bin/sh\\necho source gate >&2\\nexit 37\\n" > scripts/merge-gate.sh; git add scripts/merge-gate.sh; git commit -qm "add source gate"; fi';
  const result = c.ship(['--merge'], verify);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /source gate/);
  assert.match(result.stderr, /left unmerged/);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), c.base);
});

test('an ignored local gate is not silently bypassed', (t) => {
  const c = fixture(t, { open: false });
  fs.appendFileSync(path.join(c.primary, '.git', 'info', 'exclude'), '\nscripts/merge-gate.sh\n');
  fs.mkdirSync(path.join(c.work, 'scripts'));
  fs.writeFileSync(path.join(c.work, 'scripts', 'merge-gate.sh'), '#!/bin/sh\nexit 37\n');
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /gate.*missing|gate.*commit/);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), c.base);
});

test('checkout protection asks Git only for the paths being changed', (t) => {
  const c = fixture(t, { gate: pass, open: false });
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(realGit);
  const trace = path.join(c.dir, 'git-tree-requests');
  fs.writeFileSync(path.join(c.dir, 'bin', 'git'), '#!/bin/sh\ncase " $* " in *" ls-tree -r "*) printf "%s\\n" "$*" >> "$TREE_REQUESTS";; esac\nexec "$REAL_GIT" "$@"\n', { mode: 0o755 });
  const result = c.ship(['--merge'], undefined, { REAL_GIT: realGit, TREE_REQUESTS: trace });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const requests = fs.readFileSync(trace, 'utf8').trim().split('\n');
  assert.ok(requests.length > 0);
  for (const request of requests) assert.match(request, / -- .+/, request);
});

test('a tracked file may safely become a directory and return to a file', (t) => {
  const c = fixture(t, { gate: pass, open: false });
  fs.writeFileSync(path.join(c.work, 'collision'), 'tracked source\n');
  c.git(['add', 'collision'], c.work);
  c.git(['commit', '-qm', 'add source file'], c.work);
  const source = c.git(['rev-parse', 'HEAD'], c.work);
  c.git(['merge', '--no-ff', '-m', 'include source', 'feature']);
  c.git(['rm', 'collision']);
  fs.mkdirSync(path.join(c.primary, 'collision'));
  fs.writeFileSync(path.join(c.primary, 'collision', 'child'), 'tracked target\n');
  c.git(['add', 'collision']);
  c.git(['commit', '-qm', 'replace file with directory']);
  c.git(['push', 'origin', 'master']);
  const result = c.ship(['--merge']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(path.join(c.work, 'collision'), 'utf8'), 'tracked source\n');
  assert.equal(c.git(['rev-parse', 'HEAD'], c.work), source);
});

test('checkout protection treats special characters in paths literally', (t) => {
  const c = fixture(t, { gate: pass });
  fs.appendFileSync(path.join(c.primary, '.git', 'info', 'exclude'), '\nnotes[[]1].local\n');
  fs.writeFileSync(path.join(c.work, 'notes[1].local'), 'precious\n');
  fs.writeFileSync(path.join(c.primary, 'notes[1].local'), 'target\n');
  c.git(['add', '-f', 'notes[1].local']);
  c.git(['commit', '-qm', 'add target file']);
  c.git(['push', 'origin', 'master']);
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /notes\[1\]\.local/);
  assert.equal(fs.readFileSync(path.join(c.work, 'notes[1].local'), 'utf8'), 'precious\n');
});

test('a gate that commits a new file leaves that file in place when it is refused', (t) => {
  const c = fixture(t, { gate: '#!/bin/sh\necho precious > gate-created.txt\ngit add gate-created.txt\ngit commit -qm "gate created file"\n' });
  const result = c.ship(['--merge']);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /changed the commit/);
  assert.equal(fs.readFileSync(path.join(c.work, 'gate-created.txt'), 'utf8'), 'precious\n');
  assert.equal(c.git(['rev-parse', 'feature'], c.work), c.source);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), c.base);
});

function advanceRemoteOnly(c, file, content) {
  const index = path.join(c.dir, 'remote-only-index');
  const run = (args, input) => {
    const result = spawnSync('git', args, { cwd: c.work, env: { ...c.env, GIT_INDEX_FILE: index }, input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  run(['read-tree', c.base]);
  const blob = run(['hash-object', '-w', '--stdin'], content);
  run(['update-index', '--add', '--cacheinfo', '100644', blob, file]);
  const tree = run(['write-tree']);
  const next = run(['commit-tree', tree, '-p', c.base, '-m', 'advance remote']);
  c.git(['--git-dir', c.remote, 'fetch', '--no-write-fetch-head', c.primary, next], c.dir);
  c.git(['--git-dir', c.remote, 'update-ref', 'refs/heads/master', next, c.base], c.dir);
  return next;
}

function fetchHeadPath(c) {
  return path.resolve(c.work, c.git(['rev-parse', '--git-path', 'FETCH_HEAD'], c.work));
}

const legacyLocalOutput = 'commit: skipped (no local changes)\nverify: true\nmerge_check: origin/master clean\npush: skipped (local mode)\nmerge: requested (local mode)\nmerge: merged (local mode)\npr: skipped (local mode)\nhealth check failed: no verified experiment in 1 days. shipping still works, the metabolism does not.\ncleanup: kept this build copy (ATRIS_WORKTREE_KEEP_AFTER_SHIP=1)\ndone: worktree shipped\n';

test('local no-gate landing keeps the legacy fetch record for a stationary target', (t) => {
  const c = fixture(t);
  const fetchHead = fetchHeadPath(c);
  fs.rmSync(fetchHead, { force: true });
  const result = c.ship(localArgs, 'true');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, legacyLocalOutput);
  assert.equal(c.git(['rev-parse', 'refs/remotes/origin/master']), c.base);
  assert.equal(fs.readFileSync(fetchHead, 'utf8'), `${c.base}\t\tbranch 'master' of ${c.remote.replace(/\.git$/, '')}\n`);
});

test('local no-gate landing refreshes a stale remote when it still merges cleanly', (t) => {
  const c = fixture(t);
  const next = advanceRemoteOnly(c, 'remote-only.txt', 'remote change\n');
  assert.equal(c.git(['rev-parse', 'refs/remotes/origin/master']), c.base);
  const result = c.ship(localArgs, 'true');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, legacyLocalOutput);
  assert.equal(c.git(['rev-parse', 'refs/remotes/origin/master']), next);
  assert.equal(c.git(['rev-parse', 'refs/remotes/origin/HEAD']), next);
  assert.equal(fs.readFileSync(fetchHeadPath(c), 'utf8'), `${next}\t\tbranch 'master' of ${c.remote.replace(/\.git$/, '')}\n`);
  assert.notEqual(c.git(['rev-parse', 'master']), c.base);
  assert.equal(c.git(['--git-dir', c.remote, 'rev-parse', 'master'], c.dir), next);
});

test('local no-gate landing refuses a conflict with a freshly fetched remote', (t) => {
  const c = fixture(t);
  const next = advanceRemoteOnly(c, 'a.txt', 'conflicting remote change\n');
  const result = c.ship(localArgs, 'true');
  assert.equal(result.status, 3, result.stderr || result.stdout);
  assert.equal(result.stdout, 'commit: skipped (no local changes)\nverify: true\n');
  assert.match(result.stderr, /branch does not merge cleanly into origin\/master/);
  assert.match(result.stderr, /a\.txt/);
  assert.equal(c.git(['rev-parse', 'refs/remotes/origin/master']), next);
  assert.equal(fs.readFileSync(fetchHeadPath(c), 'utf8'), `${next}\t\tbranch 'master' of ${c.remote.replace(/\.git$/, '')}\n`);
  assert.equal(c.git(['rev-parse', 'master']), c.base);
  assert.equal(c.git(['rev-parse', 'feature'], c.work), c.source);
});

test('gated local landing refreshes the remote but checks the local target gate', (t) => {
  const c = fixture(t, { gate: pass, open: false });
  const next = advanceRemoteOnly(c, 'scripts/merge-gate.sh', '#!/bin/sh\necho remote gate >&2\nexit 37\n');
  const result = c.ship(localArgs);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(c.git(['rev-parse', 'refs/remotes/origin/master']), next);
  const landed = c.git(['rev-parse', 'master']);
  assert.deepEqual(fs.readFileSync(c.events, 'utf8').trim().split('\n'), [`verify:${landed}`, `gate:${landed}`]);
  assert.notEqual(landed, c.base);
});

test('gated local landing works without any configured remote', (t) => {
  const c = fixture(t, { gate: pass, open: false });
  c.git(['remote', 'remove', 'origin']);
  const result = c.ship(localArgs);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const landed = c.git(['rev-parse', 'master']);
  assert.deepEqual(fs.readFileSync(c.events, 'utf8').trim().split('\n'), [`verify:${landed}`, `gate:${landed}`]);
});

test('local no-gate landing ignores a failed remote refresh as before', (t) => {
  const c = fixture(t);
  c.git(['--git-dir', c.remote, 'config', 'uploadpack.hideRefs', 'refs/heads/master'], c.dir);
  const result = c.ship(localArgs, 'true');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, legacyLocalOutput);
  assert.equal(result.stderr, '');
  assert.notEqual(c.git(['rev-parse', 'master']), c.base);
});

function addRemoteMain(c) {
  c.git(['push', 'origin', 'master:refs/heads/main']);
  c.git(['fetch', 'origin', 'main'], c.work);
  assert.notEqual(spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/main'], { cwd: c.work }).status, 0);
}

for (const succeeds of [false, true]) {
  test(`local landing ${succeeds ? 'passes' : 'refuses'} the remote-only target gate before creating its branch`, (t) => {
    const gate = '#!/bin/sh\nif git show-ref --verify --quiet refs/heads/main; then echo branch created too soon >&2; exit 96; fi\n'
      + marker + (succeeds ? 'exit 0\n' : 'echo remote-only gate refused >&2\nexit 37\n');
    const c = fixture(t, { gate, targetOnly: !succeeds, open: false });
    addRemoteMain(c);
    const verify = 'if git show-ref --verify --quiet refs/heads/main; then echo branch created too soon >&2; exit 95; fi; printf "verify:%s\\n" "$(git rev-parse HEAD)" >> "$EVENTS"';
    const result = c.ship(['--local', '--merge', '--target', 'origin/main'], verify);
    if (!succeeds) {
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /remote-only gate refused/);
      assert.match(result.stderr, /left unmerged/);
      assert.equal(spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/heads/main'], { cwd: c.work }).status, 1);
      assert.equal(c.git(['branch', '--show-current']), 'master');
      assert.equal(c.git(['rev-parse', 'master']), c.base);
      assert.equal(c.git(['rev-parse', 'feature'], c.work), c.source);
    } else {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const landed = c.git(['rev-parse', 'refs/heads/main']);
      assert.deepEqual(fs.readFileSync(c.events, 'utf8').trim().split('\n'), [`verify:${landed}`, `gate:${landed}`]);
      assert.deepEqual(c.git(['show', '-s', '--format=%P', landed]).split(' '), [c.base, c.source]);
      assert.equal(c.git(['branch', '--show-current']), 'main');
      assert.equal(c.git(['rev-parse', 'master']), c.base);
      assert.equal(c.git(['rev-parse', 'feature'], c.work), c.source);
    }
  });
}
