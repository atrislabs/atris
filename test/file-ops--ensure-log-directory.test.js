'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureLogDirectory, getLogPath } = require('../lib/file-ops');

// Noon UTC on a mid-year day. Every time zone still falls in 2020, so the
// year folder does not follow the machine clock.
const FIXED_MS = Date.UTC(2020, 5, 15, 12, 0, 0);
const YEAR = '2020';

function withFixedClock(run) {
  const OriginalDate = Date;

  class FrozenDate extends OriginalDate {
    constructor(...args) {
      super(...(args.length === 0 ? [FIXED_MS] : args));
    }

    static now() {
      return FIXED_MS;
    }
  }

  global.Date = FrozenDate;
  try {
    return run();
  } finally {
    global.Date = OriginalDate;
  }
}

function withTempRoot(run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-ensure-log-directory-')));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const savedAtris = new Map();

  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      savedAtris.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  process.env.HOME = root;

  try {
    process.chdir(root);
    return withFixedClock(() => run(root));
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_') && !savedAtris.has(key)) delete process.env[key];
    }
    for (const [key, value] of savedAtris) process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertDirectory(dirPath) {
  const stat = fs.statSync(dirPath);
  assert.strictEqual(stat.isDirectory(), true);
}

test('ensureLogDirectory creates the logs directory and the year directory', () => {
  withTempRoot((root) => {
    const result = ensureLogDirectory();
    const { logsDir, yearDir } = getLogPath();
    const expectedLogs = path.join(root, 'atris', 'logs');
    const expectedYear = path.join(expectedLogs, YEAR);

    assert.strictEqual(result, undefined);
    assert.strictEqual(logsDir, expectedLogs);
    assert.strictEqual(yearDir, expectedYear);
    assertDirectory(logsDir);
    assertDirectory(yearDir);
    assert.deepStrictEqual(fs.readdirSync(logsDir), [YEAR]);
    assert.deepStrictEqual(fs.readdirSync(yearDir), []);
  });
});

test('ensureLogDirectory keeps an empty logs directory and an existing year path', () => {
  withTempRoot((root) => {
    const logsDir = path.join(root, 'atris', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    assert.deepStrictEqual(fs.readdirSync(logsDir), []);

    const created = ensureLogDirectory();
    const yearDir = path.join(logsDir, YEAR);

    assert.strictEqual(created, undefined);
    assert.strictEqual(getLogPath().yearDir, yearDir);
    assertDirectory(yearDir);
    assert.deepStrictEqual(fs.readdirSync(yearDir), []);

    fs.writeFileSync(path.join(yearDir, 'keep.txt'), 'stay');
    const again = ensureLogDirectory();

    assert.strictEqual(again, undefined);
    assert.strictEqual(fs.readFileSync(path.join(yearDir, 'keep.txt'), 'utf8'), 'stay');
    assert.deepStrictEqual(fs.readdirSync(logsDir), [YEAR]);
  });

  withTempRoot((root) => {
    const logsDir = path.join(root, 'atris', 'logs');
    const yearFile = path.join(logsDir, YEAR);
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(yearFile, 'not-a-directory');

    const result = ensureLogDirectory();

    assert.strictEqual(result, undefined);
    assert.strictEqual(fs.statSync(yearFile).isFile(), true);
    assert.strictEqual(fs.readFileSync(yearFile, 'utf8'), 'not-a-directory');
    assert.deepStrictEqual(fs.readdirSync(logsDir), [YEAR]);
  });
});

test('ensureLogDirectory throws when a parent path is a file', () => {
  withTempRoot((root) => {
    const atrisFile = path.join(root, 'atris');
    fs.writeFileSync(atrisFile, 'blocked');

    assert.throws(() => ensureLogDirectory(), (err) => {
      assert.ok(err instanceof Error);
      assert.strictEqual(err.code, 'ENOTDIR');
      return true;
    });
    assert.strictEqual(fs.readFileSync(atrisFile, 'utf8'), 'blocked');
    assert.strictEqual(fs.statSync(atrisFile).isFile(), true);
  });

  withTempRoot((root) => {
    const logsFile = path.join(root, 'atris', 'logs');
    fs.mkdirSync(path.dirname(logsFile));
    fs.writeFileSync(logsFile, 'blocked');

    assert.throws(() => ensureLogDirectory(), (err) => {
      assert.ok(err instanceof Error);
      assert.strictEqual(err.code, 'ENOTDIR');
      return true;
    });
    assert.strictEqual(fs.readFileSync(logsFile, 'utf8'), 'blocked');
    assert.strictEqual(fs.statSync(logsFile).isFile(), true);
  });
});
