'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('an explicit one-on-one speaks with an existing member', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mode-'));
  const savedEnv = { ...process.env };
  const cwd = process.cwd();
  const log = console.log;
  const error = console.error;
  const exit = process.exit;
  const lines = [];
  try {
    process.env.HOME = root;
    process.env.PATH = '';
    process.chdir(root);
    console.log = (...args) => lines.push(args.join(' '));
    console.error = () => {};
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    const member = path.join(root, 'atris', 'team', 'alice');
    fs.mkdirSync(member, { recursive: true });
    fs.writeFileSync(path.join(member, 'MEMBER.md'), '# Alice\n');
    const { interviewCommand } = require('../commands/interview');
    await interviewCommand(['alice', '--yes'], root, { mode: 'one_on_one' });
    assert.ok(lines.some((line) => /1-on-1 with alice/.test(line)));
  } finally {
    console.log = log;
    console.error = error;
    process.exit = exit;
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
});
