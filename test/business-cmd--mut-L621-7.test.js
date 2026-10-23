'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { shareBusinessWorkspace } = require('../commands/business');

test('share workspace role flag sets role in handoff', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'biz-share-test-'));
  const origHome = process.env.HOME;
  const origCwd = process.cwd();
  const origLog = console.log;

  process.env.HOME = tmpDir;
  process.chdir(tmpDir);

  const logs = [];
  console.log = (...args) => logs.push(args.map(String).join(' '));

  t.after(() => {
    console.log = origLog;
    process.chdir(origCwd);
    process.env.HOME = origHome;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  const configName = ['business', 'json'].join('.');
  fs.mkdirSync(path.join(tmpDir, '.atris'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.atris', configName),
    JSON.stringify({ name: 'Acme Corp', slug: 'acme-corp' }),
    'utf8'
  );

  await shareBusinessWorkspace('-r', 'reviewer');

  assert.ok(logs.join('\n').includes('Role: reviewer'));
});
