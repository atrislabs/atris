'use strict';

// Two changes that both move code must land one after the other with no hand
// fixing of the map. The real failure: every ship rewrote moved map line refs,
// so two branches that both shifted the same file wrote different numbers on
// the same map line (open pull request 1844 held `bin/atris.js:1151-1162`
// (`showLoopHelp`) while main held `bin/atris.js:1167-1178`), and the second
// one could not merge. These tests run ship's real refresh step in two
// branches of a temp git repo, then merge both into main in order.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { refreshMovedMapRefs } = require('../commands/worktree');
const { checkMapDocs } = require('../lib/map-refs');

function git(dir, args) {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function ok(dir, args) {
  const result = git(dir, args);
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function quiet(fn) {
  const original = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = original; }
}

const TOOL = [
  "'use strict';",
  '',
  'function alphaTool() {',
  '  return 1;',
  '}',
  '',
  'function showToolHelp() {',
  "  console.log('usage: tool');",
  '}',
  '',
  'module.exports = { alphaTool, showToolHelp };',
  '',
].join('\n');

function seed(dir, mapText) {
  ok(dir, ['init', '-q', '-b', 'main']);
  ok(dir, ['config', 'user.email', 'test@example.com']);
  ok(dir, ['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'atris', 'refs', 'map'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'tool.js'), TOOL);
  fs.writeFileSync(path.join(dir, 'atris', 'MAP.md'), '# map\n\n| task | path |\n|---|---|\n| tool | `lib/tool.js` |\n');
  fs.writeFileSync(path.join(dir, 'atris', 'refs', 'map', 'tools.md'), mapText);
  ok(dir, ['add', '-A']);
  ok(dir, ['commit', '-q', '-m', 'seed']);
}

// Each branch adds code in its own spot of the same file, commits, then runs
// the refresh step ship runs right after the work commit.
function branch(dir, name, edit) {
  ok(dir, ['checkout', '-q', '-b', name, 'main']);
  const file = path.join(dir, 'lib', 'tool.js');
  fs.writeFileSync(file, edit(fs.readFileSync(file, 'utf8')));
  ok(dir, ['commit', '-q', '-am', `${name} adds code`]);
  const refresh = quiet(() => refreshMovedMapRefs(dir));
  ok(dir, ['checkout', '-q', 'main']);
  return refresh;
}

const addAtTop = text => text.replace("'use strict';\n", "'use strict';\n\nconst first = 1;\nconst second = 2;\nconst third = 3;\n");
const addInMiddle = text => text.replace('  return 1;\n}\n', '  return 1;\n}\n\nfunction betaTool() {\n  return 2;\n}\n\nfunction gammaTool() {\n  return 3;\n}\n');

function landBoth(dir) {
  ok(dir, ['merge', '-q', '--no-ff', '-m', 'land a', 'a']);
  const second = git(dir, ['merge', '-q', '--no-ff', '-m', 'land b', 'b']);
  const conflicted = git(dir, ['diff', '--name-only', '--diff-filter=U']).stdout.trim();
  return { status: second.status, conflicted, output: `${second.stdout}${second.stderr}` };
}

test('two branches that both move code in a mapped file land in sequence with no map conflict', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-map-merge-seq-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The map as most area notes are written today: line refs with the name next to them.
  seed(dir, '# tools\n\n- **Entry:** `lib/tool.js:3` (`alphaTool`) returns one.\n- **Help:** `lib/tool.js:7-9` (`showToolHelp`) prints usage.\n');

  const a = branch(dir, 'a', addAtTop);
  const b = branch(dir, 'b', addInMiddle);
  assert.ok(a.refreshed > 0, 'branch a moved the help ref');
  assert.ok(b.refreshed > 0, 'branch b moved the help ref');

  const landed = landBoth(dir);
  assert.equal(landed.conflicted, '', `no file needs hand fixing: ${landed.output}`);
  assert.equal(landed.status, 0, landed.output);

  const note = fs.readFileSync(path.join(dir, 'atris', 'refs', 'map', 'tools.md'), 'utf8');
  assert.match(note, /`lib\/tool\.js` \(`showToolHelp`\) prints usage/);
  const tool = fs.readFileSync(path.join(dir, 'lib', 'tool.js'), 'utf8');
  assert.match(tool, /const third = 3;/);
  assert.match(tool, /function gammaTool\(\)/);

  const check = checkMapDocs(dir);
  assert.deepEqual(check.refs.filter(ref => ref.status !== 'ok').map(ref => ref.raw), []);
  assert.ok(check.refs.some(ref => ref.named && ref.symbol === 'showToolHelp'));
});

test('a map with named refs gets no refresh commit at all, so there is nothing to clash', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-map-merge-seq-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  seed(dir, '# tools\n\n- **Entry:** `lib/tool.js` (`alphaTool`) returns one.\n- **Help:** `lib/tool.js` (`showToolHelp`) prints usage.\n');

  assert.equal(branch(dir, 'a', addAtTop).refreshed, 0);
  assert.equal(branch(dir, 'b', addInMiddle).refreshed, 0);
  assert.equal(ok(dir, ['diff', '--name-only', 'main', 'a', '--', 'atris']), '');
  assert.equal(ok(dir, ['diff', '--name-only', 'main', 'b', '--', 'atris']), '');

  const landed = landBoth(dir);
  assert.equal(landed.status, 0, landed.output);
  assert.equal(landed.conflicted, '');
});

test('a named ref whose function was deleted still fails the map check', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-map-merge-seq-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  seed(dir, '# tools\n\n- `lib/tool.js` (`showToolHelp`) prints usage.\n- `lib/gone.js` (`goneTool`) was removed.\n');
  fs.writeFileSync(path.join(dir, 'lib', 'tool.js'), "'use strict';\n\nfunction alphaTool() {\n  return 1;\n}\n\nmodule.exports = { alphaTool };\n");

  const statuses = checkMapDocs(dir).refs.map(ref => [ref.raw, ref.status]);
  assert.deepEqual(statuses, [['lib/tool.js', 'missing'], ['lib/gone.js', 'missing-file']]);
});
