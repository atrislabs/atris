'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'avail-rules-'));
process.env.HOME = tmpHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const {
  availCommand,
  typesAvail,
  typeAvail,
  setRules,
  changeMeetingTypes,
  parseMinutesArg,
  parseMaxPerDay,
  parseSetArgs,
  buildOffPayload,
  isReadOnlyAvail,
} = require('../commands/avail');

after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

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

const DEFAULT_TYPES = [{ slug: '30', title: '30 minute call', minutes: 30 }];

function fakeDeps(settings = { meeting_types: DEFAULT_TYPES }, putReply = null) {
  const calls = [];
  return {
    calls,
    getToken: async () => 'tok',
    request: async (p, options) => {
      calls.push({ path: p, ...options });
      if (options.method === 'GET') return { ok: true, data: settings };
      return putReply || { ok: true, data: { ...settings, ...options.body } };
    },
  };
}

test('notice and buffer lengths read hours and minutes', () => {
  assert.equal(parseMinutesArg('--notice', '4h', 10080), 240);
  assert.equal(parseMinutesArg('--notice', '240m', 10080), 240);
  assert.equal(parseMinutesArg('--notice', '240', 10080), 240);
  assert.equal(parseMinutesArg('--notice', '1h30m', 10080), 90);
  assert.equal(parseMinutesArg('--buffer', '0', 120), 0);
  assert.equal(parseMinutesArg('--buffer', '10min', 120), 10);
  assert.throws(() => parseMinutesArg('--buffer', '3h', 120), /up to 120 minutes/);
  assert.throws(() => parseMinutesArg('--notice', 'soon', 10080), /--notice needs a length/);
  assert.throws(() => parseMinutesArg('--notice', undefined, 10080), /got: nothing/);
  assert.throws(() => parseMinutesArg('--notice', '-5', 10080), /--notice needs a length/);
});

test('max per day takes a number or none', () => {
  assert.equal(parseMaxPerDay('6'), 6);
  assert.equal(parseMaxPerDay('none'), null);
  assert.equal(parseMaxPerDay('off'), null);
  assert.throws(() => parseMaxPerDay('0'), /1 to 50, or none/);
  assert.throws(() => parseMaxPerDay('51'), /1 to 50, or none/);
});

test('rules alone do not need --wake or --sleep', () => {
  const opts = parseSetArgs(['--notice', '4h', '--buffer', '10m', '--max-per-day', 'none']);
  assert.equal(opts.rulesOnly, true);
  assert.equal(opts.notice, 240);
  assert.equal(opts.buffer, 10);
  assert.equal(opts.maxPerDay, null);
  assert.throws(() => parseSetArgs(['--notice', '4h', '--wake', '9am']), /--wake and --sleep are required/);
  assert.throws(() => parseSetArgs([]), /--wake and --sleep are required/);
});

test('rules ride along with --off', () => {
  const payload = buildOffPayload(parseSetArgs(['--off', '--buffer', '15m']));
  assert.equal(payload.buffer_minutes, 15);
  assert.ok(!('min_notice_minutes' in payload));
});

test('set rules is a dry run until --apply', async () => {
  const deps = fakeDeps();
  const opts = parseSetArgs(['--notice', '4h', '--max-per-day', '6']);
  const res = await capture(() => setRules(opts, deps));
  assert.equal(res.code, 0);
  assert.match(res.stdout, /notice: 4h before a call/);
  assert.match(res.stdout, /booked calls: 6 a day/);
  assert.match(res.stdout, /Dry run/);
  assert.deepEqual(deps.calls, []);
});

test('set rules --apply sends only the rule keys', async () => {
  const deps = fakeDeps();
  const opts = parseSetArgs(['--notice', '2h', '--buffer', '0', '--max-per-day', 'none', '--apply']);
  const res = await capture(() => setRules(opts, deps));
  assert.equal(res.code, 0);
  assert.deepEqual(deps.calls, [{
    path: '/profile/booking-settings', method: 'PUT', token: 'tok',
    body: { min_notice_minutes: 120, buffer_minutes: 0, max_per_day: null },
  }]);
});

test('set rules --json previews the payload', async () => {
  const res = await capture(() => availCommand(['set', '--buffer', '10m', '--json']));
  assert.equal(res.code, 0);
  assert.deepEqual(JSON.parse(res.stdout), { preview: true, payload: { buffer_minutes: 10 } });
});

test('set with hours also carries rules', async () => {
  const res = await capture(() => availCommand(['set', '--wake', '9am', '--sleep', '5pm', '--notice', '1h', '--json']));
  assert.equal(res.code, 0);
  const { payload } = JSON.parse(res.stdout);
  assert.equal(payload.min_notice_minutes, 60);
  assert.ok(payload.available_hours);
});

test('types lists what the server has', async () => {
  const types = [{ slug: 'intro', title: 'Quick intro', minutes: 15 }];
  const res = await capture(() => typesAvail([], fakeDeps({ meeting_types: types })));
  assert.equal(res.code, 0);
  assert.match(res.stdout, /intro: Quick intro \(15 min\)/);
  const json = await capture(() => typesAvail(['--json'], fakeDeps({ meeting_types: types })));
  assert.deepEqual(JSON.parse(json.stdout), { meeting_types: types });
});

test('type add previews, then saves the full list', async () => {
  const dry = fakeDeps();
  const res = await capture(() => typeAvail(['add', 'intro', '15', 'Quick intro'], dry));
  assert.equal(res.code, 0);
  assert.match(res.stdout, /intro: Quick intro \(15 min\)/);
  assert.match(res.stdout, /Dry run/);
  assert.deepEqual(dry.calls.map((c) => c.method), ['GET']);

  const live = fakeDeps();
  const saved = await capture(() => typeAvail(['add', 'investor', '30', 'Investor', 'call', '--apply'], live));
  assert.equal(saved.code, 0);
  assert.deepEqual(live.calls[1].body, {
    meeting_types: [...DEFAULT_TYPES, { slug: 'investor', title: 'Investor call', minutes: 30 }],
  });
});

test('type remove keeps at least one', async () => {
  const two = [...DEFAULT_TYPES, { slug: 'intro', title: 'Quick intro', minutes: 15 }];
  const deps = fakeDeps({ meeting_types: two });
  const res = await capture(() => typeAvail(['remove', '30', '--apply'], deps));
  assert.equal(res.code, 0);
  assert.deepEqual(deps.calls[1].body, { meeting_types: [two[1]] });

  const last = await capture(() => typeAvail(['remove', '30', '--apply'], fakeDeps()));
  assert.equal(last.code, 1);
  assert.match(last.stderr, /only meeting type/);
});

test('type changes are checked before anything is sent', () => {
  assert.throws(() => changeMeetingTypes(DEFAULT_TYPES, 'add', ['Intro', '15', 'x']), /lowercase/);
  assert.throws(() => changeMeetingTypes(DEFAULT_TYPES, 'add', ['intro', '25', 'x']), /15, 20, 30, 45, 60, 90/);
  assert.throws(() => changeMeetingTypes(DEFAULT_TYPES, 'add', ['30', '30', 'again']), /already have/);
  assert.throws(() => changeMeetingTypes(DEFAULT_TYPES, 'add', ['intro', '15']), /slug, minutes and a title/);
  const five = [1, 2, 3, 4, 5].map((n) => ({ slug: `t${n}`, title: 'T', minutes: 15 }));
  assert.throws(() => changeMeetingTypes(five, 'add', ['t6', '15', 'T']), /at most 5/);
  assert.throws(() => changeMeetingTypes(DEFAULT_TYPES, 'remove', ['nope']), /no meeting type called nope/);
  assert.throws(() => changeMeetingTypes(DEFAULT_TYPES, 'rename', []), /use: atris avail type add/);
});

test('types reads; type changes count as writes', () => {
  assert.equal(isReadOnlyAvail(['types']), true);
  assert.equal(isReadOnlyAvail(['type', 'add', 'intro', '15', 'Intro']), false);
});

test('help names the new flags and commands', async () => {
  const res = await capture(() => availCommand(['--help']));
  for (const words of ['--notice', '--buffer', '--max-per-day', 'atris avail types', 'atris avail type add', '--type SLUG']) {
    assert.ok(res.stdout.includes(words), `help is missing ${words}`);
  }
});
