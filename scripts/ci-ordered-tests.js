'use strict';

const path = require('node:path');
const { run } = require('node:test');
const { spec } = require('node:test/reporters');
const { pipeline } = require('node:stream/promises');

const files = process.argv.slice(2).map(file => path.resolve(file));
const tests = run({ files, concurrency: true });
tests.on('test:summary', ({ success }) => {
  if (!success) process.exitCode = 1;
});
pipeline(tests.compose(spec()), process.stdout, { end: false }).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
