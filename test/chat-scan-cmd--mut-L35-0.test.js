const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chatScanCommand } = require('../commands/chat-scan');

test('the text report labels an ax session with its mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-scan-label-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousCursorRoot = process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
  const previousLog = console.log;
  const lines = [];
  try {
    process.env.HOME = dir;
    delete process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
    const runs = path.join(dir, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, 'ax-label.log'), [
      'mode: pro',
      'started_at: 2000-01-02T03:04:05.000Z',
      'pro › hello',
      'exit_code: 0',
      '',
    ].join('\n'));
    process.chdir(dir);
    console.log = (...parts) => lines.push(parts.join(' '));

    const report = chatScanCommand(['--no-write', '--hours', 'Infinity']);

    assert.equal(report.sessions.length, 1);
    assert.deepEqual(lines.filter((line) => line.startsWith('- [')), [
      '- [ax/pro] 2000-01-02T03:04:05.000Z',
    ]);
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCursorRoot === undefined) delete process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
    else process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT = previousCursorRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
