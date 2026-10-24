'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillEvalCommand } = require('../commands/skill-eval');

test('explicit timeout seconds are passed to the adapter in milliseconds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'explicit-judge-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  let timeout;
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = () => {};
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    fs.writeFileSync(path.join(root, 'SKILL.md'), '# Example\nFollow the instructions.\n');
    skillEvalCommand([
      'SKILL.md', '--judge', 'claude', '--worker-model', 'human', '--timeout', '17', '--json',
    ], {
      root,
      getEngineAdapter: (name) => ({
        name,
        available: () => ({ available: true }),
        run: (_prompt, _directory, milliseconds) => {
          timeout = milliseconds;
          return { status: 1, stdout: '', stderr: 'review unavailable' };
        },
      }),
    });
    assert.equal(timeout, 17000);
  } finally {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
});
