'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const autoLessons = path.join(__dirname, '..', 'lib', 'auto-lessons.js');

// 05:30 UTC on Oct 23 is still the evening of Oct 22 in Los Angeles.
test('an automatic lesson is dated by the local day', () => {
  const code = `const { fileAutoLessons } = require(${JSON.stringify(autoLessons)});
const fs = require('fs'); const os = require('os'); const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-auto-lessons-day-'));
fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
const ep = (id, task) => ({ episode_id: id, task_id: task, created_at: '2026-10-22T12:00:00Z',
  action: { event_type: 'revision_requested' }, human_feedback: { human_revision_note: 'Say the decision first.' },
  rl: { label: 'rework_requested', source: 'task_revision' } });
fileAutoLessons(root, { episodes: [ep('e1', 't1'), ep('e2', 't2')], now: new Date('2026-10-23T05:30:00Z') });
const lessons = JSON.parse(fs.readFileSync(path.join(root, 'atris', 'lessons.json'), 'utf8'));
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write(JSON.stringify(Object.values(lessons).map((l) => [l.date, l.last_detected])));`;
  const res = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'America/Los_Angeles' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), [['2026-10-22', '2026-10-22']]);
});
