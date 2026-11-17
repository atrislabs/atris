'use strict';

// On 2026-11-15 the merger's scratch copy sat in the repo's git folder.
// Vite, which vitest runs on, refuses any file under a path with a .git part,
// so on a private web app 557 of 1260 test files failed with "Cannot find
// module '/vitest.setup.ts'" and nothing ever landed there. The same day two
// scratch copies a killed run left, 950 MB, sat for 17 hours. These tests
// hold the scratch copy to a place with no .git part, under the user's .atris
// folder, and hold each run to sweeping its own stale copies and nothing
// else. Every test uses a throwaway home.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { landStaleGreenBranches, scratchDirSetting } = require('../lib/land-green');

const daysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
const HOUR = 60 * 60 * 1000;

function git(cwd, args, env = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function commitAll(cwd, message, when = daysAgo(3)) {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=Bench Author', '-c', 'user.email=bench@example.com', 'commit', '-q', '-m', message], {
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
  });
}

function makeRepo(branches = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-place-'));
  git(root, ['init', '-q', '-b', 'master']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': {} } }));
  commitAll(root, 'base', daysAgo(10));
  branches.forEach((name, i) => {
    git(root, ['checkout', '-q', '-b', name]);
    fs.writeFileSync(path.join(root, `f${i}.txt`), `${name}\n`);
    commitAll(root, `${name} work`, daysAgo(3 + i));
    git(root, ['checkout', '-q', 'master']);
  });
  return root;
}

// The folder name the merger gives this repo: its folder name and a short
// hash of its git folder.
function repoFolderName(root) {
  const common = fs.realpathSync(path.join(root, '.git'));
  return `${path.basename(root)}-${crypto.createHash('sha1').update(common).digest('hex').slice(0, 8)}`;
}

const GREEN = { status: 0, timed_out: false, failing: [], failing_all: [], command: 'npm test', duration_ms: 1, tail: '' };
const noTasks = () => { throw new Error('no job expected'); };

function run(root, home, extra = {}) {
  return landStaleGreenBranches(root, {
    push: false, stateFile: null, openFlags: false, fileConflictTask: noTasks, fileSlowCheckTask: noTasks,
    runVerifyFn: () => GREEN,
    env: { ...process.env, HOME: home },
    activePaths: () => [],
    ...extra,
  });
}

test('the scratch copy lives under the home .atris folder, with no .git part in its path, and is gone after the run', () => {
  const root = makeRepo(['member/green']);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-place-home-'));
  try {
    let seen = null;
    const result = run(root, home, {
      runVerifyFn: (command, cwd, opts) => {
        const marker = JSON.parse(fs.readFileSync(`${cwd}.run.json`, 'utf8'));
        seen = { cwd, root: opts.root, marker, status: git(cwd, ['status', '--porcelain']) };
        return GREEN;
      },
    });
    assert.deepEqual(result.landed, ['member/green'], JSON.stringify(result.verdicts));
    const folder = path.join(home, '.atris', 'land-green-scratch', repoFolderName(root));
    assert.equal(path.dirname(seen.cwd), folder);
    assert.match(path.basename(seen.cwd), /^atris-land-green-/);
    assert.equal(seen.cwd.split(path.sep).includes('.git'), false, 'no .git part, so vite serves its files');
    assert.equal(seen.root, root, 'ATRIS_LAND_ROOT still names the main checkout');
    assert.equal(seen.marker.pid, process.pid, 'the run that holds it is written beside it');
    assert.equal(seen.status, '', 'the marker is outside the copy, so the merged tree stays clean');
    assert.deepEqual(fs.readdirSync(folder), [], 'the copy and its marker are gone');
    assert.equal(fs.existsSync(path.join(root, '.git', 'atris-land-green-scratch')), false, 'nothing in the git folder');
    assert.equal(git(root, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('green_landing_scratch_dir names another parent; only an absolute path or one under ~ counts', () => {
  assert.equal(scratchDirSetting(null), undefined);
  assert.equal(scratchDirSetting({}), undefined);
  assert.equal(scratchDirSetting({ green_landing_scratch_dir: '' }), undefined);
  assert.equal(scratchDirSetting({ green_landing_scratch_dir: 'relative/place' }), undefined);
  assert.equal(scratchDirSetting({ green_landing_scratch_dir: 7 }), undefined);
  assert.equal(scratchDirSetting({ green_landing_scratch_dir: '/srv/scratch' }), '/srv/scratch');
  assert.equal(scratchDirSetting({ green_landing_scratch_dir: '~/scratch' }), path.join(os.homedir(), 'scratch'));
  const root = makeRepo(['member/green']);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-place-home-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-place-other-'));
  try {
    let cwd = '';
    const result = run(root, home, { scratchDir: other, runVerifyFn: (c, dir) => { cwd = dir; return GREEN; } });
    assert.deepEqual(result.landed, ['member/green'], JSON.stringify(result.verdicts));
    assert.equal(path.dirname(cwd), path.join(other, repoFolderName(root)));
    assert.equal(fs.existsSync(path.join(home, '.atris', 'land-green-scratch')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

function scratchAt(root, dir, hoursOld) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(root, ['worktree', 'add', '-q', '--detach', dir, 'master']);
  const when = new Date(Date.now() - hoursOld * HOUR);
  fs.utimesSync(dir, when, when);
  return dir;
}

function registered(root) {
  return git(root, ['worktree', 'list', '--porcelain']).split('\n')
    .filter((l) => l.startsWith('worktree ')).map((l) => fs.realpathSync(l.slice('worktree '.length)));
}

test('a run sweeps its own stale scratch copies in the new place and the old one, and leaves fresh, held, open and foreign ones', () => {
  const root = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-place-home-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-place-elsewhere-'));
  try {
    const folder = path.join(home, '.atris', 'land-green-scratch', repoFolderName(root));
    const oldFolder = path.join(root, '.git', 'atris-land-green-scratch');
    const staleNew = scratchAt(root, path.join(folder, 'atris-land-green-killed'), 5);
    const staleOld = scratchAt(root, path.join(oldFolder, 'atris-land-green-killed'), 17);
    const fresh = scratchAt(root, path.join(folder, 'atris-land-green-fresh'), 0);
    const held = scratchAt(root, path.join(folder, 'atris-land-green-held'), 5);
    fs.writeFileSync(`${held}.run.json`, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date(Date.now() - 4 * HOUR).toISOString() }));
    fs.utimesSync(`${held}.run.json`, new Date(Date.now() - 4 * HOUR), new Date(Date.now() - 4 * HOUR));
    const open = scratchAt(root, path.join(folder, 'atris-land-green-open'), 5);
    // Not one of the merger's scratch copies: another name in its folder, and
    // a scratch-like name somewhere else.
    const otherName = scratchAt(root, path.join(folder, 'someone-elses-copy'), 9);
    const foreign = scratchAt(root, path.join(elsewhere, 'atris-land-green-foreign'), 9);
    // A half-made copy git never registered, and a dead run's marker.
    const loose = path.join(oldFolder, 'atris-land-green-loose');
    fs.mkdirSync(loose);
    fs.utimesSync(loose, new Date(Date.now() - 6 * HOUR), new Date(Date.now() - 6 * HOUR));
    fs.writeFileSync(`${staleNew}.run.json`, JSON.stringify({ pid: 999999, host: os.hostname(), at: new Date(Date.now() - 5 * HOUR).toISOString() }));
    fs.utimesSync(`${staleNew}.run.json`, new Date(Date.now() - 5 * HOUR), new Date(Date.now() - 5 * HOUR));

    const result = run(root, home, { activePaths: () => [path.join(open, 'package.json')] });
    const swept = result.scratch_sweep.swept.map((p) => path.basename(path.dirname(p)) + '/' + path.basename(p)).sort();
    assert.deepEqual(swept, [
      'atris-land-green-scratch/atris-land-green-killed',
      'atris-land-green-scratch/atris-land-green-loose',
      `${repoFolderName(root)}/atris-land-green-killed`,
    ], JSON.stringify(result.scratch_sweep));
    for (const gone of [staleNew, staleOld, loose, `${staleNew}.run.json`]) assert.equal(fs.existsSync(gone), false, gone);
    const still = registered(root);
    for (const gone of [staleNew, staleOld]) assert.equal(still.some((p) => p.endsWith(path.join(path.basename(path.dirname(gone)), path.basename(gone)))), false, `${gone} is no longer registered`);
    for (const kept of [fresh, held, open, otherName, foreign]) {
      assert.equal(fs.existsSync(kept), true, kept);
      assert.equal(still.includes(fs.realpathSync(kept)), true, `${kept} is still registered`);
    }
    assert.deepEqual(result.scratch_sweep.kept.map((p) => path.basename(p)), ['atris-land-green-open']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('an unreadable list of open files keeps every stale copy, and a dry run sweeps nothing', () => {
  const root = makeRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-land-place-home-'));
  try {
    const folder = path.join(home, '.atris', 'land-green-scratch', repoFolderName(root));
    const stale = scratchAt(root, path.join(folder, 'atris-land-green-killed'), 5);
    const dry = run(root, home, { dryRun: true, activePaths: () => { throw new Error('a dry run looks at nothing'); } });
    assert.equal(dry.scratch_sweep, null);
    const blind = run(root, home, { activePaths: () => null });
    assert.deepEqual(blind.scratch_sweep.swept, []);
    assert.equal(fs.existsSync(stale), true);
    const seen = run(root, home, { activePaths: () => [] });
    assert.equal(seen.scratch_sweep.swept.length, 1);
    assert.equal(fs.existsSync(stale), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
