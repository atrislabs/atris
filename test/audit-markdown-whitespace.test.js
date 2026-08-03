'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'audit-markdown-whitespace.js');

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-md-ws-'));
  return dir;
}

function runScript(dir, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
}

test('clean tree exits 0', () => {
  const dir = makeFixture();
  fs.writeFileSync(path.join(dir, 'ok.md'), '# title\nno trailing whitespace\n');
  const res = runScript(dir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /clean/);
});

test('offending file exits 1 and names the file', () => {
  const dir = makeFixture();
  fs.writeFileSync(path.join(dir, 'bad.md'), '# title  \ntrailing tab\t\n');
  const res = runScript(dir);
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /bad\.md/);
  assert.match(res.stdout, /npm run audit:markdown-whitespace -- --fix/);
});

test('--fix strips trailing whitespace and exits 0', () => {
  const dir = makeFixture();
  const target = path.join(dir, 'bad.md');
  fs.writeFileSync(target, 'a  \nb\t\nc\n');
  const fix = runScript(dir, ['--fix']);
  assert.equal(fix.status, 0, fix.stdout + fix.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), 'a\nb\nc\n');
  const rerun = runScript(dir);
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
});

test('skips node_modules and dot directories', () => {
  const dir = makeFixture();
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep.md'), 'trailing  \n');
  fs.writeFileSync(path.join(dir, '.git', 'x.md'), 'trailing  \n');
  const res = runScript(dir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
});
