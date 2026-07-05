const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-init-for-agents-'));
}

function cleanup(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('init writes FOR_AGENTS and the AGENTS adapter breadcrumb', () => {
  const tempDir = createTempDir();
  const homeDir = path.join(tempDir, 'home');
  fs.mkdirSync(homeDir);

  try {
    const result = spawnSync(process.execPath, [cliPath, 'init'], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        HOME: homeDir,
      },
    });

    assert.equal(
      result.status,
      0,
      `init failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );

    const forAgentsPath = path.join(tempDir, 'atris', 'FOR_AGENTS.md');
    assert.equal(fs.existsSync(forAgentsPath), true);
    assert.ok(fs.readFileSync(forAgentsPath, 'utf8').trim().length > 0);

    const agentsPath = path.join(tempDir, 'AGENTS.md');
    const agentsContent = fs.readFileSync(agentsPath, 'utf8');
    assert.ok(agentsContent.includes('FOR_AGENTS.md'));
  } finally {
    cleanup(tempDir);
  }
});
