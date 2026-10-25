const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { saveLeftoverMemberWork } = require('../lib/member-save-work');

function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function repoWithWorktree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-save-work-'));
  const main = path.join(base, 'main');
  fs.mkdirSync(main);
  git(['init', '-q', '-b', 'main'], main);
  fs.writeFileSync(path.join(main, 'app.js'), 'old\n');
  git(['add', '-A'], main);
  git(['commit', '-qm', 'seed'], main);
  const side = path.join(base, 'side');
  git(['worktree', 'add', '-q', '-b', 'navigator-job', side], main);
  git(['config', 'user.email', 't@t'], side);
  git(['config', 'user.name', 't'], side);
  return { base, main, side };
}

test('loose work in a member checkout is committed on its branch, atris state left out', () => {
  const { base, main, side } = repoWithWorktree();
  try {
    fs.writeFileSync(path.join(side, 'answers.json'), '{"line":3}\n');
    fs.writeFileSync(path.join(side, 'app.js'), 'new\n');
    fs.mkdirSync(path.join(side, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(side, '.atris', 'state', 'engines.json'), '{}\n');
    const saved = saveLeftoverMemberWork({ worktreePath: side, member: 'navigator', objective: 'find the bug line.\n\nwrite answers.json' });
    assert.equal(saved.saved, true);
    assert.deepEqual(saved.files.sort(), ['answers.json', 'app.js']);
    assert.equal(git(['show', 'navigator-job:answers.json'], main), '{"line":3}');
    assert.match(git(['log', '-1', '--format=%s', 'navigator-job'], main), /^navigator: find the bug line\.$/);
    assert.ok(fs.existsSync(path.join(side, '.atris', 'state', 'engines.json')));
    assert.equal(git(['status', '--porcelain', '--', '.atris'], side), '?? .atris/');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a member that already committed leaves nothing to save', () => {
  const { base, side } = repoWithWorktree();
  try {
    assert.deepEqual(saveLeftoverMemberWork({ worktreePath: side, member: 'executor' }), { saved: false, reason: 'nothing_left' });
    assert.equal(saveLeftoverMemberWork({}).reason, 'no_worktree');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a job that forbids commits keeps its changes loose', () => {
  const { base, side } = repoWithWorktree();
  try {
    fs.writeFileSync(path.join(side, 'app.js'), 'new\n');
    for (const objective of ['fix the failing test. do not create a commit.', "fix it, don't commit", 'fix it without committing']) {
      assert.equal(saveLeftoverMemberWork({ worktreePath: side, objective }).reason, 'job_forbids_commit');
    }
    assert.equal(git(['status', '--porcelain'], side), 'M app.js');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
