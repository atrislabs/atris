'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skillEvalCommand } = require('../commands/skill-eval');

test('a missing rubric score is reported as invalid judge output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-rubric-'));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const output = [];
  try {
    process.env.HOME = root;
    process.chdir(root);
    console.log = (value) => output.push(String(value));
    fs.writeFileSync(path.join(root, 'SKILL.md'), '# Instructions\n');
    skillEvalCommand(['SKILL.md', '--worker-model', 'human', '--judge', 'claude', '--json'], {
      root,
      fs: {
        mkdtempSync: () => fs.mkdtempSync(path.join(root, 'review-')),
        rmSync: fs.rmSync,
      },
      getEngineAdapter: () => ({
        name: 'claude',
        available: () => ({ available: true }),
        run: () => ({
          status: 0,
          stdout: JSON.stringify({
            passed: true,
            rubric_scores: {
              trigger_precision: 4,
              procedural_completeness: 4,
              safety: 4,
              verifiability: 4,
            },
          }),
        }),
      }),
    });
    const result = JSON.parse(output.join('\n'));
    assert.match(result.error || '', /invalid instruction_clarity/);
  } finally {
    console.log = originalLog;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
