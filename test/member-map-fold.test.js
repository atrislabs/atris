'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  NOTES_FILE, DROP_DIR, foldDue, foldNotesText, foldMapNotesOnMain,
} = require('../lib/member-map-fold');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

// A shared repo on disk plus one working copy, the way a member sees it.
function sharedRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'map-fold-'));
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  git(dir, 'init', '-q', '--bare', '-b', 'master', origin);
  git(dir, 'clone', '-q', origin, work);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'test');
  return { dir, origin, work };
}

test('foldDue: due with no record, not again inside the hour, due after it', () => {
  const now = Date.parse('2026-10-15T03:00:00Z');
  assert.equal(foldDue(null, now), true);
  assert.equal(foldDue('2026-10-15T02:30:00Z', now), false);
  assert.equal(foldDue('2026-10-15T02:00:00Z', now), true);
});

test('foldNotesText: notes under a known heading join that section, new sections go last', () => {
  const notes = '# Notes\n\n## Alpha\nrg "a" lib/a.js\n\n## Beta\nrg "b" lib/b.js\n';
  const { text, added } = foldNotesText(notes, [
    { text: '## Alpha\nrg "a" lib/a.js\nrg "a2" lib/a2.js\n' },
    { text: '## Gamma\nrg "g" lib/g.js\n' },
    { text: '## Beta\nrg "b" lib/b.js\n' },
    { text: '   \n' },
  ]);
  assert.equal(text, '# Notes\n\n## Alpha\nrg "a" lib/a.js\nrg "a2" lib/a2.js\n\n## Beta\nrg "b" lib/b.js\n\n## Gamma\nrg "g" lib/g.js\n');
  assert.equal(added, 3);
});

test('foldNotesText: a new section already present word for word is not added twice', () => {
  const notes = '## Alpha\nrg "a" lib/a.js\n';
  const { text, added } = foldNotesText(notes, [{ text: '\nrg "a" lib/a.js\n' }]);
  assert.equal(text, notes);
  assert.equal(added, 0);
});

test('foldMapNotesOnMain: notes saved by two member changes land in the shared map on main in one commit', () => {
  const { origin, work } = sharedRepo();
  write(work, NOTES_FILE, '# Map notes\n\n## Alpha\nrg "a" lib/a.js\n');
  write(work, 'README.md', 'hi\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', 'origin', 'master');

  // Two member changes each save their own note file; neither touches MAP-NOTES.md.
  write(work, `${DROP_DIR}/builder-one.md`, '## Alpha\nrg "a2" lib/a2.js\n');
  write(work, `${DROP_DIR}/scout-two.md`, '## Fresh area\nrg "f" lib/f.js # new thing\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'two member changes');
  git(work, 'push', '-q', 'origin', 'master');
  const before = git(origin, 'rev-parse', 'master');
  const checkoutHead = git(work, 'rev-parse', 'HEAD');

  const result = foldMapNotesOnMain(work);
  assert.equal(result.pushed, true, JSON.stringify(result));
  assert.equal(result.folded, 2);
  assert.equal(result.added, 3, "one line into Alpha, plus the new heading and its line");

  const after = git(origin, 'rev-parse', 'master');
  assert.notEqual(after, before);
  assert.equal(git(origin, 'rev-parse', 'master^'), before, 'fold sits on top of main, nothing rewritten');
  assert.equal(
    git(origin, 'show', `master:${NOTES_FILE}`),
    '# Map notes\n\n## Alpha\nrg "a" lib/a.js\nrg "a2" lib/a2.js\n\n## Fresh area\nrg "f" lib/f.js # new thing',
  );
  assert.equal(git(origin, 'ls-tree', '-r', '--name-only', 'master', '--', `${DROP_DIR}/`), '', 'saved note files are removed');
  assert.match(git(origin, 'log', '-1', '--format=%s', 'master'), /^Fold 2 map notes from member changes/);
  // The member's own checkout was never moved or rewritten.
  assert.equal(git(work, 'rev-parse', 'HEAD'), checkoutHead);
  assert.ok(fs.existsSync(path.join(work, DROP_DIR, 'builder-one.md')));

  // The next hour has nothing to fold and makes no commit.
  const again = foldMapNotesOnMain(work);
  assert.equal(again.folded, 0);
  assert.equal(again.reason, 'nothing_to_fold');
  assert.equal(git(origin, 'rev-parse', 'master'), after);
});

test('foldMapNotesOnMain: an unreachable main is reported, not thrown', () => {
  const { work } = sharedRepo();
  git(work, 'remote', 'set-url', 'origin', path.join(os.tmpdir(), 'no-such-origin-for-map-fold.git'));
  const result = foldMapNotesOnMain(work, { base: 'master' });
  assert.equal(result.folded, 0);
  assert.equal(result.reason, 'main_unreadable');
});

test('autoland tick runs the fold at most once an hour with an off switch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'commands', 'autoland.js'), 'utf8');
  assert.match(src, /policy\.map_fold !== false/);
  assert.match(src, /foldDue\(state\.last_map_fold_at\)/);
  assert.match(src, /foldMapNotesOnMain\(root\)/);
});
