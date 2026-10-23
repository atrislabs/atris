'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../lib/site-publish');

test('build reports a missing build script when other scripts exist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-build-script-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'unbuilt-site',
    scripts: { test: 'node --test' },
  }));
  const errors = [];
  await run([dir, '--slug', 'unbuilt-site', '--build'], {
    loadCredentials: () => ({ token: 'test-token' }),
    fetch: async () => { throw new Error('unexpected network request'); },
    log: () => {},
    error: (line) => errors.push(line),
  });
  assert.match(errors.join('\n'), /build script/i);
});
