'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findHoldout, holdoutDir, moveHoldoutBack, moveHoldoutIn, scrub } = require('../lib/campaign-holdout');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atris-holdout-'));

test('findHoldout is null with no folder and finds the first file by name', () => {
  const home = tmp();
  assert.equal(findHoldout(home, 'c1'), null);
  const dir = holdoutDir(home, 'c1');
  fs.mkdirSync(path.join(dir, 'a-subdir'), { recursive: true });
  assert.equal(findHoldout(home, 'c1'), null);
  fs.writeFileSync(path.join(dir, 'z.jsonl'), 'z');
  fs.writeFileSync(path.join(dir, 'b.jsonl'), 'b');
  assert.equal(findHoldout(home, 'c1'), path.join(dir, 'b.jsonl'));
});

test('moveHoldoutIn moves the file out and moveHoldoutBack restores it', () => {
  const home = tmp();
  const repo = tmp();
  const source = path.join(repo, 'secret.jsonl');
  fs.writeFileSync(source, 'q1\n');
  const moved = moveHoldoutIn(home, 'c2', source);
  assert.equal(moved.path, path.join(holdoutDir(home, 'c2'), 'secret.jsonl'));
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(moved.path, 'utf8'), 'q1\n');
  moveHoldoutBack(moved);
  assert.equal(fs.readFileSync(source, 'utf8'), 'q1\n');
  assert.equal(fs.existsSync(moved.path), false);
});

test('moveHoldoutIn refuses a missing file or a folder in plain words', () => {
  const home = tmp();
  assert.deepEqual(moveHoldoutIn(home, 'c3', path.join(home, 'nope')), { error: `--holdout ${path.join(home, 'nope')} is not a file` });
  assert.match(moveHoldoutIn(home, 'c3', home).error, /is not a file/);
});

test('moveHoldoutBack never overwrites a file that reappeared at the source', () => {
  const home = tmp();
  const repo = tmp();
  const source = path.join(repo, 'h.txt');
  fs.writeFileSync(source, 'held');
  const moved = moveHoldoutIn(home, 'c4', source);
  fs.writeFileSync(source, 'new work');
  moveHoldoutBack(moved);
  assert.equal(fs.readFileSync(source, 'utf8'), 'new work');
  assert.equal(fs.readFileSync(moved.path, 'utf8'), 'held');
  assert.doesNotThrow(() => moveHoldoutBack(null));
});

test('scrub masks held-out lines, longest first, and ignores short lines', () => {
  const file = path.join(tmp(), 'h.txt');
  fs.writeFileSync(file, '  What is 2+2?  \nWhat is 2+2? Show work\nab\n\n');
  const out = scrub('judge said: What is 2+2? Show work, then What is 2+2? and ab', file);
  assert.equal(out, 'judge said: [held out], then [held out] and ab');
});

test('scrub passes text through when there is nothing to scrub with', () => {
  assert.equal(scrub('text', null), 'text');
  assert.equal(scrub('text', path.join(tmp(), 'missing')), 'text');
  assert.equal(scrub('', '/x'), '');
  assert.equal(scrub(undefined, '/x'), undefined);
});
