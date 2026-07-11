const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'scripts', 'outbound-artifact-gate.js');
const dayLoopVoicePolicy = path.join(__dirname, '..', 'atris', 'policies', 'day-loop-voice.md');

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

test('coach gate rejects internal ids and pressure language', () => {
  const res = runGate([
    '--channel', 'email', '--format', 'plain', '--coach-surface', 'morning',
    '--body', "Friendly reminder: you still haven't finished CLI-932 at /Users/operator/workspace.",
  ]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /coach-internal-language/);
  assert.match(res.stderr, /coach-pressure-language/);
});

test('warm ping needs proof of a fresh human signal', () => {
  const body = 'Devon asked whether the pilot can start Monday.\nI drafted the reply and left it unsent.';
  const missing = runGate([
    '--channel', 'email', '--format', 'plain', '--coach-surface', 'warm-ping', '--body', body,
  ]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /coach-signal-proof-missing/);

  const proof = tmpFile('signal.txt', 'Devon replied at 2026-07-08T09:00:00Z.');
  const passed = runGate([
    '--channel', 'email', '--format', 'plain', '--coach-surface', 'warm-ping',
    '--signal-proof', proof, '--body', body,
  ]);
  assert.equal(passed.status, 0, passed.stderr);
});

test('clean morning coach copy passes without a signal proof', () => {
  const body = 'Maya asked for the security summary.\nSend that before opening a new thread.\nI drafted the reply from approved notes.';
  const res = runGate([
    '--channel', 'email', '--format', 'plain', '--coach-surface', 'morning', '--body', body,
  ]);
  assert.equal(res.status, 0, res.stderr);
});

test('day-loop voice policy owns every approved surface as guidance', () => {
  const policy = fs.readFileSync(dayLoopVoicePolicy, 'utf8');
  assert.match(policy, /^## Morning one-thing$/m);
  assert.match(policy, /^## Evening mirror$/m);
  assert.match(policy, /^## Warm ping$/m);
  assert.match(policy, /^## Correcting a sensing mistake$/m);
  assert.equal((policy.match(/Shape, not template:/g) || []).length, 4);
  assert.doesNotMatch(policy, /—/);
});
