'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillEvalCommand } = require('../commands/skill-eval');

test('the worker model is excluded from independent judge selection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-model-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const output = [];
  try {
    process.chdir(root);
    process.env.HOME = root;
    console.log = console.error = (...args) => output.push(args.join(' '));
    process.exit = (code) => { throw new Error(`exit ${code}`); };
    fs.writeFileSync(path.join(root, 'SKILL.md'), '# Example\n\nFollow the instructions.\n');
    skillEvalCommand(['SKILL.md', '--worker-model', 'cursor', '--json'], {
      root,
      getEngineAdapter: (name) => ({
        name,
        available: () => ({ available: false, reason: 'not installed' }),
      }),
    });
    assert.match(JSON.parse(output.join('\n')).error, /cursor: matches worker model/);
  } finally {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
});
