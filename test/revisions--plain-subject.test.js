'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { plainSubject } = require('../commands/revisions');

function setupIsolatedEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-plain-subject-'));
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

test('plainSubject normalizes normal subjects to lowercase trimmed strings', () => {
  const root = setupIsolatedEnv();
  try {
    assert.strictEqual(
      plainSubject('Add User Authentication'),
      'add user authentication'
    );
    assert.strictEqual(
      plainSubject('fix landing flow'),
      'fix landing flow'
    );
  } finally {
    cleanupIsolatedEnv(root);
  }
});

test('plainSubject handles edge cases with em dashes and irregular whitespace', () => {
  const root = setupIsolatedEnv();
  try {
    assert.strictEqual(
      plainSubject('feat: auth \u2014 add session check'),
      'feat: auth , add session check'
    );
    assert.strictEqual(
      plainSubject('title—with—em-dash'),
      'title,with,em-dash'
    );
    assert.strictEqual(
      plainSubject('  refactor   parser \n\t pipeline  '),
      'refactor parser pipeline'
    );
  } finally {
    cleanupIsolatedEnv(root);
  }
});

test('plainSubject defaults to untitled landing on empty or missing inputs', () => {
  const root = setupIsolatedEnv();
  try {
    assert.strictEqual(plainSubject(''), 'untitled landing');
    assert.strictEqual(plainSubject(null), 'untitled landing');
    assert.strictEqual(plainSubject(undefined), 'untitled landing');
    assert.strictEqual(plainSubject(), 'untitled landing');
  } finally {
    cleanupIsolatedEnv(root);
  }
});
