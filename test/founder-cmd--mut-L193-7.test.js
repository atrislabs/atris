'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { founderCommand } = require('../commands/founder');

test('founder breaks equal current-week scores by prior-week commits before repo name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'founder-prior-week-order-'));
  const originalLog = console.log;
  try {
    // Explicit identity, dates and configuration keep the fixtures independent
    // of the user's git setup, environment and local time zone.
    const gitEnv = {
      HOME: root,
      XDG_CONFIG_HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(root, 'unused-gitconfig'),
      GIT_AUTHOR_NAME: 'founder test',
      GIT_AUTHOR_EMAIL: 'founder@test.invalid',
      GIT_COMMITTER_NAME: 'founder test',
      GIT_COMMITTER_EMAIL: 'founder@test.invalid',
    };
    for (const [name, priorCommits] of [['alpha', 1], ['zulu', 2]]) {
      const repo = path.join(root, name);
      fs.mkdirSync(repo);
      execFileSync('git', ['init', '-q', '--initial-branch=main', repo], { env: gitEnv });
      for (let i = 0; i <= priorCommits; i += 1) {
        const date = i === priorCommits ? '2026-08-08T10:00:00Z' : '2026-07-30T10:00:00Z';
        execFileSync('git', [
          '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
          'commit', '--allow-empty', '-q', '-m', `fixture ${i}`,
        ], {
          cwd: repo,
          env: { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        });
      }
    }
    fs.mkdirSync(path.join(root, 'atris'));
    const output = [];
    console.log = (...args) => output.push(args.join(' '));
    const result = founderCommand(['--root', root], {
      cwd: root,
      env: { ATRIS_FOUNDER_NOW: '2026-08-10T12:00:00Z' },
    });
    assert.equal(result, 0);
    assert.deepEqual(output, [
      'last 7 days: 2 commits landed across 2 projects. prior 7 days: 3. slope: -33%.\n'
      + 'zulu: 1 last 7 days, 2 prior 7 days.\n'
      + 'alpha: 1 last 7 days, 1 prior 7 days.\n'
      + 'no task data.',
    ]);
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
