'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ENGINE_JOBS, ENGINE_ROLES } = require('../lib/engine-registry');

test('ENGINE_JOBS maps each built-in job to its role', () => {
  assert.deepEqual(ENGINE_JOBS, { search: 'navigator', build: 'executor', review: 'validator' });
  assert.equal(ENGINE_JOBS.search, 'navigator');
  assert.equal(ENGINE_JOBS.build, 'executor');
  assert.equal(ENGINE_JOBS.review, 'validator');
});

test('every ENGINE_JOBS value is a role the registry knows', () => {
  const entries = Object.entries(ENGINE_JOBS);
  assert.equal(entries.length, 3);
  for (const [job, role] of entries) {
    assert.equal(typeof job, 'string');
    assert.ok(ENGINE_ROLES.includes(role), `${job} maps to unknown role ${role}`);
  }
});

test('ENGINE_JOBS is frozen and unknown jobs read as undefined', () => {
  assert.ok(Object.isFrozen(ENGINE_JOBS));
  assert.throws(() => { ENGINE_JOBS.extra = 'navigator'; }, TypeError);
  assert.equal(ENGINE_JOBS.extra, undefined);
  assert.equal(ENGINE_JOBS[''], undefined);
  assert.equal(ENGINE_JOBS.deploy, undefined);
});
