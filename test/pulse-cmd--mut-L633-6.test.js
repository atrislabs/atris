'use strict';
require('./helpers/clean-temp');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installCommand } = require('../commands/pulse');

test('a bare runner name does not add the working directory to the installed search path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-search-path-'));
  const savedEnv = { ...process.env };
  const cwd = process.cwd();
  process.env.HOME = root;
  process.env.PATH = '/usr/bin:/bin';
  process.env.ATRIS_RUNNER_BIN = 'claude';
  process.chdir(root);
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  try {
    const installed = installCommand(['--hours', '1', '--no-keep-awake'], root, {
      homeDir: root,
      writeOutput: () => {},
      spawnSync(command, args) {
        if (command === 'which') return { status: 0, stdout: `/usr/local/bin/${args[0]}\n`, stderr: '' };
        if (command === 'crontab') return { status: args[0] === '-l' ? 1 : 0, stdout: '', stderr: '' };
        if (command === 'launchctl') return { status: 0, stdout: '', stderr: '' };
        throw new Error(`unexpected command: ${command}`);
      },
    });
    const script = fs.readFileSync(installed.script_path, 'utf8');
    const searchPath = script.split('\n').find(line => line.startsWith('export PATH='));
    assert.equal(searchPath.split(/[:"=]/).includes('.'), false);
  } finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
