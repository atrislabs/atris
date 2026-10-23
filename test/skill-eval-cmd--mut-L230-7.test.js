'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skillEvalCommand } = require('../commands/skill-eval');

test('review workspace preserves the committed previous instructions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-history-'));
  const oldHome = process.env.HOME;
  const oldCwd = process.cwd();
  const oldLog = console.log;
  const oldError = console.error;
  const oldExit = process.exit;
  const previous = '# Publishing\n\nAsk the owner before publishing a release.\n';
  let savedPrevious;
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = () => {};
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    const git = (...args) => {
      const result = spawnSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
          GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
          GIT_AUTHOR_DATE: '2025-01-15T12:00:00Z', GIT_COMMITTER_DATE: '2025-01-15T12:00:00Z' },
      });
      if (result.status !== 0) throw new Error(result.stderr || 'fixture git failed');
    };
    git('init', '-b', 'master');
    fs.writeFileSync(path.join(root, 'SKILL.md'), previous);
    git('add', 'SKILL.md');
    git('commit', '-m', 'initial instructions');
    fs.writeFileSync(path.join(root, 'SKILL.md'), '# Publishing\n\nPublish the release.\n');
    skillEvalCommand(['SKILL.md', '--worker-model', 'human'], {
      root,
      fs: {
        mkdtempSync: () => fs.mkdtempSync(path.join(root, 'review-')),
        rmSync: (directory, options) => {
          savedPrevious = fs.readFileSync(path.join(directory, 'previous-skill.md'), 'utf8');
          fs.rmSync(directory, options);
        },
      },
      getEngineAdapter: () => { throw new Error('review engine unavailable'); },
    });
    assert.strictEqual(savedPrevious, previous);
  } finally {
    process.chdir(oldCwd);
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    console.log = oldLog;
    console.error = oldError;
    process.exit = oldExit;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
