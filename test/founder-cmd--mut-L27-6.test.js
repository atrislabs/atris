'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { founderCommand } = require('../commands/founder');

test('a quiet git wrapper keeps task scoring in the requested workspace', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-git-score-'));
  const workspace = path.join(temp, 'project');
  const bin = path.join(temp, 'bin');
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  const output = [];
  try {
    process.env.HOME = temp;
    const git = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fs.mkdirSync(path.join(temp, 'atris'));
    fs.mkdirSync(path.join(workspace, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.atris', 'state'), { recursive: true });
    fs.mkdirSync(bin);
    execFileSync(git, ['init', '-q', workspace]);
    fs.writeFileSync(path.join(bin, 'git'),
      `#!/bin/sh\nexec '${git.replace(/'/g, "'\\''")}' "$@" >/dev/null\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(workspace, '.atris', 'state', 'tasks.projection.json'), JSON.stringify({
      tasks: [{ status: 'done', done_at: '2026-08-08T10:00:00Z' }],
    }));
    process.env.PATH = bin + path.delimiter + (originalEnv.PATH || '/usr/bin:/bin');
    process.chdir(temp);
    console.log = (...args) => output.push(args.join(' '));
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };

    founderCommand(['--json'], {
      cwd: workspace,
      env: { HOME: temp, ATRIS_FOUNDER_NOW: '2026-08-10T12:00:00Z' },
    });
    assert.strictEqual(JSON.parse(output.join('\n')).tasksThisWeek, 1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
});
