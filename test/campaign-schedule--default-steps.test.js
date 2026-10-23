'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const schedule = require('../lib/campaign-schedule');

const { DEFAULT_STEPS, describe, parseEvery, readSchedule, saveSchedule } = schedule;

// Fixed instant on a whole minute, so interval slots never depend on the clock or time zone.
const NOW = Date.UTC(2026, 0, 5, 12, 0, 0);
const MIN = 60 * 1000;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-default-steps-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function saveWith(campaignId, extra = {}) {
  const parsed = parseEvery('30m');
  return saveSchedule(home, campaignId, { every: parsed.every, rule: parsed.rule, by: 'human:test', now: NOW, ...extra });
}

test('DEFAULT_STEPS is a constant positive whole number exported by the module', () => {
  assert.ok(Object.keys(schedule).includes('DEFAULT_STEPS'));
  assert.strictEqual(typeof DEFAULT_STEPS, 'number');
  assert.strictEqual(DEFAULT_STEPS, 4);
  assert.ok(Number.isInteger(DEFAULT_STEPS) && DEFAULT_STEPS > 0);
  // It is a value to read, not a function to call.
  assert.throws(() => DEFAULT_STEPS(), TypeError);
});

test('saveSchedule falls back to DEFAULT_STEPS and the value survives a round trip to disk', () => {
  const saved = saveWith('default-steps-omitted');
  assert.strictEqual(saved.steps, DEFAULT_STEPS);
  assert.strictEqual(saved.next_at, NOW + 30 * MIN);

  const onDisk = readSchedule(home, 'default-steps-omitted');
  assert.strictEqual(onDisk.steps, DEFAULT_STEPS);
  assert.strictEqual(onDisk.campaign_id, 'default-steps-omitted');
  assert.strictEqual(onDisk.approved_at, new Date(NOW).toISOString());
});

test('an explicit steps value beats the default, and an explicit undefined still gets it', () => {
  assert.strictEqual(saveWith('default-steps-two', { steps: 2 }).steps, 2);
  assert.strictEqual(saveWith('default-steps-one', { steps: 1 }).steps, 1);
  assert.strictEqual(saveWith('default-steps-undefined', { steps: undefined }).steps, DEFAULT_STEPS);
  assert.strictEqual(readSchedule(home, 'default-steps-two').steps, 2);
});

test('describe words the default step count in the plural', () => {
  const text = describe(saveWith('default-steps-describe'));
  assert.ok(text.startsWith(`30m, up to ${DEFAULT_STEPS} steps each time; next `), text);

  const single = describe(saveWith('default-steps-describe-one', { steps: 1 }));
  assert.ok(single.startsWith('30m, up to 1 step each time; next '), single);
});

test('nothing is saved for an unknown campaign, so there is no default to read back', () => {
  assert.strictEqual(readSchedule(home, 'default-steps-never-saved'), null);
  assert.strictEqual(readSchedule('', 'default-steps-never-saved'), null);
});
