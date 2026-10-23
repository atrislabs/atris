const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { tidyMemberCopies } = require('../lib/member-tidy');

test('infers worktrees directory from repository root', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidy-test-')));
  process.env.HOME = base;
  try {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo);
    const gitInit = spawnSync('git', ['init', '-q', '-b', 'master', repo]);
    assert.strictEqual(gitInit.status, 0);

    const result = tidyMemberCopies({ cwd: repo });
    assert.strictEqual(result.worktreesDir, path.join(base, '.agent-worktrees', 'repo'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
