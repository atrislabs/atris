const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { autolandMemberRun, landingDestination } = require('../lib/member-autoland');

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

// A main checkout with no remote unless asked, a mission worktree on its own
// branch with one finished commit and a passing run receipt, and a fake gh on
// PATH that only logs, so any GitHub call shows up.
function fixture({ policy = '{"enabled":true}', remote = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-local-landing-'));
  const main = path.join(base, 'main');
  git(['init', '-q', '-b', 'master', main], base);
  git(['config', 'user.email', 'test@example.com'], main);
  git(['config', 'user.name', 'Test'], main);
  fs.writeFileSync(path.join(main, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(main, '.gitignore'), 'atris/runs/\natris/status/\n');
  git(['add', '.'], main);
  git(['commit', '-q', '-m', 'init'], main);
  if (remote) {
    const origin = path.join(base, 'origin.git');
    git(['init', '-q', '--bare', '-b', 'master', origin], base);
    git(['remote', 'add', 'origin', origin], main);
    git(['push', '-q', 'origin', 'master'], main);
  }
  if (policy !== null) {
    fs.mkdirSync(path.join(main, '.atris', 'policy'), { recursive: true });
    fs.writeFileSync(path.join(main, '.atris', 'policy', 'autoland.json'), policy);
  }
  const branch = 'codex/member-work';
  const worktree = path.join(base, 'wt');
  git(['worktree', 'add', '-q', '-b', branch, worktree, 'master'], main);
  fs.writeFileSync(path.join(worktree, 'work.txt'), 'done\n');
  git(['add', '.'], worktree);
  git(['commit', '-q', '-m', 'member work'], worktree);

  const bin = path.join(base, 'bin');
  const log = path.join(base, 'gh-calls.jsonl');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/usr/bin/env node',
    `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
  ].join('\n'), { mode: 0o755 });
  const fx = { base, main, worktree, bin, log, branch };
  writeRunReceipt(fx);
  return fx;
}

// The receipt a finished, reviewed run saves in the mission folder.
function writeRunReceipt(fx) {
  const dir = path.join(fx.worktree, 'atris', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const tree = git(['rev-parse', 'HEAD^{tree}'], fx.worktree);
  fs.writeFileSync(path.join(dir, `mission-mission-test-${at.replace(/[:.]/g, '-')}.json`), JSON.stringify({
    schema: 'atris.mission_receipt.v1',
    clean: true,
    git_tree: tree,
    mission_id: 'mission-test',
    at,
    result: {
      kind: 'mission_run_summary',
      tick_count: 1,
      ticks: [{
        status: 'ran', tick_index: 1, engine_id: 'claude', verifier_passed: true, reviewed_git_tree: tree,
        referee_result: { passed: true, mode: 'engine', engine: 'codex', output: 'VERDICT: PASS' },
      }],
    },
  }));
}

function mission() {
  return {
    id: 'mission-test',
    objective: 'Tidy the member board so finished work reads plainly to the operator every morning',
    owner: 'executor',
    runner: 'claude',
    lane: 'workspace',
    metadata: {},
    task_ids: [],
    verifier_result: { passed: true, command: 'git diff --check' },
    worktree: { branch: 'codex/member-work' },
    last_tick_at: '2000-01-01T00:00:00.000Z',
    last_tick_status: 'ran',
    last_tick_index: 1,
  };
}

function withFixture(opts, fn) {
  const fx = fixture(opts);
  const saved = process.env.PATH;
  process.env.PATH = `${fx.bin}${path.delimiter}${saved}`;
  try {
    return fn(fx);
  } finally {
    process.env.PATH = saved;
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
}

function land(fx) {
  return autolandMemberRun({ mission: mission(), cwd: fx.worktree, loadTask: () => null });
}

function ghCalled(fx) {
  return fs.existsSync(fx.log) && fs.readFileSync(fx.log, 'utf8').trim() !== '';
}

test('no remote: finished work merges into the main branch on this computer', () => {
  withFixture({}, (fx) => {
    const out = land(fx);
    assert.equal(out.merged, true, out.line);
    assert.equal(out.local, true);
    assert.equal(out.base, 'master');
    assert.match(out.line, /merged into master on this computer/);
    assert.equal(fs.readFileSync(path.join(fx.main, 'work.txt'), 'utf8'), 'done\n');
    git(['merge-base', '--is-ancestor', git(['rev-parse', 'HEAD'], fx.worktree), 'master'], fx.main);
    assert.equal(git(['status', '--porcelain', '--untracked-files=no'], fx.main), '');
    assert.equal(ghCalled(fx), false);
  });
});

test('no remote: a main branch that moved on is caught up, then lands', () => {
  withFixture({}, (fx) => {
    fs.writeFileSync(path.join(fx.main, 'other.txt'), 'meanwhile\n');
    git(['add', 'other.txt'], fx.main);
    git(['commit', '-q', '-m', 'someone else'], fx.main);
    const out = land(fx);
    assert.equal(out.merged, true, out.line);
    assert.equal(fs.readFileSync(path.join(fx.main, 'work.txt'), 'utf8'), 'done\n');
    assert.equal(fs.readFileSync(path.join(fx.main, 'other.txt'), 'utf8'), 'meanwhile\n');
  });
});

test('no remote: unsaved changes in the main checkout hold the branch', () => {
  withFixture({}, (fx) => {
    const before = git(['rev-parse', 'master'], fx.main);
    fs.writeFileSync(path.join(fx.main, 'README.md'), '# half edited\n');
    const out = land(fx);
    assert.equal(out.merged, false);
    assert.equal(out.gate, 'unsaved');
    assert.match(out.line, /^left the branch for you: the main checkout has unsaved changes/);
    assert.equal(git(['rev-parse', 'master'], fx.main), before);
    assert.equal(fs.readFileSync(path.join(fx.main, 'README.md'), 'utf8'), '# half edited\n');
  });
});

test('no remote: a real clash with the main branch holds the branch', () => {
  withFixture({}, (fx) => {
    fs.writeFileSync(path.join(fx.main, 'work.txt'), 'different\n');
    git(['add', 'work.txt'], fx.main);
    git(['commit', '-q', '-m', 'clash'], fx.main);
    const before = git(['rev-parse', 'master'], fx.main);
    const out = land(fx);
    assert.equal(out.merged, false);
    assert.equal(out.gate, 'conflict');
    assert.match(out.line, /clashes with the main branch in work\.txt/);
    assert.equal(git(['rev-parse', 'master'], fx.main), before);
  });
});

test('no remote: self-landing switched off still leaves the branch', () => {
  withFixture({ policy: null }, (fx) => {
    const before = git(['rev-parse', 'master'], fx.main);
    const out = land(fx);
    assert.equal(out.gate, 'policy');
    assert.equal(git(['rev-parse', 'master'], fx.main), before);
  });
});

test('the start says where finished work goes', () => {
  withFixture({}, (fx) => {
    assert.equal(landingDestination(fx.worktree),
      'finished work merges into master on this computer once its check and review pass');
  });
  withFixture({ remote: true }, (fx) => {
    assert.match(landingDestination(fx.worktree), /goes to GitHub as a pull request/);
  });
  withFixture({ policy: null }, (fx) => {
    assert.match(landingDestination(fx.worktree), /stays on its own branch for you; self-landing is off/);
  });
});
