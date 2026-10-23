'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { meetCommand, slugify } = require('../commands/meet');

function tmp(t, prefix = 'meet-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Pre-create the two sentinels meet.js checks so the test stays local:
// atris/ skips initAtris scaffolding, .atris/theme.json skips `theme init`.
function preparedWorkspace(t) {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.atris', 'theme.json'), '{}');
  return dir;
}

async function captureRun(fn) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    const code = await fn();
    return { code, out, err };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    process.env[key] = vars[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(vars)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

test('slugify turns a name into a booking-handle-safe slug', () => {
  assert.equal(slugify('Ada Lovelace'), 'ada-lovelace');
  assert.equal(slugify('  Madé  O\'Brien!! '), 'mad-o-brien');
  assert.equal(slugify(''), 'guest');
  assert.equal(slugify('!!!'), 'guest');
  assert.equal(slugify('x'.repeat(80)).length, 48);
});

test('meet --help prints usage and exits 0 without touching the filesystem', async (t) => {
  const dir = tmp(t);
  const { code, out } = await captureRun(() => meetCommand(['--help'], dir));
  assert.equal(code, 0);
  assert.ok(out.some((line) => line.includes('usage: atris meet')));
  assert.ok(out.some((line) => line.includes('--name')));
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('meet without the required flags refuses non-interactively with code 2', async (t) => {
  const dir = tmp(t);
  const prevIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = false;
  try {
    const { code, err } = await captureRun(() => meetCommand(['--name', 'Ada'], dir));
    assert.equal(code, 2);
    assert.ok(err.some((line) => line.includes('meet needs') && line.includes('--want') && line.includes('--currency')));
  } finally {
    process.stdin.isTTY = prevIsTTY;
  }
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('meet writes profile.md and booking-settings.json, prints the /book link', async (t) => {
  const dir = preparedWorkspace(t);
  await withEnv({ HOME: dir, ATRIS_APP_URL: 'https://app.test.local' }, async () => {
    const { code, out } = await captureRun(() => meetCommand([
      '--name', 'Ada Lovelace',
      '--want', 'ship reliable software',
      '--currency', 'paying customers',
      '--wake', '10am',
      '--sleep', '4pm',
      '--days', 'mon,wed,fri',
      '--tz', 'Europe/London',
    ], dir));

    assert.equal(code, 0);
    assert.deepEqual(out, [
      'https://app.test.local/book/ada-lovelace',
      'next: share this link; atris will start turning new conversations into paying customers.',
    ]);
  });

  const profile = fs.readFileSync(path.join(dir, 'atris', 'profile.md'), 'utf8');
  assert.match(profile, /name: Ada Lovelace/);
  assert.match(profile, /booking link: https:\/\/app\.test\.local\/book\/ada-lovelace/);
  assert.match(profile, /- said: ship reliable software/);
  assert.match(profile, /- hours: 10am to 4pm/);
  assert.match(profile, /- timezone: Europe\/London/);

  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'booking-settings.json'), 'utf8'));
  assert.equal(settings.username, 'ada-lovelace');
  assert.equal(settings.link, 'https://app.test.local/book/ada-lovelace');
  assert.equal(settings.settings.timezone, 'Europe/London');
  assert.equal(settings.settings.slot_duration_minutes, 30);
  assert.equal(settings.settings.booking_window_days, 30);
  assert.deepEqual(settings.settings.available_hours['0'], [[10, 16]]);
  assert.deepEqual(settings.settings.available_hours['2'], [[10, 16]]);
  assert.deepEqual(settings.settings.available_hours['4'], [[10, 16]]);
  assert.deepEqual(settings.settings.available_hours['1'], []);
  assert.deepEqual(settings.settings.available_hours['6'], []);
});

test('meet honors --username and defaults to weekdays 9am-5pm Pacific', async (t) => {
  const dir = preparedWorkspace(t);
  await withEnv({ HOME: dir, ATRIS_APP_URL: 'https://app.test.local' }, async () => {
    const { code, out } = await captureRun(() => meetCommand([
      '--name', 'Grace Hopper',
      '--want', 'compile the future',
      '--currency', 'working compilers',
      '--username', 'Amazing Grace',
    ], dir));
    assert.equal(code, 0);
    assert.equal(out[0], 'https://app.test.local/book/amazing-grace');
  });

  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'booking-settings.json'), 'utf8'));
  assert.equal(settings.username, 'amazing-grace');
  assert.equal(settings.settings.timezone, 'America/Los_Angeles');
  assert.deepEqual(settings.settings.available_hours['0'], [[9, 17]]);
  assert.deepEqual(settings.settings.available_hours['4'], [[9, 17]]);
  assert.deepEqual(settings.settings.available_hours['5'], []);
});

test('meet refuses a wake time after the sleep time before writing anything', async (t) => {
  const dir = tmp(t);
  const { code, err } = await captureRun(() => meetCommand([
    '--name', 'Ada',
    '--want', 'x',
    '--currency', 'y',
    '--wake', '6pm',
    '--sleep', '9am',
  ], dir));
  assert.equal(code, 1);
  assert.ok(err.some((line) => line.includes('wake must be before sleep')));
  assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
  assert.equal(fs.existsSync(path.join(dir, '.atris')), false);
});
