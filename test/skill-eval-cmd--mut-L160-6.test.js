'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillEvalCommand } = require('../commands/skill-eval');

test('a positive judge verdict cannot override a low rubric score', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rubric-verdict-'));
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
    fs.mkdirSync(path.join(root, path.dirname(skill)), { recursive: true });
    fs.writeFileSync(path.join(root, skill), '# Example\n\nCheck the result before continuing.\n');
    skillEvalCommand([skill, '--worker-model', 'codex', '--judge', 'claude', '--json'], {
      root,
      getEngineAdapter: () => ({
        name: 'claude',
        available: () => ({ available: true }),
        run: () => ({
          status: 0,
          stderr: '',
          stdout: JSON.stringify({
            passed: true,
            rubric_scores: {
              instruction_clarity: 4,
              trigger_precision: 4,
              procedural_completeness: 4,
              safety: 3,
              verifiability: 4,
            },
            summary: 'The safety instructions need improvement.',
          }),
        }),
      }),
    });
    assert.equal(JSON.parse(output.join('\n')).receipt.passed, false);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
