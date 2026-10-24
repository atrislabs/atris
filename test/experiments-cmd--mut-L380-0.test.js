require('./helpers/clean-temp');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { experimentsCommand, ensureExperimentsFramework } = require('../commands/experiments');

test('runtime benchmark runs the local keep and revert trials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runtime-branch-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousExit = process.exit;
  const previousLog = console.log;
  const previousError = console.error;
  const exitSignal = new Error('command exited');
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = () => {};
    console.error = () => {};
    process.exit = () => { throw exitSignal; };
    fs.mkdirSync(path.join(root, 'atris'));
    const { experimentsDir } = ensureExperimentsFramework(root, { silent: true });
    const results = path.join(experimentsDir, '_examples', 'smoke-keep-revert', 'results.tsv');
    fs.writeFileSync(results, 'timestamp\ttrial\tstatus\told_score\tnew_score\tproposal\tdescription\n');
    try {
      experimentsCommand('benchmark', 'runtime');
    } catch (error) {
      if (error !== exitSignal) throw error;
    }
    const rows = fs.readFileSync(results, 'utf8').trim().split(/\r?\n/).slice(1);
    assert.equal(rows.some((row) => {
      const fields = row.split('\t');
      return fields[2] === 'kept' && Number(fields[4]) === 1;
    }), true);
  } finally {
    process.chdir(previousCwd);
    process.exit = previousExit;
    console.log = previousLog;
    console.error = previousError;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
