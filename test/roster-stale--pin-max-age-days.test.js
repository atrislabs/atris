'use strict';

// PIN_MAX_AGE_DAYS is the number of days a pinned model can go without a
// "verified <date>" before the roster calls the pin old. It is a plain number,
// so these tests read it and drive it through attachStaleModels with a fixed
// "now" and fixed dates.

const test = require('node:test');
const assert = require('node:assert');

const { PIN_MAX_AGE_DAYS, attachStaleModels } = require('../lib/roster-stale');

const NOW = new Date(2026, 8, 30, 12, 0, 0);

function dayText(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function daysBeforeNow(days) {
  return dayText(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - days));
}

function reportVerified(verified, model = 'claude-opus-5-5') {
  return {
    jobs: [
      {
        job: 'build',
        from: 'all projects',
        file: '~/.atris/ROSTER.md',
        workers: [
          {
            engine: 'claude',
            model,
            status: 'leads',
            why: '',
            line: 7,
            verified,
            runs: { engine: 'claude', model, model_source: 'roster', text: `claude (${model})` },
          },
        ],
      },
    ],
    team: [],
  };
}

function oldPins(out) {
  return out.stale.filter((item) => item.kind === 'old pin');
}

test('the limit is 30 days, a whole positive number', () => {
  assert.strictEqual(PIN_MAX_AGE_DAYS, 30);
  assert.strictEqual(typeof PIN_MAX_AGE_DAYS, 'number');
  assert.ok(Number.isInteger(PIN_MAX_AGE_DAYS) && PIN_MAX_AGE_DAYS > 0);
});

test('a pin verified exactly at the limit is fine, one day past it is flagged', () => {
  const atLimit = attachStaleModels(reportVerified(daysBeforeNow(PIN_MAX_AGE_DAYS)), { catalog: {}, runs: [], now: NOW });
  assert.strictEqual(atLimit.jobs[0].workers[0].pin_age_days, PIN_MAX_AGE_DAYS);
  assert.strictEqual(atLimit.jobs[0].pin_age_days, PIN_MAX_AGE_DAYS);
  assert.deepStrictEqual(oldPins(atLimit), []);

  const verified = daysBeforeNow(PIN_MAX_AGE_DAYS + 1);
  const pastLimit = attachStaleModels(reportVerified(verified), { catalog: {}, runs: [], now: NOW });
  assert.strictEqual(pastLimit.jobs[0].workers[0].pin_age_days, PIN_MAX_AGE_DAYS + 1);
  const flagged = oldPins(pastLimit);
  assert.strictEqual(flagged.length, 1);
  assert.strictEqual(flagged[0].pin_age_days, 31);
  assert.strictEqual(flagged[0].pin_verified_at, verified);
  assert.match(flagged[0].text, /^build: claude code on opus 5\.5 was last verified 31 days ago \(roster line\)\. smoke one prompt, then add "verified 2026-09-30" on line 7 of ~\/\.atris\/ROSTER\.md$/);
});

test('a pin verified today has age zero and is not flagged', () => {
  const out = attachStaleModels(reportVerified(daysBeforeNow(0)), { catalog: {}, runs: [], now: NOW });
  assert.strictEqual(out.jobs[0].workers[0].pin_age_days, 0);
  assert.strictEqual(out.jobs[0].workers[0].pin_verified_at, '2026-09-30');
  assert.deepStrictEqual(out.stale, []);
});

test('no verified date or an impossible one leaves the age empty and raises no flag', () => {
  const none = attachStaleModels(reportVerified(undefined), { catalog: {}, runs: [], now: NOW });
  assert.strictEqual(none.jobs[0].workers[0].pin_age_days, null);
  assert.strictEqual(none.jobs[0].workers[0].pin_verified_at, null);
  assert.deepStrictEqual(none.stale, []);

  const impossible = attachStaleModels(reportVerified('2026-02-31'), { catalog: {}, runs: [], now: NOW });
  assert.strictEqual(impossible.jobs[0].workers[0].pin_verified_at, '2026-02-31');
  assert.strictEqual(impossible.jobs[0].workers[0].pin_age_days, null);
  assert.deepStrictEqual(oldPins(impossible), []);
});

test('an old pin on a model with a newer version only gets the newer-model line', () => {
  const verified = daysBeforeNow(PIN_MAX_AGE_DAYS + 20);
  const out = attachStaleModels(reportVerified(verified, 'claude-opus-4-6'), { catalog: { claude: ['opus 5.5'] }, runs: [], now: NOW });
  assert.strictEqual(out.jobs[0].workers[0].pin_age_days, PIN_MAX_AGE_DAYS + 20);
  assert.deepStrictEqual(out.stale.map((item) => item.kind), ['newer model']);
  assert.deepStrictEqual(oldPins(out), []);
});
