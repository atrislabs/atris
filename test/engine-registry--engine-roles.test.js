'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-engine-roles-'));
process.env.HOME = tmpHome;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { ENGINE_ROLES, ENGINE_JOBS } = require('../lib/engine-registry');

test('ENGINE_ROLES lists the three built-in roles in routing order', () => {
  assert.deepStrictEqual(ENGINE_ROLES, ['navigator', 'executor', 'validator']);
});

test('ENGINE_ROLES is frozen and refuses mutation', () => {
  assert.strictEqual(Object.isFrozen(ENGINE_ROLES), true);
  assert.throws(() => ENGINE_ROLES.push('reviewer'), TypeError);
  assert.strictEqual(ENGINE_ROLES.length, 3);
});

test('ENGINE_ROLES keeps roles separate from job names and has no duplicates', () => {
  for (const job of ['search', 'build', 'review']) {
    assert.strictEqual(ENGINE_ROLES.includes(job), false, `${job} is a job, not a role`);
  }
  for (const job of Object.keys(ENGINE_JOBS)) {
    assert.ok(ENGINE_ROLES.includes(ENGINE_JOBS[job]), `job ${job} must map to a real role`);
  }
  assert.strictEqual(new Set(ENGINE_ROLES).size, ENGINE_ROLES.length);
  for (const role of ENGINE_ROLES) {
    assert.match(role, /^[a-z]+$/);
  }
});

test('ENGINE_ROLES membership is exact: empty and mixed-case strings are not roles', () => {
  assert.strictEqual(ENGINE_ROLES.includes(''), false);
  assert.strictEqual(ENGINE_ROLES.includes('Navigator'), false);
  assert.strictEqual(ENGINE_ROLES.includes(' navigator'), false);
});
