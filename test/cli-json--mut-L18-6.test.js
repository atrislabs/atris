'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { printCliJson } = require('../lib/cli-json');

test('printCliJson propagates a non-retryable stdout error without printing JSON', () => {
  const originalWrite = fs.writeSync;
  const originalWait = Atomics.wait;
  const failure = Object.assign(new Error('stdout write failed'), { code: 'EIO' });
  let firstWrite = true;
  let output = '';
  let caught = null;

  try {
    fs.writeSync = (fd, buffer, offset, length) => {
      if (fd !== process.stdout.fd) {
        return originalWrite(fd, buffer, offset, length);
      }
      if (firstWrite) {
        firstWrite = false;
        throw failure;
      }
      output += buffer.subarray(offset, offset + length).toString('utf8');
      return length;
    };
    // An incorrect retry must finish immediately and expose its printed output.
    Atomics.wait = () => 'ok';
    try {
      printCliJson({ full: true }, { ok: true });
    } catch (error) {
      caught = error;
    }
  } finally {
    fs.writeSync = originalWrite;
    Atomics.wait = originalWait;
  }

  assert.equal(output, '');
  assert.equal(caught, failure);
});
