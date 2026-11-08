'use strict';

// MAP-NOTES.md may be an index over one note per area in atris/refs/map/.
// Every area note keeps its line refs checked and fixed, member notes fold
// into the area that owns their heading, and the split repo itself stays whole.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { existingMapDocs, checkMapDocs } = require('../lib/map-refs');
const { DROP_DIR, foldMapNotesOnMain } = require('../lib/member-map-fold');

const cli = path.resolve(__dirname, '../bin/atris.js');
const repoRoot = path.join(__dirname, '..');

function write(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } }).trim();
}

test('doc-health checks and fix-refs moves a drifted line ref inside an area note', (t) => {
  const root = tempDir(t, 'atris-map-split-');
  write(root, 'atris/atris.md', '');
  const code = Array.from({ length: 30 }, () => '');
  code[2] = 'function alpha() {}';
  code[19] = 'function beta() {';
  write(root, 'lib/sample.js', code.join('\n'));
  write(root, 'atris/MAP.md', '| area | path | note |\n| --- | --- | --- |\n| sample | `lib/sample.js` | code |\n');
  write(root, 'atris/refs/MAP-NOTES.md', '# notes\n\n- Sample code. Open [sample.md](map/sample.md) when you touch it.\n');
  const note = '# Sample\n\n- ok: `lib/sample.js:3` `alpha` sets up.\n- moved: `lib/sample.js:12` `beta` grew downward.\n';
  write(root, 'atris/refs/map/sample.md', note);

  assert.deepEqual(existingMapDocs(root), ['atris/MAP.md', 'atris/refs/MAP-NOTES.md', 'atris/refs/map/sample.md']);
  const refs = checkMapDocs(root);
  assert.equal(refs.moved, 1);
  assert.equal(refs.ok, 1);

  const run = args => spawnSync(process.execPath, [cli, 'doc-health', ...args], {
    cwd: root, encoding: 'utf8', timeout: 15000, env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  const fix = run(['--fix-refs']);
  assert.equal(fix.status, 0, fix.stderr);
  assert.match(fix.stdout, /atris\/refs\/map\/sample\.md line 4: lib\/sample\.js:12 -> lib\/sample\.js:20 \(beta\)/);
  assert.equal(fs.readFileSync(path.join(root, 'atris/refs/map/sample.md'), 'utf8'), note.replace('sample.js:12', 'sample.js:20'));
  assert.match(run(['--fix-refs']).stdout, /map refs: nothing to move\./);
});

test('member notes fold into the area note that owns their heading, others into member notes', (t) => {
  const dir = tempDir(t, 'map-split-fold-');
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  git(dir, 'init', '-q', '--bare', '-b', 'master', origin);
  git(dir, 'clone', '-q', origin, work);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'test');
  const index = '# notes\n\n- Alpha. Open [alpha.md](map/alpha.md) when you touch alpha.\n';
  write(work, 'atris/refs/MAP-NOTES.md', index);
  write(work, 'atris/refs/map/alpha.md', '# Alpha\n\n## Alpha\nrg "a" lib/a.js\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', 'origin', 'master');

  write(work, `${DROP_DIR}/one.md`, '## Alpha\nrg "a2" lib/a2.js\n');
  write(work, `${DROP_DIR}/two.md`, '## Brand new\nrg "n" lib/n.js\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'member changes');
  git(work, 'push', '-q', 'origin', 'master');

  const result = foldMapNotesOnMain(work);
  assert.equal(result.pushed, true, JSON.stringify(result));
  assert.equal(result.folded, 2);
  assert.equal(git(origin, 'show', 'master:atris/refs/map/alpha.md'), '# Alpha\n\n## Alpha\nrg "a" lib/a.js\nrg "a2" lib/a2.js');
  assert.match(git(origin, 'show', 'master:atris/refs/map/member-notes.md'), /^# Member notes[\s\S]*## Brand new\nrg "n" lib\/n\.js$/);
  assert.equal(git(origin, 'show', 'master:atris/refs/MAP-NOTES.md'), index.trim(), 'the index is never grown by a fold');
  assert.equal(git(origin, 'ls-tree', '-r', '--name-only', 'master', '--', `${DROP_DIR}/`), '');
});

test('this repo indexes every area note from MAP-NOTES.md and each note links back', () => {
  const index = fs.readFileSync(path.join(repoRoot, 'atris/refs/MAP-NOTES.md'), 'utf8');
  const notes = existingMapDocs(repoRoot).filter(doc => doc.startsWith('atris/refs/map/'));
  assert.ok(notes.length >= 10, 'expected the deep map to be split into area notes');
  assert.ok(index.split('\n').length <= 45, 'the index fits on one screen');
  for (const doc of notes) {
    assert.ok(index.includes(`(map/${path.basename(doc)})`), `${doc} is linked from the index`);
    assert.match(fs.readFileSync(path.join(repoRoot, doc), 'utf8'), /\[MAP-NOTES\.md\]\(\.\.\/MAP-NOTES\.md\)/, `${doc} links back`);
  }
});
