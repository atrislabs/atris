'use strict';

// `atris deck lint --help` / `deck build --help` are explicit help requests:
// they must exit 0. A genuinely missing spec path stays a usage error (exit 2).

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../commands/deck');

// Silence the usage lines the dispatcher prints while we probe exit codes.
async function exitCode(argv) {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run(argv);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

for (const sub of ['lint', 'build']) {
  for (const flag of ['--help', '-h']) {
    test(`deck ${sub} ${flag} exits 0`, async () => {
      assert.equal(await exitCode([sub, flag]), 0);
    });
  }
  test(`deck ${sub} with no spec is still a usage error (exit 2)`, async () => {
    assert.equal(await exitCode([sub]), 2);
  });
}
