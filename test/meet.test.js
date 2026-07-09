'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { knownCommands } = require('../lib/known-commands');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_APP_URL: 'https://example.test',
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('meet is registered as a known command', () => {
  assert.ok(knownCommands.includes('meet'));
});

test('meet non-interactive flags create atris notes and print the booking link', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-meet-test-'));
  try {
    const result = runCli([
      'meet',
      '--name', 'test dj',
      '--want', 'more gigs',
      '--currency', 'gigs booked',
    ], dir);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, [
      'https://example.test/book/test-dj',
      'next: share this link; atris will start turning new conversations into gigs booked.',
      '',
    ].join('\n'));

    assert.ok(fs.existsSync(path.join(dir, 'atris')), 'creates atris folder');
    const profile = fs.readFileSync(path.join(dir, 'atris', 'profile.md'), 'utf8');
    assert.match(profile, /name: test dj/);
    assert.match(profile, /- said: more gigs/);
    assert.match(profile, /currency: gigs booked/);
    assert.match(profile, /booking link: https:\/\/example\.test\/book\/test-dj/);

    const booking = JSON.parse(fs.readFileSync(path.join(dir, '.atris', 'booking-settings.json'), 'utf8'));
    assert.equal(booking.username, 'test-dj');
    assert.equal(booking.link, 'https://example.test/book/test-dj');
    assert.equal(booking.settings.timezone, 'America/Los_Angeles');
    assert.deepEqual(booking.settings.available_hours['0'], [[9, 17]]);
    assert.deepEqual(booking.settings.available_hours['5'], []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
