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
// The mission Git wrapper is generated at runtime, so the checked-in scanner
// cannot see these two calls. Keep this exception exact and documented here.
const GENERATED_CONSUMER_EXPORTS = new Set([
  'lib/mission-protected-lane.js → gitSubcommand',
  'lib/mission-protected-lane.js → defaultGit',
]);

test('no JS file in commands/ or lib/ is unreachable and unreferenced', () => {
  const r = findDeadCode(ROOT);
  assert.deepEqual(r.dead.map((f) => path.relative(ROOT, f)), [],
    'dead files found — delete them or wire them up');
});

test('no export in commands/ or lib/ is unnamed by the rest of the repo', () => {
  const files = ['commands', 'lib'].flatMap((d) => listJsFiles(path.join(ROOT, d)));
  const orphans = findOrphanedExports(ROOT, files, listJsFiles(ROOT))
    .map((o) => `${path.relative(ROOT, o.file)} → ${o.name}`)
    .filter((name) => !GENERATED_CONSUMER_EXPORTS.has(name));
  assert.deepEqual(orphans, [],
    'orphaned exports found — drop the export entry (the definition can stay if used internally)');
});
