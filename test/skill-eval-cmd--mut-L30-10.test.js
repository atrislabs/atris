'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillEvalCommand } = require('../commands/skill-eval');

test('the judge flag selects the requested reviewer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-option-'));
  const cwd = process.cwd();
  const home = process.env.HOME;
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const requested = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = () => {};
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    fs.mkdirSync(path.join(root, 'skills', 'example'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills', 'example', 'SKILL.md'), '# Example\nFollow the instructions.\n');
    skillEvalCommand(['skills/example/SKILL.md', '--judge', 'claude', '--json'], {
      root,
      getEngineAdapter(name) {
        requested.push(name);
        return { name, available: () => ({ available: false, reason: 'not installed' }) };
      },
    });
    assert.equal(requested[0], 'claude');
  } finally {
    process.chdir(cwd);
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    console.log = log;
    console.error = error;
    process.exit = exit;
  }
});
