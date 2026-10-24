const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SCHEMA, scanChatLogs, writeLatestScan } = require('../lib/chat-log-scan');

function isolate(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-chat-scan-'));
  const prevHome = process.env.HOME;
  const prevCursor = process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
  process.env.HOME = root;
  delete process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
  try {
    fn(root);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCursor === undefined) delete process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT;
    else process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT = prevCursor;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function promptLine(who, text) {
  return `${who} \u203A ${text}`;
}

test('scanChatLogs reads an ax log and ranks friction findings', () => {
  isolate((root) => {
    const work = path.join(root, 'work');
    const runs = path.join(work, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    const logPath = path.join(runs, 'ax-play-friction.log');
    fs.writeFileSync(logPath, [
      'mode: pro',
      'cwd: /work/demo',
      'started_at: 2026-10-01T12:00:00Z',
      'finished_at: 2026-10-01T12:02:00Z',
      'exit_code: 2',
      promptLine('pro', 'please fix the scanner now'),
      promptLine('code-fast', 'please fix the scanner now again'),
      '\u25CF Read the log',
      '\u2014 Worked for 1m 5s \u2014',
      'x request failed with ECONNREFUSED',
      '\u00B7 Interrupted',
      'Not completed yet',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(runs, 'play.log'), 'error: decoy must stay unread\n');

    const report = scanChatLogs({ cwd: work, hours: 24, limit: 5 });

    assert.strictEqual(SCHEMA, 'atris.chat_scan.v1');
    assert.strictEqual(report.schema, SCHEMA);
    assert.strictEqual(report.cwd, work);
    assert.strictEqual(report.scope, 'workspace');
    assert.strictEqual(report.window_hours, 24);
    assert.ok(Math.abs(Date.now() - Date.parse(report.scanned_at)) < 60000);
    assert.deepStrictEqual(report.sources.ax_dirs, [runs]);
    assert.deepStrictEqual(report.sources.cursor_roots, []);
    assert.deepStrictEqual(report.summary, {
      sessions: 1,
      ax_sessions: 1,
      cursor_sessions: 0,
      findings: 7,
      high_findings: 2,
    });
    assert.strictEqual(report.next_command, 'atris member wake auto-improver --execute --confirm-autonomy-policy');

    const session = report.sessions[0];
    assert.strictEqual(session.source, 'ax');
    assert.strictEqual(session.path, logPath);
    assert.strictEqual(session.rel_path, path.join('atris', 'runs', 'ax-play-friction.log'));
    assert.strictEqual(session.mode, 'pro');
    assert.strictEqual(session.cwd, '/work/demo');
    assert.strictEqual(session.started_at, '2026-10-01T12:00:00Z');
    assert.strictEqual(session.finished_at, '2026-10-01T12:02:00Z');
    assert.strictEqual(session.exit_code, 2);
    assert.strictEqual(session.user_turns, 2);
    assert.strictEqual(session.tool_calls, 1);
    assert.strictEqual(session.interrupted, true);
    assert.strictEqual(session.last_worked, '1m 5s');
    assert.strictEqual(session.last_user, 'please fix the scanner now again');
    assert.deepStrictEqual(session.sample_users, [
      'please fix the scanner now',
      'please fix the scanner now again',
    ]);
    assert.deepStrictEqual(session.log_findings, [
      'x request failed with ECONNREFUSED',
      '\u00B7 Interrupted',
      'Not completed yet',
    ]);
    assert.deepStrictEqual(report.findings.map((finding) => finding.code), [
      'nonzero_exit',
      'slow_incomplete_turn',
      'interrupted_turn',
      'log_error_pattern',
      'log_error_pattern',
      'log_error_pattern',
      'repeat_user_ask',
    ]);
    assert.deepStrictEqual(report.findings.map((finding) => finding.severity), [
      'high',
      'high',
      'medium',
      'medium',
      'medium',
      'medium',
      'low',
    ]);
    assert.strictEqual(report.findings[0].title, 'Chat session exited with code 2');
    assert.strictEqual(report.findings[1].title, 'Long turn (1m 5s) ended incomplete');
    assert.strictEqual(report.findings[1].evidence, 'please fix the scanner now again');
    assert.strictEqual(
      report.findings[6].evidence,
      'please fix the scanner now -> please fix the scanner now again',
    );
    assert.ok(report.findings.every((finding) => finding.path === logPath));
    assert.ok(!JSON.stringify(report).includes('decoy must stay unread'));
  });
});

test('scanChatLogs reads a cursor transcript inside the window and writeLatestScan stores it', () => {
  isolate((root) => {
    const work = path.join(root, 'work');
    const runs = path.join(work, 'atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    const oldLog = path.join(runs, 'ax-old.log');
    fs.writeFileSync(oldLog, [
      'exit_code: 7',
      promptLine('pro', 'ancient failure should stay hidden'),
      'x timeout',
      '',
    ].join('\n'));
    const old = Date.now() - (3 * 3600000);
    fs.utimesSync(oldLog, old / 1000, old / 1000);

    const cursorRoot = path.join(root, 'cursor-extra');
    fs.mkdirSync(cursorRoot, { recursive: true });
    const transcript = path.join(cursorRoot, 'agent.jsonl');
    fs.writeFileSync(transcript, [
      'not-json',
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: '<user_query>\nship the scan test\n</user_query>' }] },
      }),
      JSON.stringify({
        role: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read' },
            { type: 'tool_use', name: 'Bash' },
            { type: 'text', text: 'The file read failed with a timeout.' },
            { type: 'text', text: 'hidden [REDACTED] tail' },
          ],
        },
      }),
      JSON.stringify({
        role: 'user',
        message: { content: [{ type: 'text', text: '  plain follow up without tags  ' }] },
      }),
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(cursorRoot, 'notes.txt'), 'error: not a transcript\n');
    process.env.ATRIS_CHAT_SCAN_CURSOR_ROOT = cursorRoot;

    const blocked = scanChatLogs({ cwd: work, hours: 1, limit: 4 });
    assert.strictEqual(blocked.summary.sessions, 0);
    assert.deepStrictEqual(blocked.sources.cursor_roots, []);

    fs.mkdirSync(path.join(root, '.cursor', 'projects'), { recursive: true });
    const report = scanChatLogs({ cwd: work, hours: 1, limit: 4 });

    assert.deepStrictEqual(report.sources.cursor_roots, [cursorRoot]);
    assert.deepStrictEqual(report.summary, {
      sessions: 1,
      ax_sessions: 0,
      cursor_sessions: 1,
      findings: 0,
      high_findings: 0,
    });
    assert.strictEqual(report.next_command, 'atris chat scan --hours 168');
    assert.strictEqual(report.sessions[0].source, 'cursor');
    assert.strictEqual(report.sessions[0].path, transcript);
    assert.strictEqual(report.sessions[0].rel_path, transcript);
    assert.strictEqual(report.sessions[0].user_turns, 2);
    assert.strictEqual(report.sessions[0].assistant_turns, 1);
    assert.strictEqual(report.sessions[0].tool_calls, 2);
    assert.strictEqual(report.sessions[0].last_user, 'plain follow up without tags');
    assert.strictEqual(report.sessions[0].last_assistant, 'The file read failed with a timeout.');
    assert.deepStrictEqual(report.sessions[0].sample_users, [
      'ship the scan test',
      'plain follow up without tags',
    ]);
    assert.ok(!JSON.stringify(report).includes('ancient failure'));
    assert.ok(!JSON.stringify(report).includes('not a transcript'));
    assert.ok(!JSON.stringify(report).includes('[REDACTED]'));

    const latestPath = writeLatestScan(work, report);
    assert.strictEqual(latestPath, path.join(work, '.atris', 'state', 'chat_scan.latest.json'));
    const raw = fs.readFileSync(latestPath, 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.deepStrictEqual(JSON.parse(raw), report);
  });
});

test('scanChatLogs keeps home runs out until global is set', () => {
  isolate((root) => {
    const work = path.join(root, 'work');
    const runs = path.join(work, 'atris', 'runs');
    const homeRuns = path.join(root, '.atris', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    fs.mkdirSync(homeRuns, { recursive: true });
    const localLog = path.join(runs, 'ax-local.log');
    const homeLog = path.join(homeRuns, 'ax-home.log');
    fs.writeFileSync(localLog, `${promptLine('max', 'local prompt only')}\n`);
    fs.writeFileSync(homeLog, `${promptLine('fast', 'home prompt only')}\nexit_code: 3\n`);
    const now = Date.now();
    fs.utimesSync(localLog, (now - 10000) / 1000, (now - 10000) / 1000);

    const emptyWork = path.join(root, 'empty');
    fs.mkdirSync(emptyWork);
    const empty = scanChatLogs({ cwd: emptyWork, hours: 6, limit: 2 });
    assert.deepStrictEqual(empty.summary, {
      sessions: 0,
      ax_sessions: 0,
      cursor_sessions: 0,
      findings: 0,
      high_findings: 0,
    });
    assert.strictEqual(empty.scope, 'workspace');
    assert.strictEqual(empty.window_hours, 6);
    assert.deepStrictEqual(empty.sources, { ax_dirs: [], cursor_roots: [] });
    assert.deepStrictEqual(empty.sessions, []);
    assert.strictEqual(empty.next_command, 'atris chat scan --hours 168');

    const local = scanChatLogs({ cwd: work, hours: 24 });
    assert.strictEqual(local.scope, 'workspace');
    assert.strictEqual(local.summary.sessions, 1);
    assert.strictEqual(local.sessions[0].last_user, 'local prompt only');
    assert.strictEqual(local.sessions[0].rel_path, path.join('atris', 'runs', 'ax-local.log'));
    assert.strictEqual(local.summary.findings, 0);
    assert.deepStrictEqual(local.sources.ax_dirs, [runs]);
    assert.ok(!JSON.stringify(local).includes('home prompt only'));

    const globalReport = scanChatLogs({ cwd: work, hours: 24, global: true });
    assert.strictEqual(globalReport.scope, 'global');
    assert.strictEqual(globalReport.summary.sessions, 2);
    assert.strictEqual(globalReport.summary.ax_sessions, 2);
    assert.strictEqual(globalReport.summary.high_findings, 1);
    assert.deepStrictEqual(globalReport.sources.ax_dirs, [runs, homeRuns]);
    assert.strictEqual(globalReport.sessions[0].last_user, 'home prompt only');
    assert.strictEqual(globalReport.sessions[0].exit_code, 3);
    assert.strictEqual(globalReport.sessions[0].path, homeLog);
    assert.strictEqual(globalReport.sessions[0].rel_path, homeLog);
    assert.strictEqual(globalReport.sessions[1].last_user, 'local prompt only');
    assert.strictEqual(globalReport.sessions[1].exit_code, null);
    assert.deepStrictEqual(globalReport.findings.map((finding) => finding.code), ['nonzero_exit']);
    assert.strictEqual(globalReport.findings[0].title, 'Chat session exited with code 3');
    assert.strictEqual(globalReport.findings[0].evidence, 'home prompt only');
  });
});
