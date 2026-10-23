'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { interviewCommand } = require('../commands/interview');

test('interview without a workspace reports the workspace error instead of help', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stdout = [];
  const stderr = [];
  t.mock.method(console, 'log', (...args) => stdout.push(args));
  t.mock.method(console, 'error', (...args) => stderr.push(args));

  const result = await interviewCommand(['--yes'], root);

  assert.deepEqual(stderr, [
    ['✗ Not inside an Atris workspace (no atris/ directory found).'],
  ]);
  assert.deepEqual(stdout, []);
  assert.equal(result, 1);
});
