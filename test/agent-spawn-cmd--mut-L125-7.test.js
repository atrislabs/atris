const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { agentDogfoodCommand } = require('../commands/agent-spawn');

test('agentDogfoodCommand keeps the engine stderr text on the version check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-agent-spawn-cmd-mut-L125-7-'));
  try {
    const result = agentDogfoodCommand(['--engine', 'devin', '--no-write', '--json'], {
      root: dir,
      output: () => {},
      commandOnPath: () => '/usr/bin/devin',
      spawnSync: (cmd, args = []) => {
        const joined = [cmd, ...args].join(' ');
        if (joined === 'devin version') {
          return { status: 0, stdout: 'devin 2026.7.23\n', stderr: 'WARN-MARKER' };
        }
        if (joined === 'devin --help') {
          return { status: 0, stdout: 'Usage: devin --model <MODEL> -p <PROMPT>\n', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: '' };
      },
    });
    const version = result.engines[0].checks.find((check) => check.name === 'version_command');
    assert.equal(version.stderr_head, 'WARN-MARKER');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
