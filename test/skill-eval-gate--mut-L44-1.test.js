'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { changedSkillFiles } = require('../lib/skill-eval-gate');

test('committed skill edit is found against the main branch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-committed-'));
  const env = {
    ...process.env,
    HOME: root,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
    GIT_AUTHOR_DATE: '2026-01-01T12:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T12:00:00Z',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  function git(...args) {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  git('init', '-b', 'master');
  const skill = 'atris/skills/example/SKILL.md';
  fs.mkdirSync(path.dirname(path.join(root, skill)), { recursive: true });
  fs.writeFileSync(path.join(root, skill), '# Example\n');
  git('add', '.');
  git('commit', '-m', 'initial skill');
  git('checkout', '-b', 'skill-edit');
  fs.appendFileSync(path.join(root, skill), '\nCheck the result.\n');
  git('add', '.');
  git('commit', '-m', 'improve skill');
  fs.utimesSync(path.join(root, skill), 1767268800, 1767268800);
  const changes = changedSkillFiles(root);
  assert.equal(changes.some((entry) => entry.path === skill), true);
});
