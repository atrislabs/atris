'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start, readPlan, coach } = require('../commands/write');

test('offline coaching preserves the question edited into a beat', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-beat-question-'));
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  const previousLog = console.log;
  const previousError = console.error;
  const previousExit = process.exit;
  const output = [];
  process.env.HOME = root;
  process.chdir(root);
  console.log = (...parts) => output.push(parts.join(' '));
  console.error = (...parts) => output.push(parts.join(' '));
  process.exit = (code) => { throw new Error(`unexpected exit: ${code}`); };
  try {
    start(['Kitchen story', '--beats', 'Open'], root);
    const plan = readPlan('kitchen-story', root);
    const planFile = path.join(root, 'atris', 'writing', 'kitchen-story', 'plan.md');
    fs.writeFileSync(planFile, plan.text.replace(plan.beats[0].q,
      'What did the kettle sound like?'));
    output.length = 0;
    coach(['kitchen-story', '--offline'], root);
    assert.ok(output.some((line) => /question:.*kettle/.test(line)),
      'coaching should ask the question supplied in the plan');
  } finally {
    console.log = previousLog;
    console.error = previousError;
    process.exit = previousExit;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
