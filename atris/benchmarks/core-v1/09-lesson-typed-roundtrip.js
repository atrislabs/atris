'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function parseJson(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

module.exports = {
  id: 'lesson-typed-roundtrip',
  title: 'Detector-backed lesson metadata resolves through CLI state',
  timeoutMs: 30000,
  async run(ctx) {
    fs.mkdirSync(path.join(ctx.workspace, 'atris'), { recursive: true });
    const add = ctx.runCli(['lesson', 'add', 'bench-typed', 'fail', 'Detector proves this lesson can retire.']);
    assert.equal(add.status, 0, add.stderr || add.stdout);
    fs.writeFileSync(path.join(ctx.workspace, 'atris', 'lessons.json'), JSON.stringify({
      'bench-typed': {
        detector: 'exit 0',
        status: 'open',
      },
    }, null, 2), 'utf8');

    const resolved = parseJson(ctx.runCli(['lesson', 'resolve', '--json']));
    assert.equal(resolved.action, 'lesson_resolve');
    assert.deepEqual(resolved.resolved, ['bench-typed']);

    const metadata = JSON.parse(fs.readFileSync(path.join(ctx.workspace, 'atris', 'lessons.json'), 'utf8'));
    assert.equal(metadata['bench-typed'].status, 'resolved');
    assert.match(fs.readFileSync(path.join(ctx.workspace, 'atris', 'lessons.md'), 'utf8'), /bench-typed.*\[resolved\]/);
  },
};
