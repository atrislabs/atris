const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanChatLogs } = require('../lib/chat-log-scan');

test('an incomplete turn lasting exactly 45 seconds is a high finding', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-scan-45s-'));
  const previousHome = process.env.HOME;
  const previousCursorRoot = process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
  process.env.HOME = root;
  delete process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
  try {
    const runs = path.join(root, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    const logPath = path.join(runs, 'ax-boundary.log');
    fs.writeFileSync(logPath, [
      'pro \u203a finish the requested change',
      '\u2014 Worked for 45s \u2014',
      'Not completed yet',
      '',
    ].join('\n'));

    const report = scanChatLogs({ cwd: root });
    assert.deepStrictEqual(report.findings, [
      {
        severity: 'high',
        code: 'slow_incomplete_turn',
        title: 'Long turn (45s) ended incomplete',
        source: 'ax',
        path: logPath,
        evidence: 'finish the requested change',
      },
      {
        severity: 'medium',
        code: 'log_error_pattern',
        title: 'Error-like line in chat log',
        source: 'ax',
        path: logPath,
        evidence: 'Not completed yet',
      },
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCursorRoot === undefined) delete process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
    else process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT = previousCursorRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
