'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

module.exports = {
  id: 'experiments-smoke-keep-revert',
  title: 'Tiny experiment pack keeps improvements and restores regressions',
  timeoutMs: 30000,
  needsPython: true,
  async run(ctx) {
    const python = ctx.requireCmd('python3');
    const packDir = path.join(ctx.workspace, 'atris', 'experiments', 'bench-smoke-keep-revert');
    fs.mkdirSync(packDir, { recursive: true });
    fs.copyFileSync(
      path.join(ctx.repoRoot, 'atris', 'experiments', 'kernel-prompt-discipline', 'loop.py'),
      path.join(packDir, 'loop.py'),
    );
    fs.writeFileSync(path.join(packDir, 'system_prompt.txt'), 'guard discipline\n', 'utf8');
    fs.writeFileSync(path.join(packDir, 'measure.py'), [
      'import json',
      'from pathlib import Path',
      'text = Path("system_prompt.txt").read_text()',
      'score = 0',
      'score += 1 if "guard" in text else 0',
      'score += 1 if "discipline" in text else 0',
      'score += 2 if "keep-marker" in text else 0',
      'score -= 1 if "revert-marker" in text else 0',
      'print(json.dumps({"score": score, "spine_coverage": score, "words": len(text.split())}))',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(packDir, 'proposal_keep.py'), [
      'import os',
      'from pathlib import Path',
      'target = Path(os.environ["EXPERIMENT_TARGET"])',
      'target.write_text(target.read_text() + "keep-marker\\n")',
      'print("added keep marker")',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(packDir, 'proposal_revert.py'), [
      'import os',
      'from pathlib import Path',
      'target = Path(os.environ["EXPERIMENT_TARGET"])',
      'target.write_text("revert-marker\\n")',
      'print("added revert marker")',
      '',
    ].join('\n'), 'utf8');

    const result = spawnSync(python, [
      path.join(packDir, 'loop.py'),
      '--proposal', path.join(packDir, 'proposal_keep.py'),
      '--proposal', path.join(packDir, 'proposal_revert.py'),
    ], {
      cwd: packDir,
      encoding: 'utf8',
      timeout: 20000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const rows = fs.readFileSync(path.join(packDir, 'results.tsv'), 'utf8').trim().split(/\r?\n/);
    const statuses = rows.slice(1).map((line) => line.split('\t')[2]);
    assert.deepEqual(statuses, ['kept', 'reverted']);
    const target = fs.readFileSync(path.join(packDir, 'system_prompt.txt'), 'utf8');
    assert.ok(target.includes('keep-marker'));
    assert.ok(!target.includes('revert-marker'));
    assert.equal(fs.readdirSync(packDir).filter((file) => file.endsWith('.bak')).length, 0);
  },
};
