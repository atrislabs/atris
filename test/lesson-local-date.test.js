'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const cli = path.join(__dirname, '..', 'bin', 'atris.js');

function localDay(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// A lesson is dated by the writer's own calendar day, not the UTC day.
test('lesson add dates the lesson with the local day', (t) => {
  const utcDay = new Date().toISOString().slice(0, 10);
  // At any moment one of these two zones sits on a different calendar day than UTC.
  const timeZone = localDay('Etc/GMT+12') !== utcDay ? 'Etc/GMT+12' : 'Etc/GMT-14';
  const day = localDay(timeZone);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-lesson-date-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const root = path.join(base, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'lessons.md'), '# lessons\n\n---\n', 'utf8');
  const res = spawnSync(process.execPath, [cli, 'lesson', 'add', 'evening-note', 'pass', 'dated by the local day'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, TZ: timeZone, ATRIS_SKIP_UPDATE_CHECK: '1', CI: '1' },
  });
  assert.equal(res.status, 0, res.stderr);
  const lessons = fs.readFileSync(path.join(root, 'atris', 'lessons.md'), 'utf8');
  assert.ok(lessons.includes(`- **[${day}] evening-note** - pass - dated by the local day`), lessons);
});
