'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { agentDogfoodCommand } = require('../commands/agent-spawn');

test('Devin sentinel check reports the exact Devin invocation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-spawn-invocation-'));
  try {
    const result = agentDogfoodCommand([
      '--engine', 'devin', '--live', '--no-write', '--json',
    ], {
      root,
      output: () => {},
      commandOnPath: () => path.join(root, 'devin'),
      // Simulate CLI replies without launching an engine or any subprocess.
      spawnSync: (command, args) => ({
        status: 0,
        stdout: args.includes('--help')
          ? 'Usage: devin --model <MODEL> -p <PROMPT>\n'
          : args.includes('version')
            ? 'devin test version\n'
            : 'ATRIS_DEVIN_GLM52_OK\n',
        stderr: '',
      }),
    });

    const check = result.engines[0].checks.find(item => item.name === 'live_sentinel_prompt');
    assert.ok(check, 'the successful dry checks must reach the sentinel invocation');
    assert.equal(check.command,
      'devin --model glm-5.2 --permission-mode auto -p Return exactly ATRIS_DEVIN_GLM52_OK. Do not inspect files. Do not run tools.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
