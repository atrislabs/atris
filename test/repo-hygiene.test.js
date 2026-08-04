// Repo hygiene ratchet: dead code stays deleted.
//
// `atris slop dead --exports` swept this repo clean (433 orphaned exports,
// 2026-07-24). This test pins the result: any new unreachable file or export
// nothing names fails CI with the exact file:name to delete. Cleanup is a
// ratchet, not an event.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

// Tests must never spawn the CLI with the repo root as cwd (CLI-1241): the CLI
// then mutates the checkout's own .atris/state mid-suite. Every direct spawn of
// bin/atris.js in test files needs an explicit cwd, and that cwd must not be
// the repo root or an inherited process.cwd().
test('no test spawns the CLI with the repo root as its working directory', () => {
  const testDir = __dirname;
  const banned = [];

  const extractCall = (src, openParen) => {
    let depth = 0;
    let i = openParen;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    return src.slice(openParen, i + 1);
  };

  for (const file of fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js'))) {
    if (file === 'repo-hygiene.test.js') continue;
    const src = fs.readFileSync(path.join(testDir, file), 'utf8');
    const spawnRe = /\b(?:spawnSync|execFileSync|spawn|execFile)\s*\(/g;
    let match;
    while ((match = spawnRe.exec(src))) {
      const call = extractCall(src, match.index + match[0].length - 1);
      if (!/cliPath|['"]bin['"]\s*,\s*['"]atris\.js['"]|bin\/atris\.js/.test(call)) continue;
      const line = src.slice(0, match.index).split('\n').length;
      if (!/\bcwd\b/.test(call)) {
        banned.push(`${file}:${line} spawns the CLI without a cwd`);
      } else if (/cwd\s*:\s*repoRoot\b|\|\|\s*repoRoot\b|cwd\s*:\s*process\.cwd\(\)|\|\|\s*process\.cwd\(\)/.test(call)) {
        banned.push(`${file}:${line} spawns the CLI with a repo-root cwd`);
      }
    }
  }

  assert.deepEqual(banned, [],
    'CLI spawns must run from a temp dir (mkdtempSync + cleanup), never the repo checkout');
});
