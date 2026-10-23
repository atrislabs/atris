const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// heartbeatIsLive only reads <root>/atris/runs on disk, but clear ambient
// ATRIS_* config anyway so machine state cannot leak into the check.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { heartbeatIsLive } = require('../lib/autoland');

const HOUR_MS = 3600000;

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-heartbeat-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// mtime is the only signal the function reads, so liveness is set with a
// fixed offset from right now, never a date the wall clock decides.
function writeReceipt(root, name, mtime) {
  const runsDir = path.join(root, 'atris', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const file = path.join(runsDir, name);
  fs.writeFileSync(file, '{}\n');
  fs.utimesSync(file, mtime, mtime);
  return file;
}

test('no runs directory means the heartbeat is not live', (t) => {
  const root = makeRoot(t);
  assert.strictEqual(heartbeatIsLive(root), false);
});

test('an empty runs directory means the heartbeat is not live', (t) => {
  const root = makeRoot(t);
  fs.mkdirSync(path.join(root, 'atris', 'runs'), { recursive: true });
  assert.strictEqual(heartbeatIsLive(root), false);
});

test('a receipt touched just now means the heartbeat is live', (t) => {
  const root = makeRoot(t);
  writeReceipt(root, 'autoland-tick-2026-01-01T00-00-00.json', new Date());
  assert.strictEqual(heartbeatIsLive(root), true);
});

test('a receipt older than two hours means the heartbeat is not live', (t) => {
  const root = makeRoot(t);
  writeReceipt(root, 'autoland-tick-2026-01-01T00-00-00.json', new Date(Date.now() - 3 * HOUR_MS));
  assert.strictEqual(heartbeatIsLive(root), false);

  const ancientRoot = makeRoot(t);
  writeReceipt(ancientRoot, 'autoland-tick-2001-01-01T00-00-00.json', new Date('2001-01-01T00:00:00Z'));
  assert.strictEqual(heartbeatIsLive(ancientRoot), false);
});

test('files that are not tick receipts are ignored', (t) => {
  const root = makeRoot(t);
  const now = new Date();
  writeReceipt(root, 'autoland-tick-notes.txt', now);
  writeReceipt(root, 'other-tick-2026-01-01.json', now);
  writeReceipt(root, 'autoland-tick.json', now);
  writeReceipt(root, 'autoland-tick-2026-01-01.json.bak', now);
  assert.strictEqual(heartbeatIsLive(root), false);
});

test('the newest receipt by name decides, not the newest mtime', (t) => {
  const root = makeRoot(t);
  // The lexically last receipt is stale even though an older-named one is fresh.
  writeReceipt(root, 'autoland-tick-2026-01-01.json', new Date());
  writeReceipt(root, 'autoland-tick-2026-06-01.json', new Date(Date.now() - 3 * HOUR_MS));
  assert.strictEqual(heartbeatIsLive(root), false);

  const liveRoot = makeRoot(t);
  // And the reverse: a fresh newest receipt stays live next to stale history.
  writeReceipt(liveRoot, 'autoland-tick-2026-01-01.json', new Date(Date.now() - 30 * HOUR_MS));
  writeReceipt(liveRoot, 'autoland-tick-2026-06-01.json', new Date());
  assert.strictEqual(heartbeatIsLive(liveRoot), true);
});
