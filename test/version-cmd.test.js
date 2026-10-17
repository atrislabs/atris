const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTaskHelpFixture } = require('./helpers/task-help-fixture');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const packageJson = require('../package.json');

const { makeTempDir: makeFixtureDir, cleanupTempDir } = createTaskHelpFixture('atris-version-cmd-');
const makeTempDir = () => makeFixtureDir();

test('atris version prints version from package.json', () => {
  const dir = makeTempDir();
  try {
    const result = spawnSync(process.execPath, [cliPath, 'version'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 6000,
      env: {
        ...process.env,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        NODE_NO_WARNINGS: '1',
      },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `stderr: ${result.stderr || '<empty>'}`);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `atris v${packageJson.version}\n`);
  } finally {
    cleanupTempDir(dir);
  }
});
