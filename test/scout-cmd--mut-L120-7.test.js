'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoutCommand } = require('../commands/scout');

test('a missing --dir value defaults to the current directory and prints help', async () => {
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args);
  let code;
  try {
    // No question means no engine is started, but --dir is still parsed.
    code = await scoutCommand(['--yes', '--dir']);
  } finally {
    console.log = originalLog;
  }
  assert.equal(code, 1);
  assert.deepEqual(output, [[`
  atris scout: cheap read-only subagents for search & context questions

  usage:
    atris scout "<question>" ["<question>" ...]     parallel scouts, one per question
    atris scout --dir <path> "<question>"           scout a different repo
    atris scout --model sonnet "<question>"         upgrade the model (default: haiku)
    atris scout --engine fast "<question>"          engine: claude | cursor | devin | fast
    atris scout --timeout 300 "<question>"          seconds per scout (default: 180)

  engines: claude = claude -p with a read-only tool allowlist (default, haiku).
  fast = atris chat --print (glm-5.2 fast lane, needs an atris/ workspace).
  cursor = cursor-agent --trust -p. devin = devin -p (read-only by default).

  scouts are read-only: they answer in ≤30 lines with file:line citations.
`]]);
});
