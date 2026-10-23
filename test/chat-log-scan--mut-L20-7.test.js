const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanChatLogs } = require('../lib/chat-log-scan');

test('scanChatLogs excludes an oversized regular ax log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-scan-size-'));
  const previousHome = process.env.HOME;
  const previousCursorRoot = process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
  process.env.HOME = root;
  delete process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;

  try {
    const runs = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    const log = path.join(runs, 'ax-size.log');
    fs.writeFileSync(log, 'pro › oversized prompt\n');

    // Establish that this location and log format reach the exported scanner.
    assert.deepStrictEqual(
      scanChatLogs({ cwd: root, hours: 24 }).sessions.map((session) => session.path),
      [log],
    );

    // Padding preserves the valid prompt while exceeding the read size cap.
    fs.appendFileSync(log, Buffer.alloc(8 * 1024 * 1024, ' '));
    const report = scanChatLogs({ cwd: root, hours: 24 });
    assert.deepStrictEqual(report.sessions, []);
    assert.deepStrictEqual(report.summary, {
      sessions: 0,
      ax_sessions: 0,
      cursor_sessions: 0,
      findings: 0,
      high_findings: 0,
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCursorRoot === undefined) delete process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
    else process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT = previousCursorRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
