const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Standing lesson (burned us twice): stale MAP.md file:line refs.
// atris/MAP.md routes and atris/refs/MAP-NOTES.md holds the exact lines, so
// agents jump straight to file:line.
// When code moves and a ref is not updated, the agent lands on the wrong line
// or a deleted file, silently. This turns that drift into a loud test failure.

const { MAP_REF_DOCS } = require('../lib/map-refs');

const repoRoot = path.join(__dirname, '..');
const mapPath = path.join(repoRoot, 'atris', 'MAP.md');
// The boot map routes; exact file:line refs live in the notes file it points to.
const refText = () => MAP_REF_DOCS
  .filter(doc => fs.existsSync(path.join(repoRoot, doc)))
  .map(doc => fs.readFileSync(path.join(repoRoot, doc), 'utf8'))
  .join('\n');

// Only validate refs into source dirs that live in this repo. This avoids
// treating prose like "3.18.2" or external paths as code refs.
const REF_RE = /\b((?:bin|lib|commands|test|scripts|templates)\/[A-Za-z0-9_./-]+\.js):(\d+)\b/g;

function collectRefs(text) {
  const refs = [];
  let m;
  while ((m = REF_RE.exec(text)) !== null) {
    refs.push({ file: m[1], line: Number(m[2]), raw: `${m[1]}:${m[2]}` });
  }
  return refs;
}

test('atris/MAP.md exists', () => {
  assert.ok(fs.existsSync(mapPath), 'atris/MAP.md must exist as the navigation brain');
});

test('every file:line ref in the map files points to a real file', () => {
  const text = refText();
  const refs = collectRefs(text);
  assert.ok(refs.length > 0, 'expected the map files to contain file:line navigation refs');

  const missing = [];
  for (const ref of refs) {
    if (!fs.existsSync(path.join(repoRoot, ref.file))) missing.push(ref.raw);
  }
  assert.deepEqual(
    missing,
    [],
    `MAP.md references files that no longer exist (update or remove these refs):\n  ${missing.join('\n  ')}`
  );
});

test('every file:line ref in the map files points to an in-range line', () => {
  const text = refText();
  const refs = collectRefs(text);

  const lineCounts = new Map();
  const outOfRange = [];
  for (const ref of refs) {
    const abs = path.join(repoRoot, ref.file);
    if (!fs.existsSync(abs)) continue; // covered by the existence test above
    let total = lineCounts.get(ref.file);
    if (total === undefined) {
      total = fs.readFileSync(abs, 'utf8').split('\n').length;
      lineCounts.set(ref.file, total);
    }
    if (ref.line < 1 || ref.line > total) {
      outOfRange.push(`${ref.raw} (file has ${total} lines)`);
    }
  }
  assert.deepEqual(
    outOfRange,
    [],
    `MAP.md references line numbers past the end of the file (code moved, ref is stale):\n  ${outOfRange.join('\n  ')}`
  );
});
