// Repo hygiene ratchet: dead code stays deleted.
//
// `atris slop dead --exports` swept this repo clean (433 orphaned exports,
// 2026-07-24). This test pins the result: any new unreachable file or export
// nothing names fails CI with the exact file:name to delete. Cleanup is a
// ratchet, not an event.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { findDeadCode, findOrphanedExports, listJsFiles } = require('../commands/slop');

const ROOT = path.join(__dirname, '..');

test('no JS file in commands/ or lib/ is unreachable and unreferenced', () => {
  const r = findDeadCode(ROOT);
  assert.deepEqual(r.dead.map((f) => path.relative(ROOT, f)), [],
    'dead files found — delete them or wire them up');
});

test('no export in commands/ or lib/ is unnamed by the rest of the repo', () => {
  const files = ['commands', 'lib'].flatMap((d) => listJsFiles(path.join(ROOT, d)));
  const orphans = findOrphanedExports(ROOT, files, listJsFiles(ROOT))
    .map((o) => `${path.relative(ROOT, o.file)} → ${o.name}`);
  assert.deepEqual(orphans, [],
    'orphaned exports found — drop the export entry (the definition can stay if used internally)');
});
