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
