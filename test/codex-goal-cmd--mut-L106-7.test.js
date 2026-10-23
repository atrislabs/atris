const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { codexGoalCommand } = require('../commands/codex-goal');

const marker = 'goal-read-failed-marker';

test('a failed goal read reports the sqlite detail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-codex-goal-mut-L106-'));
  const bin = path.join(dir, 'bin');
  const db = path.join(dir, 'goals.sqlite');
  fs.mkdirSync(bin);
  fs.writeFileSync(db, '');
  fs.writeFileSync(path.join(bin, 'sqlite3'), `#!/bin/sh
printf '%s\\n' '${marker}' >&2
exit 7
`);
  fs.chmodSync(path.join(bin, 'sqlite3'), 0o755);

  const saved = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CODEX_STATE_DB: process.env.CODEX_STATE_DB,
    CODEX_THREADS_DB: process.env.CODEX_THREADS_DB,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
  };
  process.env.PATH = bin;
  delete process.env.HOME;
  delete process.env.CODEX_STATE_DB;
  delete process.env.CODEX_THREADS_DB;
  delete process.env.CODEX_THREAD_ID;

  let thrown = null;
  try {
    codexGoalCommand(['status', '--state', db]);
  } catch (error) {
    thrown = error;
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, marker);
});
