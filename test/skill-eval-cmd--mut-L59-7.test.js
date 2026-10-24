'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillEvalCommand } = require('../commands/skill-eval');

test('a sandbox marker alone identifies the worker as Codex', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-identity-'));
  const previousEnv = { ...process.env };
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const output = [];
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, { HOME: root, CODEX_SANDBOX: 'seatbelt', CODEX_MODEL: 'codex' });
    process.chdir(root);
    console.log = (...values) => output.push(values.join(' '));
    console.error = (...values) => output.push(values.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit ${code}`); };
    fs.writeFileSync(path.join(root, 'SKILL.md'), '# Example\n\nUse concrete proof.\n');
    skillEvalCommand(['SKILL.md', '--json'], {
      root,
      getEngineAdapter: (name) => ({ name, available: () => ({ available: false, reason: 'not installed' }) }),
    });
    assert.match(JSON.parse(output.join('\n')).error, /codex: matches worker model/);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
});
