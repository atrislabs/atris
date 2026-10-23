'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { founderCommand } = require('../commands/founder');

test('founder root scan excludes the agent-worktrees directory even when it is a repo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'founder-scan-'));
  const originalLog = console.log;
  const output = [];
  try {
    fs.mkdirSync(path.join(root, 'atris'));
    // Both entries are real repositories. Only the ordinary project belongs
    // in the scorecard, regardless of whether either has any commits yet.
    for (const name of ['project', '.agent-worktrees']) {
      const repo = path.join(root, name);
      fs.mkdirSync(repo);
      execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo], {
        cwd: root,
        stdio: 'pipe',
      });
    }
    console.log = (line) => output.push(line);
    const code = founderCommand(['--root', root, '--json'], {
      cwd: root,
      env: { ATRIS_FOUNDER_NOW: '2026-08-10T12:00:00Z' },
    });
    assert.equal(code, 0);
    assert.deepEqual(output, [JSON.stringify({
      ts: '2026-08-10T12:00:00.000Z',
      days: 28,
      commitsThisWeek: 0,
      commitsLastWeek: 0,
      slopePct: 0,
      tasksThisWeek: null,
      tasksLastWeek: null,
      perRepo: [{
        repo: 'project',
        commitsThisWeek: 0,
        commitsLastWeek: 0,
        perDay: {},
      }],
    }, null, 2)]);
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
