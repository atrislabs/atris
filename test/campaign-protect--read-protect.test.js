'use strict';
require('./helpers/clean-temp');

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readProtect } = require('../lib/campaign-protect');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-read-protect-'));
}

function writeProtect(home, campaignId, contents) {
  const file = path.join(home, 'campaigns', campaignId, 'protect.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

test('returns the parsed protect record saved for the campaign', () => {
  const home = tmpHome();
  writeProtect(home, 'cmp_1', JSON.stringify({ paths: ['judge/questions.md', 'spec/idea.md'], base_commit: 'abc123' }, null, 2));

  const saved = readProtect(home, 'cmp_1');
  assert.deepEqual(saved, { paths: ['judge/questions.md', 'spec/idea.md'], base_commit: 'abc123' });
});

test('returns null when the campaign has no protect file', () => {
  const home = tmpHome();
  assert.equal(readProtect(home, 'cmp_missing'), null);
});

test('returns null when the protect file is not valid JSON', () => {
  const home = tmpHome();
  writeProtect(home, 'cmp_bad', '{ this is not json');

  assert.equal(readProtect(home, 'cmp_bad'), null);
});

test('returns null when the home directory itself does not exist', () => {
  const home = path.join(os.tmpdir(), `atris-read-protect-nohome-${process.pid}`);
  assert.equal(fs.existsSync(home), false);
  assert.equal(readProtect(home, 'cmp_1'), null);
});

test('does not read a different campaign id in the same home', () => {
  const home = tmpHome();
  writeProtect(home, 'cmp_a', JSON.stringify({ paths: ['a.md'], base_commit: 'aaa' }));

  assert.equal(readProtect(home, 'cmp_b'), null);
  assert.deepEqual(readProtect(home, 'cmp_a'), { paths: ['a.md'], base_commit: 'aaa' });
});
