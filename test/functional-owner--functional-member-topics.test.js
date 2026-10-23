'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FUNCTIONAL_MEMBER_TOPICS } = require('../lib/functional-owner');

function setupIsolatedEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-functional-member-topics-'));
  process.env.HOME = root;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ATRIS_')) {
      delete process.env[key];
    }
  }
  return root;
}

function cleanupIsolatedEnv(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

test('FUNCTIONAL_MEMBER_TOPICS contains valid topic entries and expected owners', () => {
  const root = setupIsolatedEnv();
  try {
    assert.strictEqual(Array.isArray(FUNCTIONAL_MEMBER_TOPICS), true);
    assert.strictEqual(FUNCTIONAL_MEMBER_TOPICS.length >= 10, true);

    const owners = FUNCTIONAL_MEMBER_TOPICS.map(item => item.owner);
    assert.strictEqual(owners.includes('task-planner'), true);
    assert.strictEqual(owners.includes('architect'), true);
    assert.strictEqual(owners.includes('mission-lead'), true);
    assert.strictEqual(owners.includes('validator'), true);

    for (const topic of FUNCTIONAL_MEMBER_TOPICS) {
      assert.strictEqual(typeof topic.owner, 'string');
      assert.strictEqual(topic.owner.length > 0, true);
      assert.strictEqual(Array.isArray(topic.terms), true);
      assert.strictEqual(topic.terms.length > 0, true);
      for (const term of topic.terms) {
        assert.strictEqual(typeof term, 'string');
        assert.strictEqual(term.length > 0, true);
        assert.strictEqual(term, term.toLowerCase());
      }
    }
  } finally {
    cleanupIsolatedEnv(root);
  }
});

test('FUNCTIONAL_MEMBER_TOPICS has unique owners and handles search edge cases', () => {
  const root = setupIsolatedEnv();
  try {
    const owners = FUNCTIONAL_MEMBER_TOPICS.map(item => item.owner);
    const uniqueOwners = new Set(owners);
    assert.strictEqual(uniqueOwners.size, owners.length);

    const nonExistent = FUNCTIONAL_MEMBER_TOPICS.find(item => item.owner === 'non-existent-owner');
    assert.strictEqual(nonExistent, undefined);

    const matchingTerm = FUNCTIONAL_MEMBER_TOPICS.filter(item => item.terms.includes('verify'));
    assert.strictEqual(matchingTerm.length, 1);
    assert.strictEqual(matchingTerm[0].owner, 'validator');

    const emptyTermMatches = FUNCTIONAL_MEMBER_TOPICS.filter(item => item.terms.includes(''));
    assert.strictEqual(emptyTermMatches.length, 0);

    const unknownTermMatches = FUNCTIONAL_MEMBER_TOPICS.filter(item => item.terms.includes('xyz-unknown-term-12345'));
    assert.strictEqual(unknownTermMatches.length, 0);
  } finally {
    cleanupIsolatedEnv(root);
  }
});

test('FUNCTIONAL_MEMBER_TOPICS entries conform to slug naming rules', () => {
  const root = setupIsolatedEnv();
  try {
    for (const topic of FUNCTIONAL_MEMBER_TOPICS) {
      assert.match(topic.owner, /^[a-z0-9]+(-[a-z0-9]+)*$/);
      for (const term of topic.terms) {
        assert.strictEqual(term.trim(), term);
        assert.strictEqual(term.length > 0, true);
      }
    }
  } finally {
    cleanupIsolatedEnv(root);
  }
});
