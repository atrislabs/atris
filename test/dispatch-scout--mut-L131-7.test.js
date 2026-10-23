'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { seedScoutContext } = require('../lib/dispatch-scout');

test('seedScoutContext prioritizes higher scored files over alphabetical ordering', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-scout-seed-'));
  try {
    fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '# map\n');
    fs.writeFileSync(path.join(root, 'lib', 'z-high.js'), '// empty\n');
    fs.writeFileSync(path.join(root, 'lib', 'a-low.js'), '// contains lookup_term\n');

    spawnSync('git', ['-C', root, 'init', '-q']);
    spawnSync('git', ['-C', root, 'config', 'user.name', 'Tester']);
    spawnSync('git', ['-C', root, 'config', 'user.email', 'tester@example.com']);
    spawnSync('git', ['-C', root, 'add', '.']);
    spawnSync('git', ['-C', root, 'commit', '-qm', 'fixture']);

    const seed = seedScoutContext({
      task: { title: 'Fix z-high and lookup_term' },
      worktreePath: root,
    });

    assert.deepEqual(seed.allowedFiles, ['lib/z-high.js', 'lib/a-low.js', 'atris/MAP.md']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
