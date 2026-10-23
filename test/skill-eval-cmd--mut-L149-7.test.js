'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillEvalCommand } = require('../commands/skill-eval');

test('judge rubric supplied as text reports that rubric scores are missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-rubric-type-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const output = [];

  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = (...values) => output.push(values.join(' '));
    console.error = (...values) => output.push(values.join(' '));
    process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
    const skill = 'atris/skills/example/SKILL.md';
    fs.mkdirSync(path.dirname(path.join(root, skill)), { recursive: true });
    fs.writeFileSync(path.join(root, skill), '# Example\nFollow the instructions.\n');

    const status = skillEvalCommand([
      skill, '--worker-model', 'codex', '--judge', 'claude', '--json',
    ], {
      root,
      getEngineAdapter: () => ({
        name: 'claude',
        available: () => ({ available: true }),
        run: () => ({
          status: 0,
          stdout: JSON.stringify({
            passed: true,
            rubric_scores: 'all criteria passed',
            summary: 'The instructions are clear and verifiable.',
          }),
          stderr: '',
        }),
      }),
    });

    assert.equal(status, 2);
    const result = output.map((line) => JSON.parse(line)).find((value) => value.error);
    assert.ok(result, 'expected a structured validation error');
    assert.equal(result.error, 'the judge did not return rubric scores');
  } finally {
    process.chdir(previousCwd);
    process.env.HOME = previousHome === undefined ? '' : previousHome;
    if (previousHome === undefined) delete process.env.HOME;
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
  }
});
