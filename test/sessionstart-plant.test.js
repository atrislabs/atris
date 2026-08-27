'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

test('sessionstart-plant measure scores 0 or 1 without failing unguarded master', { skip: !pythonCmd }, () => {
  const result = spawnSync(pythonCmd, [measurePath], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ATRIS_REPO_ROOT: repoRoot },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.trim().split('\n').pop();
  const payload = JSON.parse(line);
  const score = Number(payload.score);
  assert.ok(score === 0 || score === 1, `score must be 0 or 1, got ${payload.score}`);
  assert.equal(payload.total, 1);
  assert.equal(payload.passed, score);
  assert.equal(payload.status, score === 1 ? 'pass' : 'fail');
});

test('sessionstart-plant measure goes through pack PreToolUse and config-guard', () => {
  const probe = fs.readFileSync(probePath, 'utf8');
  const measure = fs.readFileSync(measurePath, 'utf8');
  assert.match(probe, /config-guard/);
  assert.match(probe, /runHookAsync/);
  assert.match(probe, /cat >> \.claude\/settings\.json/);
  assert.match(probe, /UserPromptSubmit/);
  assert.match(measure, /probe\.js/);
  assert.doesNotMatch(probe, /score:\s*1,\s*reason:\s*'rewrote'/);
});
