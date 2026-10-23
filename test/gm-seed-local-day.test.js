'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const gm = path.join(__dirname, '..', 'commands', 'gm.js');

// 05:30 UTC on Oct 23 is still the evening of Oct 22 in Los Angeles.
const FAKE_CLOCK = "const FIXED = Date.parse('2026-10-23T05:30:00Z'); const R = Date;"
  + ' global.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(FIXED); } static now() { return FIXED; } };';

test('the starter mission gm seeds is made for the local day', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-gm-day-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  const code = `${FAKE_CLOCK} const { ensureStarterMission } = require(${JSON.stringify(gm)});
let added = null;
const fakeDb = {
  addTask: (db, task) => { added = task; return { id: 'task-1' }; },
  noteTask: () => {},
  listTasks: () => [],
  withTaskDisplayRefs: (tasks) => tasks,
};
ensureStarterMission(fakeDb, {}, ${JSON.stringify(root)}, [], ['--player', 'ada']);
process.stdout.write(String(added && added.metadata.created_for_day));`;
  const res = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/Los_Angeles', ATRIS_PLAYER: 'ada' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, '2026-10-22');
});
