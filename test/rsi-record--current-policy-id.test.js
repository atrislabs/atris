'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { currentPolicyId } = require('../lib/rsi-record');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePolicy(root, contents) {
  const dir = path.join(root, 'atris', 'rsi');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'policy.current'), contents);
}

test('currentPolicyId returns the id stored in policy.current', () => {
  const root = tmpdir('atris-rsi-policy-');
  writePolicy(root, 'p-0042\n');
  assert.equal(currentPolicyId(root), 'p-0042');
});

test('currentPolicyId trims surrounding whitespace from the file', () => {
  const root = tmpdir('atris-rsi-policy-');
  writePolicy(root, '   p-0007  \n\n');
  assert.equal(currentPolicyId(root), 'p-0007');
});

test('currentPolicyId returns the fallback when policy.current is missing', () => {
  const root = tmpdir('atris-rsi-policy-');
  assert.equal(currentPolicyId(root), 'p-0001');
  assert.equal(currentPolicyId(root, 'p-custom'), 'p-custom');
});

test('currentPolicyId returns the fallback when policy.current is empty', () => {
  const root = tmpdir('atris-rsi-policy-');
  writePolicy(root, '   \n');
  assert.equal(currentPolicyId(root), 'p-0001');
});

test('currentPolicyId returns the fallback when policy.current is unreadable', () => {
  const root = tmpdir('atris-rsi-policy-');
  const dir = path.join(root, 'atris', 'rsi');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'policy.current'));
  assert.equal(currentPolicyId(root), 'p-0001');
});
