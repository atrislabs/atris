'use strict';

// The boot map is a short routing table; the deep file:line refs live in
// atris/refs/MAP-NOTES.md. Each tool that looks up refs in the map must also
// find a ref that exists only in the notes file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectSearchResults } = require('../commands/search');
const { healBrokenMapRefs } = require('../commands/clean');
const { checkMapForFiles } = require('../commands/verify');

const NOTES = 'atris/refs/MAP-NOTES.md';

function workspace(t, notes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-map-notes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'atris', 'refs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), '# short map\n\n| Task | Primary path |\n| --- | --- |\n');
  fs.writeFileSync(path.join(root, NOTES), notes);
  return root;
}

test('search finds a ref that only the notes file has', t => {
  const root = workspace(t, '# notes\n\n- zebraflow lives at `lib/zebra.js:3`\n');
  const { layers } = collectSearchResults(root, 'zebraflow');
  assert.deepEqual(layers.map.lineHits.map(hit => [hit.file, hit.line]), [[NOTES, 3]]);
});

test('atris clean heals a drifted ref that only the notes file has and names the file for the rest', t => {
  const notes = [
    '# notes',
    '- `lib/sample.js:9` (`fooBar`) moved up.',
    '- `lib/gone.js:4` (`nothing`) was deleted.',
    '',
  ].join('\n');
  const root = workspace(t, notes);
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib', 'sample.js'), '// header\n// more\nfunction fooBar() {\n  return 1;\n}\n');
  const result = healBrokenMapRefs(root, path.join(root, 'atris'), false);
  assert.equal(result.healed, 1);
  assert.deepEqual(result.replacements.map(r => [r.map, r.old, r.new]), [[NOTES, '`lib/sample.js:9`', '`lib/sample.js:3`']]);
  assert.deepEqual(result.unhealable.map(r => [r.map, r.file, r.reason]), [[NOTES, 'lib/gone.js', 'File not found']]);
  assert.match(fs.readFileSync(path.join(root, NOTES), 'utf8'), /`lib\/sample\.js:3` \(`fooBar`\)/);
  assert.equal(fs.readFileSync(path.join(root, 'atris', 'MAP.md'), 'utf8').includes('sample'), false);
});

test('verify counts a file named only in the notes file as documented', t => {
  const root = workspace(t, '# notes\n\n- `lib/zebra.js:3` handles zebraflow.\n');
  const atrisDir = path.join(root, 'atris');
  assert.deepEqual(checkMapForFiles(atrisDir, [{ type: 'file', file: 'lib/zebra.js' }]), { documented: true });
  fs.rmSync(path.join(root, NOTES));
  assert.deepEqual(checkMapForFiles(atrisDir, [{ type: 'file', file: 'lib/zebra.js' }]), { documented: false });
});

// Readers that hand agents context: with a notes file present, each points at it
// or includes it; without one, nothing names a missing file.

test('workflow plan and do prompts send line lookups to the notes file', t => {
  const { mapPromptSection } = require('../commands/workflow');
  const root = workspace(t, '# notes\n');
  const section = mapPromptSection(path.join(root, 'atris'), root);
  assert.match(section, /## MAP\.md\nRead this file to find where work lives: atris\/MAP\.md/);
  assert.match(section, /## MAP-NOTES\.md\nRead this file for exact file:line references: atris\/refs\/MAP-NOTES\.md/);
  fs.rmSync(path.join(root, NOTES));
  assert.doesNotMatch(mapPromptSection(path.join(root, 'atris'), root), /MAP-NOTES/);
});

test('autopilot phase prompts list the notes file beside the map', t => {
  const { buildPrompt } = require('../commands/autopilot');
  const root = workspace(t, '# notes\n');
  const original = process.cwd();
  t.after(() => process.chdir(original));
  process.chdir(root);
  assert.match(buildPrompt('do', { task: 'fix something small', kind: 'task' }), /- atris\/MAP\.md\n- atris\/refs\/MAP-NOTES\.md\n/);
  fs.rmSync(path.join(root, NOTES));
  assert.doesNotMatch(buildPrompt('do', { task: 'fix something small', kind: 'task' }), /MAP-NOTES/);
});

test('atris run phase prompts list the notes file beside the map', () => {
  const { buildRunPrompt } = require('../commands/run');
  const base = { mapPath: 'atris/MAP.md', todoPath: 'atris/TODO.md', personaPath: null, lessonsPath: null, journalPath: null };
  assert.match(buildRunPrompt('plan', { ...base, notesPath: NOTES }, null), /- atris\/MAP\.md\n- atris\/refs\/MAP-NOTES\.md\n/);
  assert.doesNotMatch(buildRunPrompt('plan', { ...base, notesPath: null }, null), /MAP-NOTES/);
});

test('unknowns territory context carries the head of the notes file', t => {
  const { gatherTerritoryContext } = require('../commands/unknowns');
  const root = workspace(t, '# notes\n\n- zebraflow lives at `lib/zebra.js:3`\n');
  const context = gatherTerritoryContext(root, null);
  assert.match(context, /atris\/refs\/MAP-NOTES\.md first 100 lines/);
  assert.match(context, /zebraflow lives at `lib\/zebra\.js:3`/);
});

test('visualize context carries notes lines that share a word with the prompt', t => {
  const { collectWorkspaceContext } = require('../commands/visualize');
  const root = workspace(t, '# notes\n\n- zebraflow lives at `lib/zebra.js:3`\n- unrelated line\n');
  const context = collectWorkspaceContext('draw the zebraflow pipeline', root);
  assert.match(context, /MAP notes excerpt:\n- zebraflow lives at `lib\/zebra\.js:3`/);
  assert.doesNotMatch(context, /unrelated line/);
});

test('fleet build briefs point at the notes file only when the worktree has one', t => {
  const { buildFleetPrompt } = require('../lib/fleet');
  const root = workspace(t, '# notes\n');
  const task = { display_id: 'CLI-1', title: 'Ship the fix. Done: behavior is covered.' };
  assert.match(buildFleetPrompt(task, { worktreePath: root }), /then atris\/refs\/MAP-NOTES\.md for exact file:line refs/);
  fs.rmSync(path.join(root, NOTES));
  assert.doesNotMatch(buildFleetPrompt(task, { worktreePath: root }), /MAP-NOTES/);
});

test('the repo map load order marks generated local files as if present', () => {
  const repo = path.join(__dirname, '..');
  const map = fs.readFileSync(path.join(repo, 'atris', 'MAP.md'), 'utf8');
  const order = map.slice(map.indexOf('## Load order'));
  for (const line of order.split('\n').filter(l => /^\d+\. /.test(l))) {
    for (const [, file] of line.matchAll(/`([^`]+\.md)`/g)) {
      if (fs.existsSync(path.join(repo, file)) && !isIgnored(repo, file)) continue;
      assert.match(line, /if present/, `${file} is local-only, so its load-order line must say "if present": ${line}`);
    }
  }
});

function isIgnored(repo, file) {
  const { spawnSync } = require('node:child_process');
  return spawnSync('git', ['-C', repo, 'check-ignore', '-q', file]).status === 0;
}
