const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { agentDogfoodCommand } = require('../commands/agent-spawn');

test('dogfood checks only the engine selected by --engine', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dogfood-engine-'));
  const output = [];
  try {
    agentDogfoodCommand(['--engine', 'devin', '--no-write'], {
      root,
      output: line => output.push(line),
      commandOnPath: () => null,
      spawnSync: () => {
        throw new Error('No external commands should run');
      },
    });

    assert.deepEqual(output, [
      'agent dogfood failed (dry)',
      '✗ devin glm-5.2',
      '  ✗ binary_on_path: devin not on PATH',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
