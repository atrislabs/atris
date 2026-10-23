'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { agentDogfoodCommand } = require('../commands/agent-spawn');

test('agentDogfoodCommand sets model list detail for droid', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-spawn-mut-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpDir;

  t.after(() => {
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = agentDogfoodCommand(['--engine', 'droid', '--no-write', '--json'], {
    root: tmpDir,
    output: () => {},
    commandOnPath: (name) => `/usr/bin/${name}`,
    spawnSync: (cmd, args = []) => {
      const joined = [cmd, ...args].join(' ');
      if (joined === 'droid --version') return { status: 0, stdout: '0.156.2\n', stderr: '' };
      if (joined === 'droid exec --help') return { status: 0, stdout: 'Available Models:\n  glm-5.2 Droid Core\n', stderr: '' };
      return { status: 1, stdout: '', stderr: `unexpected ${joined}` };
    },
  });

  const check = result.engines[0].checks.find((item) => item.name === 'model_list_advertises_glm');
  assert.equal(check?.detail, 'glm-5.2 listed');
});
