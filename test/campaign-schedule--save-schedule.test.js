'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-schedule-save-'));
process.env.HOME = home;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { saveSchedule } = require('../lib/campaign-schedule');

// Fixed instants. 1705320019250 is 2024-01-15T12:00:19.250Z.
const NOW = 1705320019250;
const MINUTE = 60 * 1000;

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function scheduleFile(campaignId) {
  return path.join(home, 'campaigns', campaignId, 'schedule.json');
}

function readSaved(campaignId) {
  return fs.readFileSync(scheduleFile(campaignId), 'utf8');
}

test('saveSchedule stores an interval schedule and the file matches it', () => {
  const saved = saveSchedule(home, 'cmp-morning', {
    every: '30m',
    rule: { kind: 'interval', ms: 30 * MINUTE },
    steps: 2,
    by: 'human:ada',
    now: NOW,
  });

  const expected = {
    campaign_id: 'cmp-morning',
    every: '30m',
    rule: { kind: 'interval', ms: 30 * MINUTE },
    steps: 2,
    approved_by: 'human:ada',
    approved_at: '2024-01-15T12:00:19.250Z',
    last_fired_at: null,
    next_at: 1705321800000,
  };

  assert.deepStrictEqual(saved, expected);
  assert.strictEqual(saved.next_at % MINUTE, 0);
  assert.ok(saved.next_at > NOW);
  assert.strictEqual(readSaved('cmp-morning'), `${JSON.stringify(expected, null, 2)}\n`);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(scheduleFile('cmp-morning'))), ['schedule.json']);
});

test('saveSchedule uses four steps when none are given and lands a late interval on the minute', () => {
  const late = 1705320019000;
  const saved = saveSchedule(home, 'cmp-soon', {
    every: '1m',
    rule: { kind: 'interval', ms: MINUTE },
    by: 'human:ada',
    now: late,
  });

  assert.strictEqual(saved.steps, 4);
  assert.strictEqual(saved.approved_at, '2024-01-15T12:00:19.000Z');
  assert.strictEqual(saved.last_fired_at, null);
  assert.strictEqual(saved.next_at, 1705320060000);
  assert.ok(saved.next_at > late);
  assert.ok(saved.next_at < late + MINUTE);
  assert.strictEqual(saved.next_at % MINUTE, 0);
  assert.deepStrictEqual(JSON.parse(readSaved('cmp-soon')), saved);
});

test('saveSchedule writes nothing when the time is empty or the rule is missing', () => {
  assert.throws(() => saveSchedule(home, 'cmp-missing', {
    every: '',
    rule: { kind: 'interval', ms: MINUTE },
    steps: 1,
    by: 'human:ada',
    now: '',
  }), { name: 'RangeError', message: 'Invalid time value' });

  assert.throws(() => saveSchedule(home, 'cmp-missing', {
    every: '30m',
    rule: null,
    by: 'human:ada',
    now: NOW,
  }), { name: 'TypeError', message: "Cannot read properties of null (reading 'kind')" });

  assert.strictEqual(fs.existsSync(scheduleFile('cmp-missing')), false);
});
