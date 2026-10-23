'use strict';

// removeSchedule deletes one campaign's schedule.json and nothing else. It takes
// the home folder as an argument and reads no environment, so every test points
// it at a fresh temp folder and passes a fixed `now` into saveSchedule.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseEvery, readSchedule, removeSchedule, saveSchedule, scheduleFile,
} = require('../lib/campaign-schedule');

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const made = [];

function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-schedule-remove-'));
  made.push(dir);
  return dir;
}

function saveDaily(home, campaignId) {
  const { rule, error } = parseEvery('daily 09:00');
  assert.equal(error, undefined);
  return saveSchedule(home, campaignId, { every: 'daily 09:00', rule, by: 'keshav', now: NOW });
}

after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

test('removes the saved schedule file and reports true', () => {
  const home = makeHome();
  saveDaily(home, 'camp-a');
  const file = scheduleFile(home, 'camp-a');
  assert.equal(file, path.join(home, 'campaigns', 'camp-a', 'schedule.json'));
  assert.equal(fs.existsSync(file), true);
  assert.notEqual(readSchedule(home, 'camp-a'), null);

  assert.equal(removeSchedule(home, 'camp-a'), true);

  assert.equal(fs.existsSync(file), false);
  assert.equal(readSchedule(home, 'camp-a'), null);
});

test('a second remove on the same campaign reports false and does not throw', () => {
  const home = makeHome();
  saveDaily(home, 'camp-b');
  assert.equal(removeSchedule(home, 'camp-b'), true);

  assert.equal(removeSchedule(home, 'camp-b'), false);
  assert.equal(readSchedule(home, 'camp-b'), null);
});

test('a campaign that never had a schedule reports false and creates nothing', () => {
  const home = makeHome();

  assert.equal(removeSchedule(home, 'never-scheduled'), false);

  assert.equal(fs.existsSync(path.join(home, 'campaigns')), false);
});

test('removing one campaign leaves another campaign schedule in place', () => {
  const home = makeHome();
  saveDaily(home, 'camp-c');
  saveDaily(home, 'camp-d');

  assert.equal(removeSchedule(home, 'camp-c'), true);

  assert.equal(readSchedule(home, 'camp-c'), null);
  const kept = readSchedule(home, 'camp-d');
  assert.notEqual(kept, null);
  assert.equal(kept.campaign_id, 'camp-d');
  assert.equal(kept.every, 'daily 09:00');
});
