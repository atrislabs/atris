'use strict';

const path = require('node:path');
const { availableParallelism } = require('node:os');
const { run } = require('node:test');
const { spec } = require('node:test/reporters');
const { pipeline } = require('node:stream/promises');

const files = process.argv.slice(2).map(file => path.resolve(file));
const concurrency = process.env.ATRIS_TRIAL_LIMIT === 'four' ? availableParallelism() : true;
const tests = run({ files, concurrency });
tests.on('test:summary', ({ success, entryFile, duration_ms }) => {
  if (!success) process.exitCode = 1;
  if (process.env.GITHUB_ACTIONS && entryFile) {
    console.log('ci-file-timing', JSON.stringify([path.relative(process.cwd(), entryFile), duration_ms, success]));
  }
});
pipeline(tests.compose(spec()), process.stdout, { end: false }).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
