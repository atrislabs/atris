'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { changedSkillFiles } = require('../lib/skill-eval-gate');

test('committed skill changes retain the commit timestamp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-commit-time-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  const git = (...args) => {
    const result = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: path.join(root, 'no-config'),
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.com',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.com',
        GIT_AUTHOR_DATE: '2026-01-15T12:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-15T12:00:00Z',
      },
    });
    if (result.status !== 0) throw new Error(result.stderr || 'git failed');
  };
  try {
    git('init', '-b', 'master');
    git('commit', '--allow-empty', '-m', 'seed');
    git('checkout', '-b', 'change');
    fs.mkdirSync(path.join(root, 'skills', 'example'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', 'example', 'SKILL.md'), '# Example\n');
    git('add', '.');
    git('commit', '-m', 'add skill');
    const skill = changedSkillFiles(root).find((entry) => entry.path === 'skills/example/SKILL.md');
    assert.equal(skill?.changed_at_ms, Date.parse('2026-01-15T12:00:00Z'));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
