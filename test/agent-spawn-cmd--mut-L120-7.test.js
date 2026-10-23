const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { agentDogfoodCommand } = require('../commands/agent-spawn');

test('live sentinel check reports the child process signal verbatim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-agent-spawn-mut-'));
  try {
    const result = agentDogfoodCommand(['--engine', 'devin', '--live', '--no-write', '--json'], {
      root: dir,
      output: () => {},
      commandOnPath: (name) => `/usr/bin/${name}`,
      spawnSync: (cmd, args = []) => {
        const joined = [cmd, ...args].join(' ');
        if (joined === 'devin version') return { status: 0, stdout: 'devin 2026.7.23\n', stderr: '' };
        if (joined === 'devin --help') return { status: 0, stdout: 'Usage: devin --model <MODEL> -p <PROMPT>\n', stderr: '' };
        if (joined.includes('ATRIS_DEVIN_GLM52_OK')) {
          return { status: 0, signal: 'SIGTERM', stdout: 'ATRIS_DEVIN_GLM52_OK\n', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: `unexpected ${joined}` };
      },
    });
    const liveCheck = result.engines[0].checks.find((check) => check.name === 'live_sentinel_prompt');
    assert.ok(liveCheck);
    assert.equal(liveCheck.signal, 'SIGTERM');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
