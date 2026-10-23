'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isFreshWorkspace } = require('../lib/first-minute');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'first-minute-fresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('an empty folder is fresh until an atris directory exists', (t) => {
  const root = workspace(t);
  assert.strictEqual(isFreshWorkspace(root), true);

  fs.mkdirSync(path.join(root, 'atris'));
  assert.strictEqual(isFreshWorkspace(root), false);
});

test('ordinary project files and a hidden .atris directory still count as fresh', (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'README.md'), '# Example project\n');
  fs.mkdirSync(path.join(root, '.atris'));
  assert.strictEqual(isFreshWorkspace(root), true);
});

test('a file named atris also makes the workspace non-fresh', (t) => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'atris'), '');
  assert.strictEqual(isFreshWorkspace(root), false);
});

test('a missing root is fresh and the check does not create it', (t) => {
  const root = path.join(workspace(t), 'missing');
  assert.strictEqual(isFreshWorkspace(root), true);
  assert.strictEqual(fs.existsSync(root), false);
});
