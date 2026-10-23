'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { markFired, readSchedule, scheduleFile } = require('../lib/campaign-schedule');

function makeTempHome(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mark-fired-test-'));
  process.env.HOME = tmp;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }
  t.after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });
  return tmp;
}

test('markFired updates last_fired_at, advances next_at, and writes to disk', (t) => {
  const home = makeTempHome(t);
  const campaignId = 'cmp-normal-01';
  const now = 1700000040000; // Whole minute: 28333334 * 60000
  const initialSchedule = {
    campaign_id: campaignId,
    every: '30m',
    rule: { kind: 'interval', ms: 30 * 60 * 1000 },
    steps: 4,
    approved_by: 'human:tester',
    approved_at: '2023-11-14T20:00:00.000Z',
    last_fired_at: null,
    next_at: now,
  };

  const updated = markFired(home, campaignId, initialSchedule, now);

  const expectedNextAt = now + 30 * 60 * 1000;
  const expectedLastFiredAt = new Date(now).toISOString();

  assert.strictEqual(updated.campaign_id, campaignId);
  assert.strictEqual(updated.every, '30m');
  assert.strictEqual(updated.steps, 4);
  assert.strictEqual(updated.approved_by, 'human:tester');
  assert.strictEqual(updated.last_fired_at, expectedLastFiredAt);
  assert.strictEqual(updated.next_at, expectedNextAt);

  const filePath = scheduleFile(home, campaignId);
  assert.strictEqual(fs.existsSync(filePath), true);

  const savedOnDisk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepStrictEqual(savedOnDisk, updated);

  const reloaded = readSchedule(home, campaignId);
  assert.deepStrictEqual(reloaded, updated);
});

test('markFired handles edge cases: sub-minute alignment, consecutive firing, and null next_at', (t) => {
  const home = makeTempHome(t);
  const campaignId = 'cmp-edge-01';

  // Sub-minute epoch timestamp: interval next_at rounds down to whole minute boundary
  const baseMinute = 1700000045123;
  const intervalMs = 15 * 60 * 1000;
  const schedule1 = {
    campaign_id: campaignId,
    rule: { kind: 'interval', ms: intervalMs },
    steps: 2,
    last_fired_at: null,
    next_at: baseMinute,
  };

  const fired1 = markFired(home, campaignId, schedule1, baseMinute);
  const expectedMinuteAligned = Math.floor((baseMinute + intervalMs) / 60000) * 60000;
  assert.strictEqual(fired1.next_at, expectedMinuteAligned);
  assert.strictEqual(fired1.last_fired_at, new Date(baseMinute).toISOString());

  // Consecutive firing overwrites last_fired_at and advances next_at again
  const laterTime = baseMinute + 900000;
  const fired2 = markFired(home, campaignId, fired1, laterTime);
  assert.strictEqual(fired2.last_fired_at, new Date(laterTime).toISOString());
  assert.strictEqual(fired2.next_at, Math.floor((laterTime + intervalMs) / 60000) * 60000);

  // Clock rule with no matching days produces null next_at
  const scheduleNoDays = {
    campaign_id: 'cmp-edge-nodays',
    rule: { kind: 'clock', days: [], hour: 9, minute: 0 },
    steps: 1,
    last_fired_at: null,
    next_at: 1700000000000,
  };
  const firedNoDays = markFired(home, 'cmp-edge-nodays', scheduleNoDays, baseMinute);
  assert.strictEqual(firedNoDays.next_at, null);
  assert.strictEqual(firedNoDays.last_fired_at, new Date(baseMinute).toISOString());

  const savedNoDays = JSON.parse(fs.readFileSync(scheduleFile(home, 'cmp-edge-nodays'), 'utf8'));
  assert.strictEqual(savedNoDays.next_at, null);
});

test('markFired throws on invalid inputs and unwritable filesystem targets', (t) => {
  const home = makeTempHome(t);
  const now = 1700000000000;

  // Invalid schedules
  assert.throws(() => {
    markFired(home, 'cmp-err', null, now);
  }, TypeError);

  assert.throws(() => {
    markFired(home, 'cmp-err', {}, now);
  }, TypeError);

  assert.throws(() => {
    markFired(home, 'cmp-err', { rule: null }, now);
  }, TypeError);

  // Unwritable directory structure
  const blockedHome = path.join(home, 'blocked');
  fs.mkdirSync(blockedHome, { recursive: true });
  fs.writeFileSync(path.join(blockedHome, 'campaigns'), 'blocking-file');

  assert.throws(() => {
    markFired(blockedHome, 'cmp-err', { rule: { kind: 'interval', ms: 60000 } }, now);
  });
});
