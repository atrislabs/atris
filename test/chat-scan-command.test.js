const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { chatScanCommand } = require('../commands/chat-scan');

function withTempWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-chat-scan-'));
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevCursor = process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
  process.env.HOME = dir;
  delete process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
  process.chdir(dir);
  try {
    return fn(dir);
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCursor === undefined) delete process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
    else process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT = prevCursor;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('help prints usage and does not scan', () => {
  const cases = [['--help'], ['-h'], ['help'], ['--', '--help']];
  for (const args of cases) {
    const lines = [];
    const orig = console.log;
    console.log = (...parts) => lines.push(parts.join(' '));
    try {
      const result = chatScanCommand(args);
      assert.deepStrictEqual(result, { ok: true });
      const text = lines.join('\n');
      assert.match(text, /Usage: atris chat scan \[--json\] \[--hours <n>\] \[--limit <n>\] \[--no-write\] \[--global\]/);
      assert.match(text, /--hours <n>\s+Lookback window \(default 720 = 30 days\)/);
      assert.match(text, /--no-write\s+Skip writing \.atris\/state\/chat_scan\.latest\.json/);
      assert.match(text, /--global\s+Include ~\/\.atris\/runs/);
    } finally {
      console.log = orig;
    }
  }
});

test('an empty workspace reports no logs and skips the latest file', () => {
  withTempWorkspace((dir) => {
    fs.mkdirSync(path.join(dir, 'atris'));
    const lines = [];
    const orig = console.log;
    console.log = (...parts) => lines.push(parts.join(' '));
    try {
      const report = chatScanCommand(['--no-write', '--hours', '24']);
      assert.strictEqual(report.summary.sessions, 0);
      assert.strictEqual(report.summary.ax_sessions, 0);
      assert.strictEqual(report.summary.cursor_sessions, 0);
      assert.strictEqual(report.summary.findings, 0);
      assert.strictEqual(report.window_hours, 24);
      assert.strictEqual(report.scope, 'workspace');
      assert.strictEqual(report.next_command, 'atris chat scan --hours 168');
      assert.deepStrictEqual(report.sources.ax_dirs, []);
      assert.deepStrictEqual(report.sources.cursor_roots, []);
      assert.strictEqual(report.latest_path, undefined);
      const text = lines.join('\n');
      assert.match(text, /sessions 0\s+│ ax 0\s+│ cursor 0\s+│ findings 0/);
      assert.match(text, /Window: last 24h/);
      assert.match(text, /Ax logs: \(none\)/);
      assert.match(text, /Cursor: \(none\)/);
      assert.match(text, /No recent chat logs found\./);
      assert.strictEqual(fs.existsSync(path.join(dir, '.atris', 'state', 'chat_scan.latest.json')), false);
    } finally {
      console.log = orig;
    }
  });
});

test('a local ax log is scanned, printed as json, and saved', () => {
  withTempWorkspace((dir) => {
    const runs = path.join(dir, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, 'ax-play-demo.log'), [
      'mode: pro',
      'started_at: 2026-10-23T00:00:00.000Z',
      'pro › fix the failing check',
      'x error: timeout talking to the engine',
      'exit_code: 1',
      '',
    ].join('\n'));

    let raw = '';
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk, enc, cb) => {
      raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (typeof enc === 'function') enc();
      else if (typeof cb === 'function') cb();
      return true;
    };
    try {
      const report = chatScanCommand(['--json', '--hours', '48', '--limit', '3']);
      assert.strictEqual(report.schema, 'atris.chat_scan.v1');
      assert.strictEqual(report.window_hours, 48);
      assert.strictEqual(report.summary.sessions, 1);
      assert.strictEqual(report.summary.ax_sessions, 1);
      assert.strictEqual(report.summary.cursor_sessions, 0);
      assert.strictEqual(report.summary.findings, 2);
      assert.strictEqual(report.summary.high_findings, 1);
      assert.strictEqual(report.sessions[0].source, 'ax');
      assert.strictEqual(report.sessions[0].mode, 'pro');
      assert.strictEqual(report.sessions[0].last_user, 'fix the failing check');
      assert.strictEqual(report.sessions[0].exit_code, 1);
      assert.ok(report.findings.some((finding) => finding.code === 'nonzero_exit' && finding.severity === 'high'));
      assert.ok(report.findings.some((finding) => finding.code === 'log_error_pattern' && /timeout talking to the engine/.test(finding.evidence)));
      assert.strictEqual(report.next_command, 'atris member wake auto-improver --execute --confirm-autonomy-policy');

      const printed = JSON.parse(raw);
      assert.strictEqual(printed.summary.sessions, 1);
      assert.strictEqual(printed.sessions[0].last_user, 'fix the failing check');

      const latest = path.join(dir, '.atris', 'state', 'chat_scan.latest.json');
      assert.strictEqual(fs.realpathSync(report.latest_path), fs.realpathSync(latest));
      const saved = JSON.parse(fs.readFileSync(latest, 'utf8'));
      assert.strictEqual(saved.summary.high_findings, 1);
      assert.strictEqual(saved.sessions[0].exit_code, 1);
    } finally {
      process.stdout.write = origWrite;
    }
  });
});

test('a folder without atris stops before scanning', () => {
  withTempWorkspace(() => {
    const errors = [];
    const origErr = console.error;
    const origExit = process.exit;
    console.error = (...parts) => errors.push(parts.join(' '));
    process.exit = (code) => {
      const err = new Error(`exit ${code}`);
      err.exitCode = code;
      throw err;
    };
    try {
      assert.throws(
        () => chatScanCommand([]),
        (err) => err.exitCode === 1,
      );
      assert.match(errors.join('\n'), /atris\/ folder not found\. Run from an Atris workspace\./);
      assert.strictEqual(fs.existsSync(path.join(process.cwd(), '.atris', 'state', 'chat_scan.latest.json')), false);
    } finally {
      console.error = origErr;
      process.exit = origExit;
    }
  });
});
