const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { appendMasterDailyEntry } = require('../lib/daily-log');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-master-daily-log-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function listMasterLogs(root) {
  const logsDir = path.join(root, 'atris', 'logs');
  if (!fs.existsSync(logsDir)) return [];
  return fs.readdirSync(logsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((yearDir) => fs.readdirSync(path.join(logsDir, yearDir.name))
      .map((file) => path.join(logsDir, yearDir.name, file)));
}

test('writes a titled entry with fields into the year-scoped master log', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const logPath = appendMasterDailyEntry(dir, 'Task shipped', {
      task: 't-7',
      note: 'decision: keep the master log curated',
    });
    assert.equal(typeof logPath, 'string');
    assert.equal(logPath, path.join(dir, 'atris', 'logs', path.basename(path.dirname(logPath)), path.basename(logPath)));
    assert.match(path.basename(path.dirname(logPath)), /^\d{4}$/);
    assert.match(path.basename(logPath), /^\d{4}-\d{2}-\d{2}\.md$/);

    const content = fs.readFileSync(logPath, 'utf8');
    assert.match(content, /^## \d{2}:\d{2} · Task shipped$/m);
    assert.match(content, /^- task: t-7$/m);
    assert.match(content, /^- note: decision: keep the master log curated$/m);
    assert.ok(content.endsWith('- note: decision: keep the master log curated\n'));
  } finally {
    cleanupTempDir(dir);
  }
});

test('returns null and writes nothing when the workspace has no atris dir', () => {
  const dir = makeTempDir();
  try {
    const result = appendMasterDailyEntry(dir, 'Task shipped', { task: 't-1' });
    assert.equal(result, null);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.deepEqual(listMasterLogs(dir), []);
  } finally {
    cleanupTempDir(dir);
  }
});

test('drops empty field values and compacts multiline text to one line', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const logPath = appendMasterDailyEntry(dir, 'Task update', {
      keep: 'yes',
      empty: '',
      nil: null,
      missing: undefined,
      note: 'line one\n\nline    two',
    });
    const content = fs.readFileSync(logPath, 'utf8');
    assert.match(content, /^- keep: yes$/m);
    assert.doesNotMatch(content, /^- (empty|nil|missing):/m);
    assert.match(content, /^- note: line one line two$/m);
    assert.equal(content.includes('line one\n'), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('appends repeated entries to the same daily file', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const first = appendMasterDailyEntry(dir, 'Task claimed', { task: 't-1' });
    const second = appendMasterDailyEntry(dir, 'Task completed', { task: 't-1' });
    assert.equal(first, second);

    const content = fs.readFileSync(first, 'utf8');
    assert.equal(content.match(/^## /gm).length, 2);
    assert.match(content, /Task claimed/);
    assert.match(content, /Task completed/);
    assert.equal(listMasterLogs(dir).length, 1);
  } finally {
    cleanupTempDir(dir);
  }
});
