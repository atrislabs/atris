const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const packageJson = require('../package.json');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-version-cmd-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

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
