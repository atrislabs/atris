'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { changedSkillFiles } = require('../lib/skill-eval-gate');

test('a staged skill uses the git index modification time', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-gate-index-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git('init', '-b', 'master');
    fs.writeFileSync(path.join(root, 'SKILL.md'), '# staged skill\n');
    git('add', 'SKILL.md');

    // The staged content has no worktree change, so only the index supplies its time.
    const index = path.resolve(root, git('rev-parse', '--git-path', 'index'));
    const timestamp = new Date('2020-01-02T03:04:05.000Z');
    fs.utimesSync(index, timestamp, timestamp);
    const expectedMs = fs.statSync(index).mtimeMs;
    assert.deepEqual(changedSkillFiles(root), [{
      path: 'SKILL.md',
      changed_at_ms: expectedMs,
      changed_at: new Date(expectedMs).toISOString(),
      sources: ['staged'],
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
