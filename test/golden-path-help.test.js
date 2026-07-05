const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function runCli(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.error) throw result.error;
  return result;
}

test('main help and task help surface the golden path workflow', () => {
  const mainHelp = runCli(['help']);
  assert.equal(mainHelp.status, 0, mainHelp.stderr);
  assert.match(mainHelp.stdout, /golden path \(zero human turns\):/);
  assert.match(mainHelp.stdout, /atris task delegate "fix the login bug" --to <member>/);
  assert.match(mainHelp.stdout, /atris autoland tick   # second check runs, task lands/);

  const taskHelp = runCli(['task', 'help']);
  assert.equal(taskHelp.status, 0, taskHelp.stderr);
  assert.match(taskHelp.stdout, /golden path \(zero human turns\):/);
  assert.match(taskHelp.stdout, /atris task ready <id> --verify/);
  assert.match(taskHelp.stdout, /atris autoland tick   # second check runs, task lands/);
});
