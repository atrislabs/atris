const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'outbound-artifact-gate.js');

function runGate(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-gate-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

test('fails plain email bodies that contain raw HTML', () => {
  const res = runGate(['--channel', 'email', '--format', 'plain', '--body', '<div>Justin, here is the update.</div>']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /raw-html-in-plain-body/);
});

test('fails HTML sends without render proof', () => {
  const res = runGate(['--channel', 'email', '--format', 'html', '--body', '<p>Rendered update</p>']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /render-proof-missing/);
});

test('passes HTML sends with render proof', () => {
  const proof = tmpFile('render-proof.txt', 'Rendered email preview checked.');
  const res = runGate(['--channel', 'email', '--format', 'html', '--body', '<p>Rendered update</p>', '--proof-file', proof]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /passed/);
});

test('fails outbound copy that trips the anti-slop gate', () => {
  const res = runGate(['--channel', 'email', '--format', 'plain', '--body', 'This robust workflow will seamlessly leverage our platform.']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /copy-slop/);
});

test('passes clean plain-text outbound copy', () => {
  const body = 'Justin, here is the move.\nAgent Grads should find hiring companies, match new grads, and record proof.';
  const res = runGate(['--channel', 'email', '--format', 'plain', '--body', body]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /passed/);
});
