'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');

// A command that throws before it returns a promise must still print one
// clean error line, not a raw Node stack trace.
test('a command that fails right away prints one error line, not a stack trace', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sync-error-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'not-a-repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const res = spawnSync(process.execPath, [cliPath, 'worktree'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, GIT_CEILING_DIRECTORIES: base, CI: '1' },
    timeout: 30000,
  });
  const out = `${res.stdout}\n${res.stderr}`;
  assert.equal(res.status, 1, out);
  assert.match(res.stderr, /✗ Error: .*not a git repository/);
  assert.doesNotMatch(out, /\n\s+at .+\.js:\d+:\d+/, 'no stack trace lines');
});
