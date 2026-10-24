require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { stringsCommand, saveRegistry } = require('../commands/strings');

test('staged term checks ignore existing files with unsupported extensions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-strings-filter-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    const env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
    execFileSync('git', ['init', '--quiet'], { cwd: root, env });
    fs.writeFileSync('inventory.csv', 'status\nlive\n');
    fs.writeFileSync('page.md', 'active\n');
    execFileSync('git', ['add', '--', 'inventory.csv', 'page.md'], { cwd: root, env });
    saveRegistry({ version: 1, strings: [], terms: [{ ban: 'live', prefer: 'active' }] });
    console.log = (...args) => output.push(args.join(' '));
    console.error = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };

    const code = stringsCommand(['check', '--staged', '--json']);
    const result = JSON.parse(output.join('\n'));
    assert.equal(result.findings.some((finding) => finding.file === 'inventory.csv'), false,
      'a staged CSV must not produce a banned-term finding');
    assert.equal(result.scanned, 1, 'only the supported Markdown file is scanned');
    assert.equal(code, 0);
  } finally {
    console.log = log;
    console.error = error;
    process.exit = exit;
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  }
});
