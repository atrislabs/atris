const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLogFile } = require('../lib/file-ops');

function withTempCwd(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-create-log-file-'));
  const originalCwd = process.cwd();
  process.chdir(dir);
  t.after(() => process.chdir(originalCwd));
  return dir;
}

// getLogPath builds prev-day path as <cwd>/atris/logs/<year>/<YYYY-MM-DD>.md
function prevLogPath(dir, dateFormatted) {
  const [y, m, d] = dateFormatted.split('-').map(Number);
  const prev = new Date(y, m - 1, d);
  prev.setDate(prev.getDate() - 1);
  const prevYear = prev.getFullYear();
  const prevMonth = String(prev.getMonth() + 1).padStart(2, '0');
  const prevDay = String(prev.getDate()).padStart(2, '0');
  return path.join(dir, 'atris', 'logs', String(prevYear), `${prevYear}-${prevMonth}-${prevDay}.md`);
}

test('creates a log file with the full daily template when no previous log exists', (t) => {
  const dir = withTempCwd(t);
  const logFile = path.join(dir, 'new-log.md');

  createLogFile(logFile, '2026-03-10');

  const content = fs.readFileSync(logFile, 'utf8');
  assert.match(content, /^# Log, 2026-03-10\n/);
  for (const section of ['## Handoff', '## Completed ✅', '## In Progress 🔄', '## Backlog', '## Notes', '## Inbox']) {
    assert.ok(content.includes(section), `missing section: ${section}`);
  }
  const separators = content.match(/\n---\n/g) || [];
  assert.strictEqual(separators.length, 5);
});

test('carries In Progress, Backlog, and Inbox items forward from the previous day log', (t) => {
  const dir = withTempCwd(t);

  const prevFile = prevLogPath(dir, '2026-03-10');
  fs.mkdirSync(path.dirname(prevFile), { recursive: true });
  fs.writeFileSync(
    prevFile,
    [
      '# Log, 2026-03-09',
      '',
      '## In Progress 🔄',
      '',
      '- **T12:** ship the thing',
      '',
      '---',
      '',
      '## Backlog',
      '',
      '- backlog item one',
      '',
      '---',
      '',
      '## Inbox',
      '',
      '- **I3:** inbox idea',
      '',
    ].join('\n')
  );

  const logFile = path.join(dir, 'today.md');
  createLogFile(logFile, '2026-03-10');

  const content = fs.readFileSync(logFile, 'utf8');
  assert.match(content, /## In Progress 🔄\n\n- \*\*T12:\*\* ship the thing\n\n---/);
  assert.match(content, /## Backlog\n\n- backlog item one\n\n---/);
  assert.match(content, /## Inbox\n\n- \*\*I3:\*\* inbox idea\n/);
});

test('writes an empty template when the previous log exists but has no carry sections', (t) => {
  const dir = withTempCwd(t);

  const prevFile = prevLogPath(dir, '2026-01-02');
  fs.mkdirSync(path.dirname(prevFile), { recursive: true });
  fs.writeFileSync(prevFile, '# Log, 2026-01-01\n\n## Notes\n\njust notes\n');

  const logFile = path.join(dir, 'today.md');
  createLogFile(logFile, '2026-01-02');

  const content = fs.readFileSync(logFile, 'utf8');
  assert.match(content, /## In Progress 🔄\n\n---/);
  assert.match(content, /## Backlog\n\n---/);
  assert.match(content, /## Inbox\n\n\n$/);
  assert.ok(!content.includes('just notes'));
});

test('throws when the destination directory does not exist', (t) => {
  const dir = withTempCwd(t);
  const missing = path.join(dir, 'no-such-dir', 'log.md');

  assert.throws(() => createLogFile(missing, '2026-03-10'), { code: 'ENOENT' });
});

test('still writes a file for a malformed date string, using the string as the title', (t) => {
  const dir = withTempCwd(t);
  const logFile = path.join(dir, 'weird.md');

  createLogFile(logFile, 'not-a-date');

  const content = fs.readFileSync(logFile, 'utf8');
  assert.match(content, /^# Log, not-a-date\n/);
  assert.ok(content.includes('## Inbox'));
});
