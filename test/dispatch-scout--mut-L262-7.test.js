'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SCOUT_PACK_SCHEMA, verifyScoutPack, checkoutCommit } = require('../lib/dispatch-scout');

test('an oversized citation cannot supply the second verified hit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-citation-'));
  try {
    const excerpt = Array.from({ length: 100 }, (_, i) => `const value${i} = ${i};`).join('\n');
    fs.writeFileSync(path.join(root, 'large.js'), `${excerpt}\n`);
    fs.writeFileSync(path.join(root, 'small.js'), 'const small = 1;\n');
    const task = { display_id: 'TEST-1', title: 'Inspect the value declarations' };
    const env = { ...process.env, HOME: root, GIT_AUTHOR_DATE: '2025-01-01T12:00:00Z', GIT_COMMITTER_DATE: '2025-01-01T12:00:00Z' };
    for (const args of [
      ['init', '-q'],
      ['add', '.'],
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture'],
    ]) {
      const run = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
      if (run.status !== 0) throw new Error(run.stderr);
    }
    const commit = checkoutCommit(root);
    const result = verifyScoutPack({
      schema: SCOUT_PACK_SCHEMA,
      task_id: task.display_id,
      checkout_commit: commit,
      hits: [
        { path: 'small.js', line: 1, excerpt: 'const small = 1;', why: 'Declares the small value.' },
        { path: 'large.js', line: 1, excerpt, why: 'Declares the other values.' },
      ],
      map_gotchas: [],
      not_checked: [],
    }, { task, worktreePath: root, allowedFiles: ['small.js', 'large.js'], expectedCommit: commit });
    assert.strictEqual(result, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
