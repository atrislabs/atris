'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-roster-job-name-error-'));
process.env.HOME = tmpHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { rosterJobNameError, rosterJobKey } = require('../lib/engine-registry');

const NAME_THE_JOB = 'name the job, for example: build, review, search, or "small build"';

after(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('a name that slugs onto a built-in job points at that job', () => {
  assert.strictEqual(
    rosterJobNameError('builder!'),
    '"builder!" is too close to the built-in build job. type build to change that job, or pick another name'
  );
  assert.strictEqual(
    rosterJobNameError('Reviewer'),
    '"Reviewer" is too close to the built-in review job. type review to change that job, or pick another name'
  );
  assert.match(rosterJobNameError('navigator?'), /built-in search job\. type search to change/);
  assert.match(rosterJobNameError('Validator.'), /built-in review job\. type review to change/);
});

test('the quoted name is trimmed but keeps its original casing and punctuation', () => {
  assert.strictEqual(
    rosterJobNameError('   Executor!!   '),
    '"Executor!!" is too close to the built-in build job. type build to change that job, or pick another name'
  );
});

test('empty, blank, and missing names get the plain "name the job" refusal', () => {
  assert.strictEqual(rosterJobNameError(''), NAME_THE_JOB);
  assert.strictEqual(rosterJobNameError('   '), NAME_THE_JOB);
  assert.strictEqual(rosterJobNameError(), NAME_THE_JOB);
  assert.strictEqual(rosterJobNameError(null), NAME_THE_JOB);
  assert.strictEqual(rosterJobNameError(undefined), NAME_THE_JOB);
});

test('names with no letters or digits slug to nothing and get the plain refusal', () => {
  assert.strictEqual(rosterJobNameError('!!!'), NAME_THE_JOB);
  assert.strictEqual(rosterJobNameError(' - _ / '), NAME_THE_JOB);
});

test('a name that is not close to a built-in job gets the plain refusal, not a near-match', () => {
  const message = rosterJobNameError('small build');
  assert.strictEqual(message, NAME_THE_JOB);
  assert.doesNotMatch(message, /too close/);
});

test('every name the key lookup rejects comes with a non-empty explanation', () => {
  for (const name of ['', '   ', '!!!', 'builder!', 'Reviewer?', 'navigator...', 'validator!']) {
    assert.strictEqual(rosterJobKey(name), '', `expected no key for ${JSON.stringify(name)}`);
    const message = rosterJobNameError(name);
    assert.strictEqual(typeof message, 'string');
    assert.ok(message.length > 0, `expected an error message for ${JSON.stringify(name)}`);
  }
});
