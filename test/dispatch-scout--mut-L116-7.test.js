'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { seedScoutContext } = require('../lib/dispatch-scout');

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function writeFile(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// The map line names the title keywords and points at a file whose path and
// body do not. That file must still be a starting point: the line alone scores it.
test('a map ref scores when its map line has the title keywords, even if its path does not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-scout-mut-L116-7-'));
  try {
    writeFile(root, 'atris/MAP.md', '# Map\n- Cache flush runs in `lib/relay-engine.js:40`.\n');
    writeFile(root, 'lib/relay-engine.js', 'module.exports = { relay: 1 };\n');
    git(root, ['init', '-q']);
    git(root, ['add', '-A']);

    const seed = seedScoutContext({
      task: { task_id: 'T-1', title: 'Repair quokka cache flush' },
      worktreePath: root,
    });

    assert.deepEqual(seed.allowedFiles, ['lib/relay-engine.js', 'atris/MAP.md']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
