'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  SKILL_EVAL_SCHEMA,
  appendSkillEvalReceipt,
  skillEvalGate,
} = require('../lib/skill-eval-gate');
const { skillEvalCommand } = require('../commands/skill-eval');
const { repoHygieneGate } = require('../lib/auto-accept-certified');

const SKILL_PATH = 'atris/skills/example/SKILL.md';
const CHANGE_TIME = Date.parse('2026-08-26T12:00:00.000Z');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-skill-gate-'));
  git(root, ['init', '-b', 'master']);
  git(root, ['config', 'user.name', 'Skill Gate']);
  git(root, ['config', 'user.email', 'skill-gate@example.com']);
  fs.mkdirSync(path.join(root, path.dirname(SKILL_PATH)), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, SKILL_PATH), '# Example\n\nFollow the instructions.\n');
  fs.writeFileSync(path.join(root, 'lib', 'plain.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed fixture']);
  return root;
}

function changeSkill(root) {
  const file = path.join(root, SKILL_PATH);
  fs.appendFileSync(file, '\nUse concrete proof.\n');
  const changedAt = new Date(CHANGE_TIME);
  fs.utimesSync(file, changedAt, changedAt);
}

function receipt(overrides = {}) {
  return {
    schema: SKILL_EVAL_SCHEMA,
    ts: new Date(CHANGE_TIME + 1000).toISOString(),
    source: 'skill_eval',
    skill_path: SKILL_PATH,
    worker_model: 'codex',
    judge_identity: 'claude',
    passed: true,
    rubric_scores: {
      instruction_clarity: 4,
      trigger_precision: 4,
      procedural_completeness: 4,
      safety: 4,
      verifiability: 4,
    },
    ...overrides,
  };
}

function withRepo(run) {
  const root = makeRepo();
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

function captureConsole(run) {
  const originalLog = console.log;
  const originalError = console.error;
  const output = [];
  console.log = (value) => output.push(String(value));
  console.error = (value) => output.push(String(value));
  try {
    return { value: run(), output };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function passingJudgeOutput() {
  return JSON.stringify({
    passed: true,
    rubric_scores: receipt().rubric_scores,
    summary: 'the instructions are clear, bounded, safe, and verifiable.',
  });
}

test('SKILL.md diff without receipt is rejected', () => withRepo((root) => {
  changeSkill(root);
  const result = repoHygieneGate(root);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'skill_eval_receipt_required');
  assert.deepEqual(result.offenders, [SKILL_PATH]);
  assert.equal(result.missing[0].reason, 'receipt_missing');
}));

test('stale receipt is rejected', () => withRepo((root) => {
  changeSkill(root);
  appendSkillEvalReceipt(root, receipt({
    ts: new Date(CHANGE_TIME - 1000).toISOString(),
  }));
  const result = skillEvalGate(root);
  assert.equal(result.ok, false);
  assert.equal(result.missing[0].reason, 'stale_receipt');
}));

test('fresh passing receipt from an independent judge passes', () => withRepo((root) => {
  changeSkill(root);
  appendSkillEvalReceipt(root, receipt());
  const result = skillEvalGate(root);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.receipts, [{
    path: SKILL_PATH,
    receipt_ts: new Date(CHANGE_TIME + 1000).toISOString(),
  }]);
}));

test('non-skill diffs are untouched', () => withRepo((root) => {
  fs.appendFileSync(path.join(root, 'lib', 'plain.js'), 'module.exports = 2;\n');
  const result = skillEvalGate(root);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.deepEqual(result.skills, []);
}));

test('receipt planted with judge equal to worker is rejected', () => withRepo((root) => {
  changeSkill(root);
  appendSkillEvalReceipt(root, receipt({ judge_identity: 'codex' }));
  const result = skillEvalGate(root);
  assert.equal(result.ok, false);
  assert.equal(result.missing[0].reason, 'judge_matches_worker');
}));

test('skill eval command uses a neutral directory and writes a passing receipt', () => withRepo((root) => {
  changeSkill(root);
  let reviewDirectory = null;
  const engine = {
    name: 'claude',
    available: () => ({ available: true, reason: 'available' }),
    run: (_prompt, directory) => {
      reviewDirectory = path.basename(directory);
      return { status: 0, stdout: passingJudgeOutput(), stderr: '' };
    },
  };
  const result = captureConsole(() => skillEvalCommand([
    SKILL_PATH,
    '--worker-model', 'codex',
    '--judge', 'claude',
    '--json',
  ], {
    root,
    getEngineAdapter: () => engine,
  }));
  assert.equal(result.value, 0, result.output.join('\n'));
  assert.doesNotMatch(reviewDirectory, /eval|test/i);
  assert.equal(skillEvalGate(root).ok, true);
}));

test('skill eval command fails honestly when no independent engine is available', () => withRepo((root) => {
  changeSkill(root);
  const result = captureConsole(() => skillEvalCommand([
    SKILL_PATH,
    '--worker-model', 'human',
    '--json',
  ], {
    root,
    getEngineAdapter: (name) => ({
      name,
      available: () => ({ available: false, reason: 'not installed' }),
    }),
  }));
  assert.equal(result.value, 2);
  assert.match(result.output.join('\n'), /no independent judge engine is available/);
  assert.equal(skillEvalGate(root).ok, false);
}));
