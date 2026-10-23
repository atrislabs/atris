'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { playbookCommand } = require('../commands/playbook');

test('playbook add requires both family and rule when family is provided', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-playbook-'));
  try {
    assert.throws(
      () => playbookCommand(['add', 'voice'], { root }),
      {
        name: 'Error',
        message: 'add needs a family and rule',
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
