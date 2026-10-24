require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyticsAtris } = require('../commands/analytics');

test('analyticsAtris excludes out-of-range hours even when they dominate activity', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-hour-range-')));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const exists = fs.existsSync;
  const read = fs.readFileSync;
  const lines = [];
  const logs = path.join(root, 'atris', 'logs');
  const fixture = path.join(root, 'journal.md');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(fixture, '### Work -- 09:00\n### Typo -- 24:00\n**24:30**\n');
  // Supply the same journal for any requested calendar day, independent of
  // the clock or timezone. All other filesystem reads retain their behavior.
  const isJournal = (file) => typeof file === 'string' &&
    file.startsWith(logs + path.sep) && /^\d{4}-\d{2}-\d{2}\.md$/.test(path.basename(file));
  try {
    process.chdir(root);
    process.env.HOME = root;
    t.mock.method(fs, 'existsSync', (file) => isJournal(file) || exists(file));
    t.mock.method(fs, 'readFileSync', (file, ...args) => read(isJournal(file) ? fixture : file, ...args));
    t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
    t.mock.method(process, 'exit', (code) => { throw new Error(`unexpected exit ${code}`); });
    analyticsAtris();
    const hourLine = lines.find((line) => /Most active hour:/.test(line)) || '';
    assert.equal(/\b9:00\b/.test(hourLine), true, hourLine);
  } finally {
    t.mock.restoreAll();
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
