'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const auth = require('../utils/auth');

test('a failed chmod on a saved profile warns once on stderr with the file path', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-chmod-warn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => dir);
  const realChmod = fs.chmodSync;
  t.mock.method(fs, 'chmodSync', (target, mode) => {
    if (String(target).endsWith('.json')) {
      const err = new Error('operation not permitted');
      err.code = 'EPERM';
      throw err;
    }
    return realChmod(target, mode);
  });
  const lines = [];
  t.mock.method(console, 'error', (...args) => { lines.push(args.join(' ')); });

  auth.saveProfile('chmod-warn', { token: 'x' });
  auth.saveProfile('chmod-warn', { token: 'y' });

  const profilePath = path.join(dir, '.atris', 'profiles', 'chmod-warn.json');
  const warnings = lines.filter(line => line.includes(profilePath));
  assert.equal(warnings.length, 1, `expected one warning, got: ${JSON.stringify(lines)}`);
  assert.match(warnings[0], /other users/);
  assert.equal(JSON.parse(fs.readFileSync(profilePath, 'utf8')).token, 'y');
});
