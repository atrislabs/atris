'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { checkZen, isTeamState, DEFAULT_TEAM_STATE } = require('../lib/zen');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, timeout: 30000 });
  if (result.error) throw result.error;
  return result;
}

function git(cwd, ...args) {
  const result = run('git', args, cwd);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runCli(cwd, ...args) {
  return run(process.execPath, [cliPath, ...args], cwd, { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' });
}

function commit(cwd, file, content, message) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

// A clone of a bare origin, in sync, with a seed checkout that can push ahead.
function createZenRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zen-'));
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const checkout = path.join(base, 'checkout');
  fs.mkdirSync(seed);
  git(base, 'init', '-q', '--bare', '--initial-branch=master', origin);
  git(seed, 'init', '-q', '--initial-branch=master');
  for (const cwd of [seed]) {
    git(cwd, 'config', 'user.email', 'test@example.com');
    git(cwd, 'config', 'user.name', 'test');
  }
  commit(seed, 'atris/TODO.md', '# TODO\n', 'first');
  commit(seed, 'app.js', 'one\n', 'app');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', '-u', 'origin', 'master');
  git(base, 'clone', '-q', origin, checkout);
  git(checkout, 'config', 'user.email', 'test@example.com');
  git(checkout, 'config', 'user.name', 'test');
  return { base, seed, checkout };
}

function kinds(result) {
  return result.problems.map((p) => p.kind).sort();
}

test('side copies left for their owners get one line each and a clock', () => {
  const { sideCopyLines } = require('../lib/zen');
  const home = os.homedir();
  assert.deepEqual(sideCopyLines([path.join(home, 'work', 'a')], 3), [
    '1 side copy has unsaved work, left for its owner',
    `  ${path.join('~', 'work', 'a')}`,
    'zen saves it to zen-backup/ once nobody has touched it for 3 days',
  ]);
  assert.deepEqual(sideCopyLines(['/x/a', '/y/b', '/z/c', '/w/d', '/v/e'], 1), [
    '5 side copies have unsaved work, left for their owners',
    '  /x/a',
    '  /y/b',
    '  /z/c',
    '  and 2 more',
    'zen saves each one to zen-backup/ once nobody has touched it for 1 day',
  ]);
  assert.deepEqual(sideCopyLines(['/x/a'], 3, 12 * 3600000).slice(-1), ['that is due in 12 hours']);
  assert.deepEqual(sideCopyLines(['/x/a', '/x/b'], 3, 49 * 3600000).slice(-1), ['the first one is due in 2 days']);
});

test('side copies that share a folder are one line with the count', () => {
  const { sideCopyLines } = require('../lib/zen');
  const home = os.homedir();
  const runs = path.join(home, 'web', '.claude', 'worktrees');
  const copies = Array.from({ length: 27 }, (_, i) => path.join(runs, `wf_5fcd-${i}`));
  assert.deepEqual(sideCopyLines([...copies.slice(0, 2), path.join(home, 'cli', 'lead'), ...copies.slice(2)], 3).slice(0, 3), [
    '28 side copies have unsaved work, left for their owners',
    `  27 in ${path.join('~', 'web', '.claude', 'worktrees')}/`,
    `  ${path.join('~', 'cli', 'lead')}`,
  ]);
  // Two in one folder still read better by name.
  assert.deepEqual(sideCopyLines(['/x/a', '/x/b'], 3).slice(1, 3), ['  /x/a', '  /x/b']);
});

test('a side copy path too long for the pane keeps its start and its own name', () => {
  const { sideCopyLines } = require('../lib/zen');
  const home = os.homedir();
  const name = 'youtube-lead-score-youtube-lead-gate-20261021-155633';
  const far = path.join(home, 'arena', 'empire', '.agent-worktrees', 'atris-cli', '.agent-worktrees',
    'youtube-lead-youtube-lead-make-captioned-youtube-20261013-202157', name);
  const [, line] = sideCopyLines([far], 3);
  assert.equal(line, `  ~/arena/empire/.agent-worktrees/atris-cli/…/${name}`);
  assert.ok(line.length <= 102, line);
  // A path that fits is left whole, and so is one a cut would barely shorten.
  assert.equal(sideCopyLines(['/x/a'], 3)[1], '  /x/a');
  const near = path.join(home, 'arena', 'empire', '.agent-worktrees', 'atris-cli',
    'youtube-lead-youtube-lead-make-captioned-youtube-20261013-202157');
  assert.equal(sideCopyLines([near], 3)[1], `  ${near.replace(home, '~')}`);
});

test('a side copy made inside another one is named from it, right under it', () => {
  const { sideCopyLines } = require('../lib/zen');
  const outer = '/w/agent-worktrees/youtube-lead-make-captioned-20261013';
  const inner = path.join(outer, '.agent-worktrees', 'youtube-lead-score-gate-20261021');
  assert.deepEqual(sideCopyLines([inner, '/x/other', outer], 3).slice(1, 4), [
    '  /x/other',
    `  ${outer}`,
    `    inside it: ${path.join('.agent-worktrees', 'youtube-lead-score-gate-20261021')}`,
  ]);
});

test('a side copy in the system temp folder is named from $TMPDIR', () => {
  const { sideCopyLines } = require('../lib/zen');
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zen-tmpdir-'));
  const real = fs.realpathSync(fake);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = `${fake}/`;
  try {
    const lines = sideCopyLines([path.join(fake, 'gates-1', 'main'), path.join(real, 'gates-2', 'main'), '/elsewhere/x'], 3);
    assert.deepEqual(lines.slice(1, 4), [
      `  ${path.join('$TMPDIR', 'gates-1', 'main')}`,
      `  ${path.join('$TMPDIR', 'gates-2', 'main')}`,
      '  /elsewhere/x',
    ]);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

test('team-state matching covers folders and exact files', () => {
  assert.ok(isTeamState('atris/logs/2026/today.md', DEFAULT_TEAM_STATE));
  assert.ok(isTeamState('.claude/agents/x.md', DEFAULT_TEAM_STATE));
  assert.ok(isTeamState('CLAUDE.md', DEFAULT_TEAM_STATE));
  assert.ok(!isTeamState('CLAUDE.md.bak', DEFAULT_TEAM_STATE));
  assert.ok(!isTeamState('src/atris/x.js', DEFAULT_TEAM_STATE));
  assert.ok(!isTeamState('app.js', DEFAULT_TEAM_STATE));
});

test('a synced repo with only team notes changed is zen', () => {
  const { base, checkout } = createZenRepo();
  try {
    fs.writeFileSync(path.join(checkout, 'atris', 'TODO.md'), '# TODO\n- note\n');
    fs.mkdirSync(path.join(checkout, 'atris', 'logs'));
    fs.writeFileSync(path.join(checkout, 'atris', 'logs', 'today.md'), 'log\n');
    fs.writeFileSync(path.join(checkout, 'CLAUDE.md'), 'generated\n');

    const result = checkZen({ cwd: checkout });
    assert.equal(result.ok, true);
    assert.equal(result.zen, true, JSON.stringify(result.problems));
    assert.equal(result.upstream, 'origin/master');
    assert.equal(result.team_files, 3);

    const cli = runCli(checkout, 'zen', '--check');
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /^zen: yes/m);
    assert.match(cli.stdout, /code matches origin\/master/);
    assert.match(cli.stdout, /3 unsaved team files left in place/);
    assert.doesNotMatch(cli.stdout, /kept as they are/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('leftovers, drift and stray code each break zen', () => {
  const { base, seed, checkout } = createZenRepo();
  try {
    // behind origin
    commit(seed, 'app.js', 'two\n', 'newer');
    git(seed, 'push', '-q');
    // one unpushed commit
    commit(checkout, 'local.js', 'x\n', 'local');
    // a merged branch
    git(checkout, 'branch', 'done-work', 'HEAD~1');
    // a stash
    fs.writeFileSync(path.join(checkout, 'app.js'), 'stashed\n');
    git(checkout, 'stash', 'push', '-q');
    // an idle side copy and a busy one
    git(checkout, 'worktree', 'add', '-q', path.join(base, 'idle'), '-b', 'idle-branch');
    git(checkout, 'worktree', 'add', '-q', path.join(base, 'busy'), '-b', 'busy-branch');
    // nobody has switched or committed in the idle copy for an hour
    const idleGit = path.resolve(base, 'idle', git(path.join(base, 'idle'), 'rev-parse', '--git-dir'));
    const hourAgo = new Date(Date.now() - 3600000);
    const idleLog = path.join(idleGit, 'logs', 'HEAD');
    const epoch = Math.floor(hourAgo.getTime() / 1000);
    fs.writeFileSync(idleLog, fs.readFileSync(idleLog, 'utf8').replace(/> \d+ ([+-]\d{4})\t/g, `> ${epoch} $1\t`));
    fs.writeFileSync(path.join(base, 'busy', 'wip.js'), 'wip\n');
    // the merged branch was last moved an hour ago, so it is not a job's fresh branch
    const doneLog = path.join(checkout, '.git', 'logs', 'refs', 'heads', 'done-work');
    fs.writeFileSync(doneLog, fs.readFileSync(doneLog, 'utf8').replace(/> \d+ ([+-]\d{4})\t/g, `> ${epoch} $1\t`));
    // stray code edit
    fs.writeFileSync(path.join(checkout, 'app.js'), 'edited\n');

    const result = checkZen({ cwd: checkout });
    assert.equal(result.zen, false);
    assert.deepEqual(kinds(result), [
      'ahead', 'behind', 'idle_worktrees', 'merged_branches', 'stashes', 'stray_code',
    ]);
    const by = Object.fromEntries(result.problems.map((p) => [p.kind, p]));
    assert.deepEqual(by.stray_code.files, ['app.js']);
    assert.deepEqual(by.merged_branches.branches, ['done-work']);
    assert.equal(by.idle_worktrees.count, 1);
    assert.equal(result.worktrees_with_work.length, 1);

    const cli = runCli(checkout, 'zen', '--check');
    assert.equal(cli.status, 1);
    assert.match(cli.stdout, /^zen: no, 6 things are out of place/m);
    assert.match(cli.stdout, /1 commit behind origin\/master/);
    assert.match(cli.stdout, /1 old stash/);
    assert.match(cli.stdout, /1 side copy has unsaved work, left for its owner\n {4}\S*\/busy\n {2}zen saves it to zen-backup\/ once nobody has touched it for 3 days$/m);

    const json = JSON.parse(runCli(checkout, 'zen', '--check', '--json', '--no-fetch').stdout);
    assert.equal(json.zen, false);
    assert.equal(json.stashes, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('zen --check changes nothing in the repo', () => {
  const { base, checkout } = createZenRepo();
  try {
    fs.writeFileSync(path.join(checkout, 'app.js'), 'stashed\n');
    git(checkout, 'stash', 'push', '-q');
    git(checkout, 'branch', 'old');
    const before = git(checkout, 'for-each-ref');
    runCli(checkout, 'zen', '--check');
    assert.equal(git(checkout, 'for-each-ref'), before);
    assert.equal(git(checkout, 'stash', 'list').split('\n').length, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('off the main branch is not zen, and extra team paths come from .atris/zen.json', () => {
  const { base, checkout } = createZenRepo();
  try {
    fs.mkdirSync(path.join(checkout, '.atris'));
    fs.writeFileSync(path.join(checkout, '.atris', 'zen.json'), JSON.stringify({ team_state: ['results/'] }));
    fs.mkdirSync(path.join(checkout, 'results'));
    fs.writeFileSync(path.join(checkout, 'results', 'run.json'), '{}\n');
    assert.equal(checkZen({ cwd: checkout }).zen, true);

    git(checkout, 'checkout', '-q', '-b', 'feature');
    const result = checkZen({ cwd: checkout });
    assert.deepEqual(kinds(result), ['off_main']);
    assert.match(result.problems[0].text, /on branch feature, not master/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a checkout set to bare by mistake is named, with the undo', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zen-bare-')));
  try {
    git(dir, 'init', '-q');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'one\n');
    git(dir, 'config', 'core.bare', 'true');
    for (const cwd of [dir, path.join(dir, 'src')]) {
      for (const args of [['--check'], []]) {
        const cli = runCli(cwd, 'zen', ...args, '--no-fetch');
        assert.equal(cli.status, 2);
        assert.match(cli.stdout, /set to bare \(core\.bare is true\), so it ignores the files in this folder; git config core\.bare false undoes it/);
        assert.doesNotMatch(cli.stdout, /not a git repository/);
      }
    }
    assert.equal(git(dir, 'config', 'core.bare'), 'true', 'zen only names it, never flips it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('outside a git repo zen says it cannot check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zen-nogit-'));
  try {
    const cli = runCli(dir, 'zen', '--check');
    assert.equal(cli.status, 2);
    assert.match(cli.stdout, /zen: can't check, not a git repository/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
