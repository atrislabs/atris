'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SKILL_EVAL_SCHEMA, appendSkillEvalReceipt, skillEvalGate } = require('../lib/skill-eval-gate');

test('a passing receipt without rubric scores cannot authorize a changed skill', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-rubric-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
    if (initialized.status !== 0) throw new Error(initialized.stderr || 'could not initialize fixture');
    const skillPath = 'atris/skills/example/SKILL.md';
    const file = path.join(root, skillPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# Example\n\nUse concrete proof.\n');
    const changedAt = new Date('2026-01-01T00:00:00.000Z');
    fs.utimesSync(file, changedAt, changedAt);
    appendSkillEvalReceipt(root, {
      schema: SKILL_EVAL_SCHEMA,
      ts: '2026-01-02T00:00:00.000Z',
      source: 'skill_eval',
      skill_path: skillPath,
      worker_model: 'codex',
      judge_identity: 'claude',
      passed: true,
      rubric_scores: null,
    });
    assert.equal(skillEvalGate(root).ok, false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
