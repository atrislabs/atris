'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const auth = require('../utils/auth');

for (const kind of ['credentials', 'profile']) {
  test(`${kind} save preserves old login after a partial write failure`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-auth-save-'));
    t.mock.method(os, 'homedir', () => dir);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const save = kind === 'credentials'
      ? (token) => auth.saveCredentials(token, 'test-refresh', null, null, null)
      : (token) => auth.saveProfile('test-user', { token });
    save('old-test-token');
    const target = kind === 'credentials'
      ? auth.getCredentialsPath()
      : path.join(auth.getAtrisDir(), 'profiles', 'test-user.json');
    const old = fs.readFileSync(target, 'utf8');
    const write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (file, data, options) => {
      const name = String(file);
      if (name === target || (path.dirname(name) === path.dirname(target) && path.basename(name).includes(path.basename(target)))) {
        write(file, '{', options);
        const err = new Error('synthetic partial write');
        err.code = 'EIO';
        throw err;
      }
      return write(file, data, options);
    });
    assert.throws(() => save('new-test-token'), /synthetic partial write/);
    assert.equal(fs.readFileSync(target, 'utf8'), old);
  });

  test(`${kind} save preserves the old login if rename fails`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-auth-rename-'));
    t.mock.method(os, 'homedir', () => dir);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const save = kind === 'credentials'
      ? (token) => auth.saveCredentials(token, 'test-refresh', null, null, null)
      : (token) => auth.saveProfile('test-user', { token });
    save('old-test-token');
    const target = kind === 'credentials'
      ? auth.getCredentialsPath()
      : path.join(auth.getAtrisDir(), 'profiles', 'test-user.json');
    const old = fs.readFileSync(target, 'utf8');
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (String(to) === target) throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' });
      return rename(from, to);
    });
    assert.throws(() => save('new-test-token'), /synthetic rename failure/);
    assert.equal(fs.readFileSync(target, 'utf8'), old);
    assert.deepEqual(fs.readdirSync(path.dirname(target)).filter(name => name.endsWith('.tmp')), []);
  });

  test(`${kind} save refuses a symbolic link without modifying its target`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-auth-link-'));
    t.mock.method(os, 'homedir', () => dir);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const target = kind === 'credentials'
      ? auth.getCredentialsPath()
      : path.join(auth.getAtrisDir(), 'profiles', 'test-user.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const linkTarget = path.join(dir, 'other.json');
    fs.writeFileSync(linkTarget, 'test original');
    fs.symlinkSync(linkTarget, target);
    const save = kind === 'credentials'
      ? () => auth.saveCredentials('new-test-token', 'test-refresh', null, null, null)
      : () => auth.saveProfile('test-user', { token: 'new-test-token' });
    assert.throws(save, /not a regular file/);
    assert.equal(fs.readFileSync(linkTarget, 'utf8'), 'test original');
    assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  });
}
