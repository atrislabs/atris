'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { checkZen } = require('../lib/zen');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, timeout: 60000 });
  if (result.error) throw result.error;
  return result;
}

function git(cwd, ...args) {
  const result = run('git', args, cwd);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function zen(cwd, freshMinutes, ...args) {
  return run(process.execPath, [cliPath, 'zen', ...args], cwd, {
    ...process.env,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    ATRIS_ZEN_FRESH_MINUTES: String(freshMinutes),
  });
}

function write(cwd, file, content) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
}

function commit(cwd, file, content, message) {
  write(cwd, file, content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

const NOTES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

function createRepo() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-zen-apply-')));
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const checkout = path.join(base, 'checkout');
  fs.mkdirSync(seed);
  git(base, 'init', '-q', '--bare', '--initial-branch=master', origin);
  git(seed, 'init', '-q', '--initial-branch=master');
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'test');
  commit(seed, 'atris/TODO.md', NOTES, 'notes');
  commit(seed, 'app.js', 'one\n', 'app');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', '-u', 'origin', 'master');
  git(base, 'clone', '-q', origin, checkout);
  git(checkout, 'config', 'user.email', 'test@example.com');
  git(checkout, 'config', 'user.name', 'test');
  return { base, seed, checkout };
}

function branches(cwd, pattern) {
  return git(cwd, 'branch', '--list', pattern, '--format=%(refname:short)').split('\n').filter(Boolean);
}

test('atris zen makes a messy repo zen and keeps everything', () => {
  const { base, seed, checkout } = createRepo();
  try {
    // origin moves on, including a change to the team notes
    commit(seed, 'app.js', 'two\n', 'newer app');
    commit(seed, 'atris/TODO.md', NOTES.replace('line 10', 'line 10 from origin'), 'origin note');
    git(seed, 'push', '-q');
    // local mess
    commit(checkout, 'local.js', 'local\n', 'unpushed');
    git(checkout, 'branch', 'done-work', 'HEAD~1');
    write(checkout, 'app.js', 'stashed\n');
    git(checkout, 'stash', 'push', '-q');
    git(checkout, 'worktree', 'add', '-q', path.join(base, 'idle'), '-b', 'idle-branch');
    git(checkout, 'worktree', 'add', '-q', path.join(base, 'busy'), '-b', 'busy-branch');
    write(path.join(base, 'busy'), 'wip.js', 'wip\n');
    write(checkout, 'app.js', 'edited\n');
    write(checkout, 'scratch/try.js', 'try\n');
    write(checkout, 'atris/TODO.md', NOTES.replace('line 1\n', 'line 1 from me\n'));

    const cli = zen(checkout, 0);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /^ {2}zen\.$/m);
    assert.match(cli.stdout, /saved 1 old stash away/);
    assert.match(cli.stdout, /put away 1 idle side copy/);
    assert.match(cli.stdout, /saved 2 stray edits to zen-backup\//);
    assert.match(cli.stdout, /moved 1 unpushed commit to zen-backup\//);
    assert.match(cli.stdout, /caught up 2 commits from origin\/master/);
    assert.match(cli.stdout, /cleared 1 finished branch/);
    assert.match(cli.stdout, /1 side copy has unsaved work/);

    assert.equal(checkZen({ cwd: checkout, fetch: false }).zen, true);
    // code matches origin, notes carry both edits
    assert.equal(fs.readFileSync(path.join(checkout, 'app.js'), 'utf8'), 'two\n');
    assert.ok(!fs.existsSync(path.join(checkout, 'scratch')));
    const notes = fs.readFileSync(path.join(checkout, 'atris/TODO.md'), 'utf8');
    assert.match(notes, /line 1 from me/);
    assert.match(notes, /line 10 from origin/);
    assert.equal(git(checkout, 'diff', '--cached', '--name-only'), '');
    // nothing was lost
    assert.equal(git(checkout, 'stash', 'list'), '');
    const archived = git(checkout, 'for-each-ref', '--format=%(refname)', 'refs/archive');
    assert.match(archived, /refs\/archive\/zen-.*\/stash-000/);
    assert.equal(git(checkout, 'show', `${archived}:app.js`), 'stashed');
    const unpushed = branches(checkout, 'zen-backup/*-unpushed');
    assert.equal(unpushed.length, 1);
    assert.equal(git(checkout, 'show', `${unpushed[0]}:local.js`), 'local');
    const stray = branches(checkout, 'zen-backup/*').filter((b) => !b.endsWith('-unpushed'));
    assert.equal(stray.length, 1);
    assert.equal(git(checkout, 'show', `${stray[0]}:app.js`), 'edited');
    assert.equal(git(checkout, 'show', `${stray[0]}:scratch/try.js`), 'try');
    // side copies: idle gone with its branch kept, busy untouched
    assert.ok(!fs.existsSync(path.join(base, 'idle')));
    assert.deepEqual(branches(checkout, 'idle-branch'), ['idle-branch']);
    assert.ok(fs.existsSync(path.join(base, 'busy', 'wip.js')));
    assert.deepEqual(branches(checkout, 'done-work'), []);
    // a receipt was written
    const receipt = fs.readFileSync(path.join(checkout, '.git', 'atris-zen.jsonl'), 'utf8').trim().split('\n');
    assert.equal(JSON.parse(receipt.at(-1)).after.length, 0);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('atris zen leaves fresh work alone', () => {
  const { base, checkout } = createRepo();
  try {
    commit(checkout, 'local.js', 'local\n', 'just committed');
    write(checkout, 'app.js', 'being edited\n');

    const cli = zen(checkout, 30);
    assert.equal(cli.status, 1, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /almost zen/);
    assert.match(cli.stdout, /1 edit was made in the last 30 minutes, so it stays/);
    assert.match(cli.stdout, /1 unpushed commit stays, made in the last 30 minutes/);
    assert.equal(fs.readFileSync(path.join(checkout, 'app.js'), 'utf8'), 'being edited\n');
    assert.equal(git(checkout, 'log', '-1', '--format=%s'), 'just committed');
    assert.deepEqual(branches(checkout, 'zen-backup/*'), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('atris zen on a zen repo says so and changes nothing', () => {
  const { base, checkout } = createRepo();
  try {
    write(checkout, 'atris/TODO.md', NOTES + 'a note\n');
    const refs = git(checkout, 'for-each-ref');
    const cli = zen(checkout, 0);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /already zen\./);
    assert.match(cli.stdout, /1 team note kept as it is/);
    assert.doesNotMatch(cli.stdout, /everything is kept/);
    assert.equal(git(checkout, 'for-each-ref'), refs);
    assert.match(fs.readFileSync(path.join(checkout, 'atris/TODO.md'), 'utf8'), /a note/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('atris zen moves back to the main branch and keeps the other one', () => {
  const { base, checkout } = createRepo();
  try {
    git(checkout, 'checkout', '-q', '-b', 'feature');
    commit(checkout, 'feature.js', 'f\n', 'feature work');
    const cli = zen(checkout, 0, '--json');
    const result = JSON.parse(cli.stdout);
    assert.equal(result.zen, true, cli.stdout);
    assert.ok(result.done.includes('moved back to master (feature is kept)'));
    assert.equal(git(checkout, 'symbolic-ref', '--short', 'HEAD'), 'master');
    assert.equal(git(checkout, 'show', 'feature:feature.js'), 'f');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('atris zen tidies the workspace too, and --check only names it', () => {
  const { base, checkout } = createRepo();
  try {
    commit(checkout, 'atris/logs/2026/2026-01-02.md', 'an old day\n', 'old journal');
    git(checkout, 'push', '-q');

    const check = zen(checkout, 0, '--check');
    assert.equal(check.status, 1, check.stdout + check.stderr);
    assert.match(check.stdout, /zen: almost, the code is calm and the workspace has 1 thing to tidy/);
    assert.match(check.stdout, /1 old journal to archive/);
    assert.ok(fs.existsSync(path.join(checkout, 'atris/logs/2026/2026-01-02.md')));

    const cli = zen(checkout, 0);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /archived 1 old journal/);
    assert.match(cli.stdout, /^ {2}zen\.$/m);
    assert.equal(
      fs.readFileSync(path.join(checkout, 'atris/logs/archive/2026/2026-01-02.md'), 'utf8'),
      'an old day\n',
    );
    assert.equal(checkZen({ cwd: checkout, fetch: false }).zen, true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('atris zen saves a side copy nobody touched in days, then puts it away', () => {
  const { base, checkout } = createRepo();
  try {
    const old = path.join(base, 'old');
    git(checkout, 'worktree', 'add', '-q', old, '-b', 'old-branch');
    write(old, 'wip.js', 'forgotten\n');
    write(old, 'app.js', 'half done\n');
    const days = new Date(Date.now() - 5 * 86400000);
    const gitDir = path.resolve(old, git(old, 'rev-parse', '--git-dir'));
    for (const f of [path.join(old, 'wip.js'), path.join(old, 'app.js'), path.join(gitDir, 'HEAD'), path.join(gitDir, 'logs', 'HEAD')]) {
      fs.utimesSync(f, days, days);
    }

    const cli = zen(checkout, 30);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /saved 1 side copy untouched for 3 days to zen-backup\/ and put it away/);
    assert.ok(!fs.existsSync(old));
    const [kept] = branches(checkout, 'zen-backup/*-old');
    assert.ok(kept, branches(checkout, '*').join(','));
    assert.equal(git(checkout, 'show', `${kept}:wip.js`), 'forgotten');
    assert.equal(git(checkout, 'show', `${kept}:app.js`), 'half done');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('atris zen keeps team notes from unpushed commits in the tree', () => {
  const { base, seed, checkout } = createRepo();
  try {
    commit(seed, 'app.js', 'two\n', 'newer app');
    git(seed, 'push', '-q');
    // A job commits its report and a team note to main and never pushes.
    write(checkout, 'reports/health.json', '{}\n');
    write(checkout, 'atris/TODO.md', NOTES.replace('line 5', 'line 5 from the job'));
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '-q', '-m', 'weekly job');

    const cli = zen(checkout, 0);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /moved 1 unpushed commit to zen-backup\//);
    assert.match(cli.stdout, /kept 1 team note from it in the tree/);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), git(checkout, 'rev-parse', 'origin/master'));
    assert.match(fs.readFileSync(path.join(checkout, 'atris/TODO.md'), 'utf8'), /line 5 from the job/);
    assert.equal(git(checkout, 'diff', '--cached', '--name-only'), '');
    assert.ok(!fs.existsSync(path.join(checkout, 'reports/health.json')));
    const [kept] = branches(checkout, 'zen-backup/*-unpushed');
    assert.equal(git(checkout, 'show', `${kept}:reports/health.json`), '{}');
    assert.equal(checkZen({ cwd: checkout, fetch: false }).zen, true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('atris zen only says it refreshed the map when the map changed', () => {
  const { base, checkout } = createRepo();
  try {
    write(checkout, 'atris/MAP.md', '# Map\n');
    write(checkout, 'scripts/refresh_map_active.py', 'pass\n');
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '-q', '-m', 'map and a refresh script that changes nothing');
    git(checkout, 'push', '-q');

    const quiet = zen(checkout, 0);
    assert.equal(quiet.status, 0, quiet.stdout + quiet.stderr);
    assert.doesNotMatch(quiet.stdout, /refreshed the map/);
    assert.match(quiet.stdout, /already zen\./);

    write(checkout, 'scripts/refresh_map_active.py', "open('atris/MAP.md', 'a').write('- new row\\n')\n");
    git(checkout, 'commit', '-q', '-am', 'a refresh script that adds a row');
    git(checkout, 'push', '-q');
    const loud = zen(checkout, 0);
    assert.match(loud.stdout, /refreshed the map/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('atris zen never rolls back a live database file', () => {
  const { base, checkout } = createRepo();
  try {
    commit(checkout, 'crm.db', 'rows v1\n', 'database');
    git(checkout, 'push', '-q');
    write(checkout, 'crm.db', 'rows v2, written by the running app\n');

    const cli = zen(checkout, 0);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.doesNotMatch(cli.stdout, /stray edit/);
    assert.equal(fs.readFileSync(path.join(checkout, 'crm.db'), 'utf8'), 'rows v2, written by the running app\n');
    assert.deepEqual(branches(checkout, 'zen-backup/*'), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('atris zen moves back to main even when team notes are edited on both branches', () => {
  const { base, checkout } = createRepo();
  try {
    git(checkout, 'checkout', '-q', '-b', 'side');
    commit(checkout, 'atris/TODO.md', NOTES.replace('line 10', 'line 10 on side'), 'side note');
    write(checkout, 'atris/TODO.md', NOTES.replace('line 10', 'line 10 on side').replace('line 1\n', 'line 1 mine\n'));

    const cli = zen(checkout, 0);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /moved back to master \(side is kept\)/);
    assert.equal(git(checkout, 'symbolic-ref', '--short', 'HEAD'), 'master');
    assert.match(fs.readFileSync(path.join(checkout, 'atris/TODO.md'), 'utf8'), /line 1 mine/);
    assert.equal(git(checkout, 'diff', '--cached', '--name-only'), '');
    assert.deepEqual(branches(checkout, 'side'), ['side']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('atris zen leaves a side copy alone when a scheduled job uses it', () => {
  const { base, checkout } = createRepo();
  try {
    const job = path.join(base, 'pruner');
    git(checkout, 'worktree', 'add', '-q', '--detach', job);
    const gitDir = path.resolve(job, git(job, 'rev-parse', '--git-dir'));
    const days = new Date(Date.now() - 5 * 86400000);
    for (const f of [path.join(gitDir, 'HEAD'), path.join(gitDir, 'logs', 'HEAD')]) {
      if (fs.existsSync(f)) fs.utimesSync(f, days, days);
    }
    const schedule = path.join(base, 'crontab.txt');
    fs.writeFileSync(schedule, `5 6 * * * cd ${job} && python3 scripts/prune.py\n`);

    const cli = run(process.execPath, [cliPath, 'zen'], checkout, {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_ZEN_FRESH_MINUTES: '30',
      ATRIS_ZEN_SCHEDULE_FILE: schedule,
    });
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /1 side copy is used by a scheduled job, so it stays/);
    assert.match(cli.stdout, /zen\./);
    assert.ok(fs.existsSync(job));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a side copy left alone for being in use does not count as out of place', () => {
  const { base, checkout } = createRepo();
  try {
    const copy = path.join(base, 'live');
    git(checkout, 'worktree', 'add', '-q', '-b', 'live-work', copy);

    const cli = zen(checkout, 30);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /1 side copy was used in the last 30 minutes/);
    assert.match(cli.stdout, /zen\./);
    assert.doesNotMatch(cli.stdout, /still out of place/);
    assert.ok(fs.existsSync(copy));

    const check = run(process.execPath, [cliPath, 'zen', '--check', '--no-fetch'], checkout, {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_ZEN_FRESH_MINUTES: '30',
    });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /^zen: yes/m);
    assert.match(check.stdout, /1 side copy was used in the last 30 minutes, left alone/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a side copy locked by its owner stays and does not count as out of place', () => {
  const { base, checkout } = createRepo();
  try {
    const copy = path.join(base, 'agent-copy');
    git(checkout, 'worktree', 'add', '-q', '-b', 'agent-work', copy);
    git(checkout, 'worktree', 'lock', '--reason', 'claude agent a1 (pid 1 start Mon Oct 19 03:23:14 2026)', copy);
    const gitDir = path.resolve(copy, git(copy, 'rev-parse', '--git-dir'));
    const hourAgo = new Date(Date.now() - 3600000);
    for (const f of ['HEAD', 'logs/HEAD']) fs.utimesSync(path.join(gitDir, f), hourAgo, hourAgo);

    const cli = zen(checkout, 30);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /1 side copy is locked by its owner, so it stays/);
    assert.doesNotMatch(cli.stdout, /unsaved work/);
    assert.match(cli.stdout, /zen\./);
    assert.ok(fs.existsSync(copy));

    const check = run(process.execPath, [cliPath, 'zen', '--check', '--no-fetch'], checkout, {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_ZEN_FRESH_MINUTES: '30',
    });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /^zen: yes/m);
    assert.match(check.stdout, /1 side copy is locked by its owner, left alone/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a team note that truly clashes keeps the new version, saves yours, and never leaves conflict marks', () => {
  const { base, checkout } = createRepo();
  try {
    commit(checkout, 'atris/plan.md', NOTES, 'plan');
    git(checkout, 'push', '-q', 'origin', 'master');
    git(checkout, 'checkout', '-q', '-b', 'side');
    commit(checkout, 'atris/TODO.md', NOTES.replace('line 10', 'line 10 on side'), 'side todo');
    commit(checkout, 'atris/plan.md', NOTES.replace('line 10', 'line 10 on side'), 'side plan');
    // Unsaved edits: one clashes with master, one is clean.
    write(checkout, 'atris/TODO.md', NOTES.replace('line 10', 'line 10 mine'));
    write(checkout, 'atris/plan.md', NOTES.replace('line 10', 'line 10 on side').replace('line 1\n', 'line 1 mine\n'));

    const cli = zen(checkout, 0);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /moved back to master/);
    const todo = fs.readFileSync(path.join(checkout, 'atris/TODO.md'), 'utf8');
    assert.doesNotMatch(todo, /^(<<<<<<<|=======|>>>>>>>)/m);
    assert.equal(todo, NOTES);
    assert.match(fs.readFileSync(path.join(checkout, 'atris/plan.md'), 'utf8'), /line 1 mine/);
    const said = cli.stdout.match(/kept the new atris\/TODO\.md; your copy is in (\S+)/);
    assert.ok(said, cli.stdout);
    assert.match(fs.readFileSync(said[1], 'utf8'), /line 10 mine/);
    assert.equal(git(checkout, 'diff', '--cached', '--name-only'), '');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a clashing note from an unpushed commit stays on its backup branch, with no conflict marks', () => {
  const { base, seed, checkout } = createRepo();
  try {
    commit(seed, 'atris/TODO.md', NOTES.replace('line 5', 'line 5 upstream'), 'upstream note');
    git(seed, 'push', '-q');
    write(checkout, 'atris/TODO.md', NOTES.replace('line 5', 'line 5 from the job'));
    write(checkout, 'atris/report.md', 'weekly\n');
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '-q', '-m', 'weekly job');

    const cli = zen(checkout, 0);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    const todo = fs.readFileSync(path.join(checkout, 'atris/TODO.md'), 'utf8');
    assert.doesNotMatch(todo, /^(<<<<<<<|=======|>>>>>>>)/m);
    assert.match(todo, /line 5 upstream/);
    assert.equal(fs.readFileSync(path.join(checkout, 'atris/report.md'), 'utf8'), 'weekly\n');
    assert.match(cli.stdout, /kept 1 team note from it in the tree/);
    const [kept] = branches(checkout, 'zen-backup/*-unpushed');
    assert.match(cli.stdout, new RegExp(`kept the new atris/TODO\\.md; yours is on ${kept}`));
    assert.match(git(checkout, 'show', `${kept}:atris/TODO.md`), /line 5 from the job/);
    assert.equal(git(checkout, 'diff', '--cached', '--name-only'), '');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
