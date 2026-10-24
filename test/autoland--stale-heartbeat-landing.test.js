const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  STALE_HEARTBEAT_LANDING,
  certifiedWorkLandsPhrase,
  whenAutolandLands,
} = require('../lib/autoland');

// STALE_HEARTBEAT_LANDING is a string, not a function. It is only ever shown
// through whenAutolandLands and certifiedWorkLandsPhrase, which pick it when
// no recent tick receipt exists. These tests use a temp folder and never
// depend on the clock: a missing or ancient receipt is stale on any day.
function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoland-stale-'));
}

test('STALE_HEARTBEAT_LANDING is the exact sentence users see when the heartbeat is down', () => {
  assert.equal(
    STALE_HEARTBEAT_LANDING,
    'once the hourly heartbeat runs (start one with atris autoland tick)',
  );
});

test('a workspace with no tick receipts lands work via the stale sentence', () => {
  const root = tempRoot();
  try {
    assert.equal(whenAutolandLands(root), STALE_HEARTBEAT_LANDING);
    assert.equal(
      certifiedWorkLandsPhrase(root),
      `certified work lands ${STALE_HEARTBEAT_LANDING}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('edge cases still fall back to the stale sentence: no runs folder, no receipt files, or only an old receipt', () => {
  const root = tempRoot();
  try {
    const missingRoot = path.join(root, 'does-not-exist');
    assert.equal(whenAutolandLands(missingRoot), STALE_HEARTBEAT_LANDING);

    const runsDir = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });

    // Empty runs folder: nothing to read, so no proof the loop is alive.
    assert.equal(whenAutolandLands(root), STALE_HEARTBEAT_LANDING);

    // A file that is not a tick receipt does not count as a heartbeat.
    fs.writeFileSync(path.join(runsDir, 'notes.json'), '{}');
    assert.equal(whenAutolandLands(root), STALE_HEARTBEAT_LANDING);

    // A real receipt, but dated 2001. Its age is far past the two-hour
    // window on any clock, so it must still read as stale.
    const receipt = path.join(runsDir, 'autoland-tick-2001-01-01.json');
    fs.writeFileSync(receipt, '{}');
    const oldStamp = new Date('2001-01-01T00:00:00Z');
    fs.utimesSync(receipt, oldStamp, oldStamp);
    assert.equal(whenAutolandLands(root), STALE_HEARTBEAT_LANDING);
    assert.equal(
      certifiedWorkLandsPhrase(root),
      `certified work lands ${STALE_HEARTBEAT_LANDING}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
