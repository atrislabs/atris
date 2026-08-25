const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

// Spawn the CLI from a temp dir, never the repo root: a repo-root cwd makes
// the CLI mutate the checkout's own .atris/state during the suite (CLI-1241).
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-help-test-'));
test.after(() => fs.rmSync(scratchCwd, { recursive: true, force: true }));

function runCli(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: scratchCwd,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.error) throw result.error;
  return result;
}

test('main help is short; help --all surfaces the golden path workflow', () => {
  const mainHelp = runCli(['help']);
  assert.equal(mainHelp.status, 0, mainHelp.stderr);
  const shortLines = mainHelp.stdout.split(/\r?\n/).filter((line) => line.trim()).length;
  assert.ok(shortLines <= 16, `default help should fit one screen, got ${shortLines} non-empty lines`);
  assert.match(mainHelp.stdout, /Golden path:/);
  assert.match(mainHelp.stdout, /help --all/);
  assert.match(mainHelp.stdout, /atris: you say what you want; atris builds it, checks it, and shows proof\./);
  assert.doesNotMatch(mainHelp.stdout, /\u2014/);
  assert.doesNotMatch(mainHelp.stdout, /atris task delegate "fix the login bug"/);
  assert.doesNotMatch(mainHelp.stdout, /atris ask |atris stop |atris ready /);

  const dashHelp = runCli(['--help']);
  assert.equal(dashHelp.status, 0, dashHelp.stderr);
  assert.equal(dashHelp.stdout, mainHelp.stdout);

  const allHelp = runCli(['help', '--all']);
  assert.equal(allHelp.status, 0, allHelp.stderr);
  assert.match(allHelp.stdout, /golden path \(one tick, by cron or by hand\):/);
  assert.match(allHelp.stdout, /atris task delegate "fix the login bug" --to <member>/);
  assert.match(allHelp.stdout, /atris autoland tick   # second check runs, task lands/);
  assert.match(allHelp.stdout, /atris task ready <id> --proof/);
  assert.match(allHelp.stdout, /atris mission status/);
  assert.match(allHelp.stdout, /ask\/stop\/ready\s+see atris mission and atris task ready/);
  assert.doesNotMatch(allHelp.stdout, /atris ask "what you want"/);
  assert.doesNotMatch(allHelp.stdout, /atris stop\s+Stop the current mission/);
  assert.doesNotMatch(allHelp.stdout, /atris ready --json\s+Show which mission features are ready/);
  assert.ok(allHelp.stdout.split(/\r?\n/).length > mainHelp.stdout.split(/\r?\n/).length);

  const taskHelp = runCli(['task', 'help']);
  assert.equal(taskHelp.status, 0, taskHelp.stderr);
  assert.match(taskHelp.stdout, /golden path \(one tick, by cron or by hand\):/);
  assert.match(taskHelp.stdout, /atris task ready <id> --verify/);
  assert.match(taskHelp.stdout, /atris autoland tick   # second check runs, task lands/);
});
