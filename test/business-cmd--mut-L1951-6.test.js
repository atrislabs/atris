'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { businessCommand } = require('../commands/business');

test('business fleet reports an empty workspace as bare, not unbound', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fleet-bare-'));
  const previousRoot = process.env.ATRIS_BUSINESS_ROOT;
  const previousLog = console.log;
  const output = [];
  try {
    fs.mkdirSync(path.join(root, 'empty-co'));
    process.env.ATRIS_BUSINESS_ROOT = root;
    console.log = value => output.push(value);

    await businessCommand('fleet', '--json');

    assert.deepEqual(output, [JSON.stringify({
      root,
      customers: [{
        name: 'empty-co',
        bizName: 'empty-co',
        state: 'bare',
        icon: '⚪',
        files: 0,
        md: 0,
        hasBizJson: false,
        hasAtris: false,
        hasNested: false,
        action: 'not yet onboarded',
      }],
    }, null, 2)]);
  } finally {
    console.log = previousLog;
    if (previousRoot === undefined) delete process.env.ATRIS_BUSINESS_ROOT;
    else process.env.ATRIS_BUSINESS_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
