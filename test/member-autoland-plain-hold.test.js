const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { autolandMemberRun } = require('../lib/member-autoland');

test('with self-landing off, a passing run names its branch and the command that brings it in', () => {
  // Member lab 2026-10-24: "left the branch for you: self-landing is not
  // switched on" read as if the fix were already in the user's files.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-plain-hold-'));
  try {
    const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'seed');
    git('checkout', '-q', '-b', 'executor-fix-scan');
    const result = autolandMemberRun({ mission: { verifier_result: { passed: true }, worktree: { branch: 'executor-fix-scan' } }, cwd: dir });
    assert.equal(result.merged, false);
    assert.equal(result.gate, 'policy');
    assert.equal(result.line, 'your files are not changed yet: the work is saved on branch executor-fix-scan. bring it in: git merge executor-fix-scan');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
