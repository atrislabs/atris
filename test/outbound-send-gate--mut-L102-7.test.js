'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertOutboundSendAllowedOrExit } = require('../lib/outbound-send-gate');

test('explicit html format requires render proof even for a text-only body', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explicit-html-'));
  const originalExit = process.exit;
  const originalError = console.error;
  const originalHome = process.env.HOME;
  const originalTmp = process.env.TMPDIR;
  const errors = [];
  process.env.HOME = dir;
  process.env.TMPDIR = dir;
  process.exit = (code) => { throw new Error(`unexpected exit ${code}: ${errors.join(' ')}`); };
  console.error = (...args) => errors.push(args.join(' '));
  try {
    try {
      assertOutboundSendAllowedOrExit('email', 'The release is ready.', {
        format: 'html',
      });
    } catch (error) {
      if (!error.message.startsWith('unexpected exit ')) throw error;
    }
    assert.ok(errors.some((line) => line.includes('render-proof-missing')));
  } finally {
    if (originalTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmp;
    process.exit = originalExit;
    console.error = originalError;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
