'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { printCliJson } = require('../lib/cli-json');

test('default json print finishes as one compact document', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-json-mut-l14-'));
  const file = path.join(dir, 'out.txt');
  const fd = fs.openSync(file, 'w');
  const previous = process.stdout.fd;
  t.after(() => {
    if (process.stdout.fd !== previous) process.stdout.fd = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  process.stdout.fd = fd;
  const full = { ok: true, everything: [1, 2, 3] };
  const compact = { ok: true, marker: 'stop' };
  let result;
  try {
    result = printCliJson(full, compact, ['--json']);
    fs.fsyncSync(fd);
  } finally {
    process.stdout.fd = previous;
    fs.closeSync(fd);
  }

  assert.deepEqual(result, { ok: true, marker: 'stop' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "ok": true,\n  "marker": "stop"\n}\n');
});
