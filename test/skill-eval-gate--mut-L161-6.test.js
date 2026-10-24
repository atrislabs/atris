'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SKILL_EVAL_SCHEMA, appendSkillEvalReceipt, skillEvalGate } = require('../lib/skill-eval-gate');

test('a passing receipt without rubric scores cannot approve a changed skill', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-empty-rubric-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const initialized = spawnSync('git', ['init', '-b', 'master'], { cwd: root, encoding: 'utf8' });
    if (initialized.status !== 0) throw new Error(initialized.stderr);
    const skillPath = 'atris/skills/example/SKILL.md';
    const file = path.join(root, skillPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# Example\n\nFollow the instructions.\n');
    fs.utimesSync(file, new Date('2026-08-26T12:00:00.000Z'), new Date('2026-08-26T12:00:00.000Z'));
    appendSkillEvalReceipt(root, {
      schema: SKILL_EVAL_SCHEMA,
      ts: '2026-08-26T12:00:01.000Z',
      source: 'skill_eval',
      skill_path: skillPath,
      worker_model: 'codex',
      judge_identity: 'claude',
      passed: true,
      rubric_scores: {},
    });
    const result = skillEvalGate(root);
    assert.equal(result.ok, false);
    assert.match(result.missing[0].reason, /rubric/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
