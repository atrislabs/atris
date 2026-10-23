'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveProtect } = require('../lib/campaign-protect');

function temporaryHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-save-protect-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('saveProtect creates campaign directories and writes only the protection fields', (t) => {
  const home = temporaryHome(t);
  const plan = {
    paths: ['judge/questions.json', 'a file with spaces.txt'],
    base_commit: '0123456789abcdef0123456789abcdef01234567',
    ignored: 'not persisted',
  };

  const file = saveProtect(home, 'example-campaign', plan);

  assert.strictEqual(file, path.join(home, 'campaigns', 'example-campaign', 'protect.json'));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), JSON.stringify({
    paths: plan.paths,
    base_commit: plan.base_commit,
  }, null, 2) + '\n');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    paths: plan.paths,
    base_commit: plan.base_commit,
  });
});

test('saveProtect replaces existing contents with an empty protection plan', (t) => {
  const home = temporaryHome(t);
  const file = saveProtect(home, 'example-campaign', {
    paths: ['previous.txt'],
    base_commit: 'previous-commit',
  });

  const replaced = saveProtect(home, 'example-campaign', { paths: [], base_commit: null });

  assert.strictEqual(replaced, file);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{\n  "paths": [],\n  "base_commit": null\n}\n');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    paths: [],
    base_commit: null,
  });
});

test('saveProtect reports a filesystem error when the campaigns directory is blocked', (t) => {
  const home = temporaryHome(t);
  const blocker = path.join(home, 'campaigns');
  fs.writeFileSync(blocker, 'existing file');

  assert.throws(() => saveProtect(home, 'example-campaign', {
    paths: ['judge.json'],
    base_commit: 'fixed-commit',
  }), (error) => error.code === 'ENOTDIR' || error.code === 'EEXIST');
  assert.strictEqual(fs.readFileSync(blocker, 'utf8'), 'existing file');
});
