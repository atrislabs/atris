'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { meetCommand } = require('../commands/meet');

test('meet replaces nonpositive booking limits with the defaults', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-nonpositive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // Skip workspace and theme initialization so all writes stay in this directory.
  fs.mkdirSync(path.join(root, 'atris'));
  fs.mkdirSync(path.join(root, '.atris'));
  fs.writeFileSync(path.join(root, '.atris', 'theme.json'), '{}');

  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.equal(await meetCommand([
      '--name', 'Ada',
      '--want', 'build software',
      '--currency', 'working software',
      '--tz', 'UTC',
      '--slot-minutes', '0',
      '--window-days', '-7',
    ], root), 0);
  } finally {
    console.log = originalLog;
  }

  const { settings } = JSON.parse(fs.readFileSync(
    path.join(root, '.atris', 'booking-settings.json'), 'utf8',
  ));
  assert.deepEqual({
    slot_duration_minutes: settings.slot_duration_minutes,
    booking_window_days: settings.booking_window_days,
  }, {
    slot_duration_minutes: 30,
    booking_window_days: 30,
  });
});
