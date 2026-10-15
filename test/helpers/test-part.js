// Splits one big test file across parallel CI shards. node --test shards by
// file, so commands.test.js (400+ tests, one process) used to set the pace
// for every merge. With ATRIS_TEST_SPLIT set (CI), the file keeps part 1 and
// test/commands.part-N.test.js run the rest, round-robin by test order.
// Unset (local runs), the file runs every test and the part files run none.
const nodeTest = require('node:test');

function splitTests(defaultPart) {
  const part = global.__atrisTestPart || (process.env.ATRIS_TEST_SPLIT ? defaultPart : null);
  if (!part) return nodeTest;
  const [index, total] = part.split('/').map(Number);
  let seen = 0;
  const test = (...args) => (seen++ % total === index - 1 ? nodeTest(...args) : undefined);
  return Object.assign(test, nodeTest);
}

function runPart(file, part) {
  if (!process.env.ATRIS_TEST_SPLIT) return;
  global.__atrisTestPart = part;
  require(file);
}

module.exports = { runPart, splitTests };
