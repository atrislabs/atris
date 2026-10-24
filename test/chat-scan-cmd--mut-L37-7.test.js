require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chatScanCommand } = require('../commands/chat-scan');

test('the text report shows a user prompt when no assistant text was captured', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-prompt-report-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const previousCursor = process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
  const previousLog = console.log;
  const previousExit = process.exit;
  const lines = [];
  try {
    process.env.HOME = dir;
    delete process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
    process.chdir(dir);
    const runs = path.join(dir, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    const log = path.join(runs, 'ax-prompt.log');
    fs.writeFileSync(log, 'mode: pro\npro › inspect the garden plan\n');
    fs.utimesSync(log, 946684800, 946684800);
    console.log = (...parts) => lines.push(parts.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    chatScanCommand(['--no-write', '--hours', 'Infinity']);
    assert.ok(lines.some((line) => /last:\s*inspect the garden plan/.test(line)));
  } finally {
    console.log = previousLog;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCursor === undefined) delete process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
    else process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT = previousCursor;
  }
});
