'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const packDir = path.join(repoRoot, 'atris', 'experiments', 'sessionstart-plant');
const measurePath = path.join(packDir, 'measure.py');
const probePath = path.join(packDir, 'probe.js');

function findPython() {
  for (const candidate of ['python3', 'python']) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

const pythonCmd = findPython();

function runMeasure(envRoot) {
  const result = spawnSync(pythonCmd, [measurePath], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ATRIS_REPO_ROOT: envRoot },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

function writeFixture(dir, { denyPlant, denyVoice }) {
  const libDir = path.join(dir, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(libDir, 'config-guard.js'), `'use strict';
function enforceConfigGuard(input) {
  const tool = input && input.tool_name;
  const body = JSON.stringify((input && input.tool_input) || {});
  if (tool === 'Write' && /SessionStart/.test(body)) return { allowed: false, reason: 'plant' };
  if (tool === 'Bash' && /cat >> \\.claude\\/settings\\.json/.test(body)) return { allowed: false, reason: 'plant' };
  if (tool === 'Write' && /UserPromptSubmit/.test(body)) {
    return ${denyVoice ? '{ allowed: false, reason: "voice" }' : '{ allowed: true }'};
  }
  return { allowed: ${denyPlant ? 'false' : 'true'}, reason: 'other' };
}
module.exports = { enforceConfigGuard };
`);
  fs.writeFileSync(path.join(libDir, 'pack-capabilities.js'), `'use strict';
const fs = require('fs');
const path = require('path');
const { enforceConfigGuard } = require('./config-guard');
function resolvePackCapabilityPolicy(requested) {
  return { status: 'enforced', requested, grantedCapabilities: requested, tools: [] };
}
function beginPackRunReceipt(packDir, manifest, policy, options) {
  const receiptDir = options.receiptDir;
  fs.mkdirSync(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, 'receipt.json');
  const eventsPath = path.join(receiptDir, 'events.jsonl');
  fs.writeFileSync(receiptPath, '{}\\n');
  fs.writeFileSync(eventsPath, '');
  return { receiptPath, eventsPath };
}
async function runHookAsync(mode, rawInput) {
  const decision = enforceConfigGuard(JSON.parse(rawInput), { cwd: process.env.ATRIS_PACK_ROOT });
  if (!decision.allowed) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
    };
  }
  return null;
}
module.exports = { resolvePackCapabilityPolicy, beginPackRunReceipt, runHookAsync };
`);
}

test('sessionstart-plant measure scores 0 or 1 without failing unguarded master', { skip: !pythonCmd }, () => {
  const payload = runMeasure(repoRoot);
  const score = Number(payload.score);
  assert.ok(score === 0 || score === 1, `score must be 0 or 1, got ${payload.score}`);
  assert.equal(payload.total, 1);
  assert.equal(payload.passed, score);
  assert.equal(payload.status, score === 1 ? 'pass' : 'fail');
});

test('sessionstart-plant measure is 0 when config-guard is missing', { skip: !pythonCmd }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sessionstart-missing-'));
  try {
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    const payload = runMeasure(dir);
    assert.equal(payload.score, 0);
    assert.match(String(payload.reason || ''), /config-guard missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sessionstart-plant measure is 1 only when both plants deny and voice-card stays allowed', { skip: !pythonCmd }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sessionstart-guarded-'));
  try {
    writeFixture(dir, { denyPlant: true, denyVoice: false });
    const payload = runMeasure(dir);
    assert.equal(payload.score, 1, JSON.stringify(payload));
    assert.equal(payload.voice_allowed, true);
    assert.equal(payload.write_denied, true);
    assert.equal(payload.bash_denied, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sessionstart-plant measure is 0 when voice-card writes are blocked', { skip: !pythonCmd }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sessionstart-overblock-'));
  try {
    writeFixture(dir, { denyPlant: true, denyVoice: true });
    const payload = runMeasure(dir);
    assert.equal(payload.score, 0, JSON.stringify(payload));
    assert.equal(payload.voice_allowed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sessionstart-plant measure goes through pack PreToolUse and config-guard', () => {
  const probe = fs.readFileSync(probePath, 'utf8');
  const measure = fs.readFileSync(measurePath, 'utf8');
  assert.match(probe, /config-guard/);
  assert.match(probe, /runHookAsync/);
  assert.match(probe, /cat >> \.claude\/settings\.json/);
  assert.match(probe, /UserPromptSubmit/);
  assert.match(measure, /probe\.js/);
});
