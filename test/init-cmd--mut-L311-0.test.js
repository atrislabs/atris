const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initAtris } = require('../commands/init');

test('init -h prints help instead of initializing a workspace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-init-short-help-'));
  const originalCwd = process.cwd();
  const originalArgv = process.argv;
  const originalLog = console.log;
  const output = [];
  try {
    process.chdir(dir);
    // The remaining flags keep an accidental initialization local and noninteractive.
    process.argv = [process.execPath, 'atris', 'init', '-h', '--minimal', '--yes', '--no-commit'];
    console.log = (...args) => output.push(args.join(' '));
    await initAtris();
    assert.equal(output.join('\n'), `Usage: atris init [--force] [--yes|-y] [--verbose] [--minimal] [--full] [--with-adapters] [--with-skills] [--no-commit]

  Scaffold the atris/ workspace in the current directory.
  Refuses to run inside an existing atris/ folder unless --force is passed.
  Use --yes or -y to skip the interactive context gatherer after scaffolding.
  Use --verbose to list every file installed.
  Use --minimal for atris.md + MAP + TODO + today journal + .atris/state (no IDE farm).
  Use --with-adapters / --with-skills with --minimal, or --full for the default full scaffold.
  In a git repo with no commits yet, init commits the files it creates so every member copy starts with them.
  Use --no-commit to leave them uncommitted.`);
  } finally {
    console.log = originalLog;
    process.argv = originalArgv;
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
