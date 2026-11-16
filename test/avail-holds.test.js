'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'avail-holds-'));
process.env.HOME = tmpHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const {
  availCommand,
  holdAvail,
  holdsAvail,
  unholdAvail,
  parseHoldArgs,
  buildHoldBodies,
  buildOffPayload,
  parseSetArgs,
  resolveHoldDate,
  zonedIso,
  weeklyHoursOff,
  isReadOnlyAvail,
} = require('../commands/avail');

after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

const LA = 'America/Los_Angeles';
// Monday Nov 16 2026, 10:00am in Los Angeles.
const MON_10AM = new Date('2026-11-16T18:00:00Z');

async function capture(fn) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  let code;
  try {
    code = await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

function fakeDeps(replies = {}) {
  const calls = [];
  return {
    calls,
    getToken: async () => 'tok',
    timezone: async () => LA,
    now: () => MON_10AM,
    request: async (p, options) => {
      calls.push({ path: p, ...options });
      const reply = replies[`${options.method} ${p.split('?')[0]}`];
      return typeof reply === 'function' ? reply(options) : reply || { ok: true, data: {} };
    },
  };
}

test('day words resolve in the booking timezone', () => {
  assert.equal(resolveHoldDate('today', LA, MON_10AM), '2026-11-16');
  assert.equal(resolveHoldDate('tomorrow', LA, MON_10AM), '2026-11-17');
  assert.equal(resolveHoldDate('thu', LA, MON_10AM), '2026-11-19');
  assert.equal(resolveHoldDate('Thursday', LA, MON_10AM), '2026-11-19');
  assert.equal(resolveHoldDate('sun', LA, MON_10AM), '2026-11-22');
  assert.equal(resolveHoldDate('2026-11-20', LA, MON_10AM), '2026-11-20');
});

test('the same weekday is today while the start is ahead, else next week', () => {
  assert.equal(resolveHoldDate('mon', LA, new Date('2026-11-16T17:00:00Z'), 14), '2026-11-16');
  assert.equal(resolveHoldDate('mon', LA, new Date('2026-11-16T23:00:00Z'), 14), '2026-11-23');
});

test('late evening in LA is still the LA date, not the UTC date', () => {
  const lateLa = new Date('2026-11-17T06:30:00Z'); // 10:30pm Nov 16 in LA
  assert.equal(resolveHoldDate('today', LA, lateLa), '2026-11-16');
  assert.equal(resolveHoldDate('tomorrow', LA, lateLa), '2026-11-17');
});

test('bad day words are refused', () => {
  assert.throws(() => resolveHoldDate('someday', LA, MON_10AM), /unknown day/);
  assert.throws(() => resolveHoldDate('2026-02-30', LA, MON_10AM), /not a real date/);
  assert.throws(() => resolveHoldDate('th', LA, MON_10AM), /unknown day/);
});

test('zonedIso uses the right offset on each side of the clock change', () => {
  assert.equal(zonedIso('2026-11-20', 14, LA), '2026-11-20T14:00:00-08:00');
  assert.equal(zonedIso('2026-07-01', 9.5, LA), '2026-07-01T09:30:00-07:00');
  assert.equal(zonedIso('2026-11-20', 14, 'Europe/Madrid'), '2026-11-20T14:00:00+01:00');
  assert.throws(() => zonedIso('2026-03-08', 2.5, LA), /does not exist/);
});

test('hold args take several blocks with --and', () => {
  const opts = parseHoldArgs(['mon', '1pm', '4pm', '--and', 'wed', '10am', '12pm', '--title', 'Investor calls', '--weekly']);
  assert.deepEqual(opts.blocks, [
    { when: 'mon', start: '1pm', end: '4pm' },
    { when: 'wed', start: '10am', end: '12pm' },
  ]);
  assert.equal(opts.title, 'Investor calls');
  assert.equal(opts.weekly, true);
  assert.throws(() => parseHoldArgs(['thu', '2pm']), /a day, a start and an end/);
  assert.throws(() => parseHoldArgs(['thu', '2pm', '5pm', '--and', 'fri']), /a day, a start and an end/);
  assert.throws(() => parseHoldArgs(['thu', '2pm', '5pm', '--nope']), /does not take "--nope"/);
});

test('hold bodies are exactly what the server gets', () => {
  const opts = parseHoldArgs(['thu', '2pm', '5pm', '--and', '2026-11-21', '9:30am', '11am', '--weekly']);
  assert.deepEqual(buildHoldBodies(opts, LA, MON_10AM), [
    { start: '2026-11-19T14:00:00-08:00', end: '2026-11-19T17:00:00-08:00', repeat: 'weekly' },
    { start: '2026-11-21T09:30:00-08:00', end: '2026-11-21T11:00:00-08:00', repeat: 'weekly' },
  ]);
  assert.throws(() => buildHoldBodies(parseHoldArgs(['thu', '5pm', '2pm']), LA, MON_10AM), /must be after the start/);
});

test('hold dry run prints the plan and sends nothing', async () => {
  const deps = fakeDeps();
  const res = await capture(() => holdAvail(['thu', '2pm', '5pm'], deps));
  assert.equal(res.code, 0);
  assert.equal(res.stdout, [
    'Would block this time on your Google Calendar (America/Los_Angeles):',
    '  Thu, Nov 19, 2pm to 5pm (Open for calls)',
    'Guests can book inside it. Dry run, add --apply to create it.',
  ].join('\n'));
  assert.deepEqual(deps.calls, []);
});

test('hold dry run --json shows the request bodies', async () => {
  const deps = fakeDeps();
  const res = await capture(() => holdAvail(['tomorrow', '9am', '10am', '--title', 'Demos', '--json'], deps));
  assert.deepEqual(JSON.parse(res.stdout), {
    preview: true,
    timezone: LA,
    holds: [{ start: '2026-11-17T09:00:00-08:00', end: '2026-11-17T10:00:00-08:00', title: 'Demos' }],
  });
  assert.deepEqual(deps.calls, []);
});

test('hold --apply posts each block', async () => {
  const deps = fakeDeps({
    'POST /profile/booking-holds': (o) => ({ ok: true, data: { id: `id-${o.body.start.slice(8, 10)}`, ...o.body, title: 'Open for calls' } }),
  });
  const res = await capture(() => holdAvail(['thu', '2pm', '5pm', '--and', 'fri', '1pm', '2pm', '--apply'], deps));
  assert.equal(res.code, 0);
  assert.deepEqual(deps.calls.map((c) => [c.method, c.path, c.body.start]), [
    ['POST', '/profile/booking-holds', '2026-11-19T14:00:00-08:00'],
    ['POST', '/profile/booking-holds', '2026-11-20T13:00:00-08:00'],
  ]);
  assert.match(res.stdout, /Blocked Thu, Nov 19, 2pm to 5pm \(Open for calls\)\.\n  id: id-19/);
});

test('hold --apply stops and says so when the server refuses', async () => {
  const deps = fakeDeps({ 'POST /profile/booking-holds': { ok: false, status: 400, error: 'start must be in the future' } });
  const res = await capture(() => holdAvail(['thu', '2pm', '5pm', '--apply'], deps));
  assert.equal(res.code, 1);
  assert.match(res.stderr, /start must be in the future/);
});

test('holds lists blocks with ids and marks weekly ones', async () => {
  const deps = fakeDeps({
    'GET /profile/booking-holds': {
      ok: true,
      data: { count: 2, holds: [
        { id: 'a1', start: '2026-11-19T14:00:00-08:00', end: '2026-11-19T17:00:00-08:00', title: 'Open for calls', repeats: false, series_id: null },
        { id: 's1_x', start: '2026-11-21T10:00:00-08:00', end: '2026-11-21T12:00:00-08:00', title: 'Open for calls', repeats: true, series_id: 's1' },
      ] },
    },
  });
  const res = await capture(() => holdsAvail(['--days', '30'], deps));
  assert.equal(res.code, 0);
  assert.equal(deps.calls[0].path, '/profile/booking-holds?days=30');
  assert.match(res.stdout, /Thu, Nov 19, 2pm to 5pm \(Open for calls\)\n    id: a1/);
  assert.match(res.stdout, /Sat, Nov 21, 10am to 12pm, every week/);
});

test('unhold is a dry run until --apply, then deletes by id', async () => {
  const deps = fakeDeps({
    'GET /profile/booking-holds': { ok: true, data: { holds: [
      { id: 'a1', start: '2026-11-19T14:00:00-08:00', end: '2026-11-19T17:00:00-08:00', title: 'Open for calls' },
    ] } },
    'DELETE /profile/booking-holds/a1': { ok: true, data: { deleted: true, id: 'a1' } },
  });
  const dry = await capture(() => unholdAvail(['a1'], deps));
  assert.match(dry.stdout, /Would remove Thu, Nov 19, 2pm to 5pm/);
  assert.ok(!deps.calls.some((c) => c.method === 'DELETE'));
  const real = await capture(() => unholdAvail(['a1', '--apply'], deps));
  assert.equal(real.code, 0);
  assert.equal(deps.calls.at(-1).method, 'DELETE');
  assert.equal(deps.calls.at(-1).path, '/profile/booking-holds/a1');
});

test('set --off sends seven empty days, never {}', async () => {
  const opts = parseSetArgs(['--off']);
  const payload = buildOffPayload(opts);
  assert.deepEqual(payload, { available_hours: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] } });
  assert.equal(Object.keys(payload.available_hours).length, 7);
  assert.ok(!('timezone' in payload), 'off keeps the stored timezone');
  assert.equal(buildOffPayload(parseSetArgs(['--off', '--where', 'NYC'])).timezone, 'America/New_York');
  assert.throws(() => parseSetArgs(['--off', '--wake', '9am']), /does not take --wake/);
  const res = await capture(() => availCommand(['set', '--off', '--json']));
  assert.equal(res.code, 0);
  assert.deepEqual(JSON.parse(res.stdout).payload.available_hours['3'], []);
});

test('weekly hours off means every day present and empty', () => {
  assert.equal(weeklyHoursOff({ 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }), true);
  assert.equal(weeklyHoursOff({ 0: [[9, 17]], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }), false);
  assert.equal(weeklyHoursOff({}), false);
});

test('only read verbs relax the account guard', () => {
  assert.equal(isReadOnlyAvail([]), true);
  assert.equal(isReadOnlyAvail(['--json']), true);
  assert.equal(isReadOnlyAvail(['show']), true);
  assert.equal(isReadOnlyAvail(['slots', '--days', '3']), true);
  assert.equal(isReadOnlyAvail(['--account', 'holds']), true);
  assert.equal(isReadOnlyAvail(['hold', 'thu', '2pm', '5pm']), false);
  assert.equal(isReadOnlyAvail(['unhold', 'x']), false);
  assert.equal(isReadOnlyAvail(['set', '--off']), false);
});

test('help names the new verbs', async () => {
  const res = await capture(() => availCommand(['--help']));
  assert.match(res.stdout, /atris avail hold DAY START END \[--and DAY START END\] \[--title T\] \[--weekly\] \[--apply\]/);
  assert.match(res.stdout, /atris avail holds \[--days N\] \[--json\]/);
  assert.match(res.stdout, /atris avail unhold ID \[--apply\]/);
  assert.match(res.stdout, /atris avail set --off/);
});
