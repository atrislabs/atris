#!/usr/bin/env node
'use strict';

// Pre-commit note for drifted map pointers. A code edit shifts lines, and the
// refs in atris/MAP.md and atris/refs/MAP-NOTES.md that point into that file
// go stale. Ship fixes moved refs on its own, but a plain commit does not, and
// an unclear ref needs a person. This prints the drifted refs that point into
// staged files (or sit in a staged map doc) and always exits 0: it warns, it
// never blocks a commit.

const { spawnSync } = require('child_process');

const SHOWN = 5;

function stagedFiles(root) {
  const res = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) return [];
  return res.stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

function driftedRefs(root, staged) {
  const { checkMapDocs } = require('../lib/map-refs');
  const touched = new Set(staged);
  return checkMapDocs(root).refs.filter(ref => ref.status !== 'ok'
    && (touched.has(ref.path) || touched.has(ref.doc)));
}

function describe(ref) {
  const where = `${ref.doc} line ${ref.map_line}: ${ref.raw}${ref.symbol ? ` (${ref.symbol})` : ''}`;
  if (ref.status === 'moved') return `${where} moved to line ${ref.line}`;
  if (ref.status === 'ambiguous') return `${where} unclear, found on lines ${(ref.lines || []).join(', ')}`;
  return `${where} gone`;
}

function report(refs) {
  if (!refs.length) return '';
  const count = status => refs.filter(ref => status.includes(ref.status)).length;
  const lines = [
    `note: ${refs.length} map pointer${refs.length === 1 ? '' : 's'} into files you changed drifted `
      + `(${count(['moved'])} moved, ${count(['ambiguous'])} unclear, ${count(['missing', 'missing_file'])} gone):`,
    ...refs.slice(0, SHOWN).map(ref => `  ${describe(ref)}`),
  ];
  if (refs.length > SHOWN) lines.push(`  and ${refs.length - SHOWN} more`);
  lines.push('fix: atris doc-health --fix-refs moves the moved ones; unclear and gone ones need a hand edit.');
  return lines.join('\n');
}

function main() {
  try {
    const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
    if (!root) return;
    const staged = stagedFiles(root);
    if (!staged.length) return;
    const text = report(driftedRefs(root, staged));
    if (text) console.error(text);
  } catch {
    // A note must never block a commit.
  }
}

if (require.main === module) main();

module.exports = { driftedRefs, report };
