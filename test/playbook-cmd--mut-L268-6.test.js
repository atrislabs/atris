'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { playbookCommand } = require('../commands/playbook');

test('a leading --json option defaults to showing the playbook', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-leading-option-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = [];

  const result = playbookCommand(['--json'], {
    root,
    output: (line) => output.push(line),
  });

  assert.equal(result, 0);
  assert.deepEqual(output, ['{\n  "version": 1,\n  "rules": []\n}']);
});
