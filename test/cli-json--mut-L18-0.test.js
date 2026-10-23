'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { compactSuccessPayload, printCliJson } = require('../lib/cli-json');

// With no print argument, printCliJson writes to stdout through fs.writeSync.
// That path retries an EAGAIN error and rethrows any other error.
// These tests swap fs.writeSync for a fake, so no real stdout is touched.

function withFakeWriteSync(fake, body) {
  const original = fs.writeSync;
  fs.writeSync = fake;
  try {
    body();
  } finally {
    fs.writeSync = original;
  }
}

function errorWithCode(code) {
  const err = new Error(`fake ${code}`);
  err.code = code;
  return err;
}

test('stdout writer retries an EAGAIN write and prints the whole body', () => {
  const calls = [];
  const written = [];
  const body = compactSuccessPayload({ action: 'claimed', ids: { task: 'T1' } });
  withFakeWriteSync((fd, buffer, offset, length) => {
    calls.push(fd);
    if (calls.length === 1) throw errorWithCode('EAGAIN');
    written.push(buffer.subarray(offset, offset + length).toString('utf8'));
    return length;
  }, () => {
    assert.doesNotThrow(() => printCliJson(body, body, []));
  });
  assert.equal(calls.length, 2);
  assert.equal(written.join(''), `${JSON.stringify(body, null, 2)}\n`);
});

test('stdout writer rethrows a non-EAGAIN write error instead of retrying', () => {
  const calls = [];
  const body = { ok: true };
  withFakeWriteSync((fd, buffer, offset, length) => {
    calls.push(fd);
    if (calls.length === 1) throw errorWithCode('EPIPE');
    return length;
  }, () => {
    assert.throws(() => printCliJson(body, body, []), { code: 'EPIPE' });
  });
  assert.equal(calls.length, 1);
});
