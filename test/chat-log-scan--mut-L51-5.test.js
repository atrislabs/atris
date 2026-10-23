const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanChatLogs } = require('../lib/chat-log-scan');

const NOW_MS = 1_800_000_000_000;
const WINDOW_HOURS = 24;
const WINDOW_MS = WINDOW_HOURS * 3600000;
const CUTOFF_MS = NOW_MS - WINDOW_MS;

function setMtime(filePath, ms) {
  const seconds = ms / 1000;
  fs.utimesSync(filePath, seconds, seconds);
}

test('a log whose mtime sits exactly on the age cutoff is still scanned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-chat-scan-edge-'));
  const prevHome = process.env.HOME;
  const prevCursor = process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
  const realNow = Date.now;
  process.env.HOME = root;
  delete process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
  try {
    const work = path.join(root, 'work');
    const runs = path.join(work, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });

    const older = path.join(runs, 'ax-older.log');
    const edge = path.join(runs, 'ax-edge.log');
    const newer = path.join(runs, 'ax-newer.log');
    for (const file of [older, edge, newer]) fs.writeFileSync(file, 'mode: pro\n');
    setMtime(older, CUTOFF_MS - 1000);
    setMtime(edge, CUTOFF_MS);
    setMtime(newer, CUTOFF_MS + 1000);

    assert.strictEqual(fs.statSync(edge).mtimeMs, CUTOFF_MS);

    let report;
    Date.now = () => NOW_MS;
    try {
      report = scanChatLogs({ cwd: work, hours: WINDOW_HOURS, limit: 10 });
    } finally {
      Date.now = realNow;
    }

    assert.strictEqual(report.window_hours, WINDOW_HOURS);
    assert.strictEqual(report.summary.sessions, 2);
    assert.strictEqual(report.summary.ax_sessions, 2);
    assert.deepStrictEqual(report.sessions.map((s) => s.path), [newer, edge]);
  } finally {
    Date.now = realNow;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCursor === undefined) delete process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
    else process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT = prevCursor;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
