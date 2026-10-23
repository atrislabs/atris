'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { playbookFile } = require('../commands/playbook');

test('playbookFile locates the playbook below the supplied root without creating it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-playbook-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.strictEqual(playbookFile(root), path.join(root, '.atris', 'state', 'playbook.json'));
  assert.deepStrictEqual(fs.readdirSync(root), []);
});

test('playbookFile normalizes parent segments and trailing separators', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-playbook-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = `${root}${path.sep}unused${path.sep}..${path.sep}workspace with spaces${path.sep}`;

  assert.strictEqual(
    playbookFile(input),
    path.join(root, 'workspace with spaces', '.atris', 'state', 'playbook.json'),
  );
});

test('playbookFile accepts an empty root as a relative path', () => {
  assert.strictEqual(playbookFile(''), path.join('.atris', 'state', 'playbook.json'));
});

test('playbookFile rejects roots that are not strings', () => {
  for (const root of [null, 42, {}, []]) {
    assert.throws(() => playbookFile(root), { code: 'ERR_INVALID_ARG_TYPE' });
  }
});
