'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.join(__dirname, '..', 'bin', 'atris.js');
const taskDbPath = path.join(__dirname, '..', 'lib', 'task-db.js');

// 05:30 UTC on Oct 23 is still the evening of Oct 22 in Los Angeles.
const FAKE_CLOCK = "const FIXED = Date.parse('2026-10-23T05:30:00Z'); const R = Date;"
  + ' global.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(FIXED); } static now() { return FIXED; } };\n';

test('task delegate and task day use the local day in the evening', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-task-day-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const ws = path.join(base, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(ws, 'atris'), { recursive: true });
  const clock = path.join(base, 'clock.js');
  fs.writeFileSync(clock, FAKE_CLOCK, 'utf8');
  const env = {
    ...process.env,
    HOME: home,
    TZ: 'America/Los_Angeles',
    ATRIS_TASKS_DB: path.join(base, 'tasks.db'),
    ATRIS_SKIP_UPDATE_CHECK: '1',
    CI: '1',
    NODE_NO_WARNINGS: '1',
  };
  const run = (args) => spawnSync(process.execPath, ['-r', clock, cli, ...args], { cwd: ws, encoding: 'utf8', env });

  const add = run(['task', 'delegate', 'Evening task so the day stamp stays honest', '--to', 'ada', '--json']);
  assert.equal(add.status, 0, add.stderr);
  const taskId = JSON.parse(add.stdout).task_id;
  const read = spawnSync(process.execPath, ['-e',
    `const db = require(${JSON.stringify(taskDbPath)}); process.stdout.write(db.getTask(db.open(), ${JSON.stringify(taskId)}).metadata.created_for_day);`,
  ], { cwd: ws, encoding: 'utf8', env });
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout, '2026-10-22');

  const day = run(['task', 'day', '--json']);
  assert.equal(day.status, 0, day.stderr);
  assert.equal(JSON.parse(day.stdout).date, '2026-10-22');
});
