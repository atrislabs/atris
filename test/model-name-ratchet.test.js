// Ratchet: hardcoded model names in code went stale before (grok pinned to
// 4.6, codex ignoring roster picks). No file may name more models than the
// recorded baseline, so new names land in the roster or the known-names list
// instead of spreading through the code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const baselinePath = path.join(__dirname, 'fixtures', 'model-name-ratchet.json');
const SCAN_DIRS = ['lib', 'commands', 'bin'];
// Ids with dashes and the everyday spaced names people type, so "opus 5.5"
// or "grok 4.7 fast" can't spread where "claude-opus-5-5" would be caught.
const MODEL_NAME_PATTERNS = [
  /claude-(?:opus|sonnet|haiku|fable)-\d/g,
  /\b(?:opus|sonnet|haiku|fable) \d/gi,
  /\bgpt-\d/g,
  /\bgpt-oss\b/gi,
  /\bgrok[- ]\d/gi,
  /\bswe-\d/g,
  /\bgemini[- ]\d/gi,
  /\bcomposer[- ]\d/gi,
  /\bkimi[- ]\d/gi,
];

function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function countModelNames(file) {
  const text = fs.readFileSync(file, 'utf8');
  let total = 0;
  for (const pattern of MODEL_NAME_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) total += matches.length;
  }
  return total;
}

test('hardcoded model names do not grow past the recorded baseline', (t) => {
  const files = SCAN_DIRS.flatMap((dir) => collectJsFiles(path.join(repoRoot, dir)));
  // Lowering or resetting the baseline is a deliberate act:
  // ATRIS_WRITE_MODEL_RATCHET=1 node --test test/model-name-ratchet.test.js
  if (process.env.ATRIS_WRITE_MODEL_RATCHET === '1') {
    const counts = {};
    for (const file of files) {
      const count = countModelNames(file);
      if (count) counts[path.relative(repoRoot, file)] = count;
    }
    fs.writeFileSync(baselinePath, `${JSON.stringify(counts, null, 2)}\n`);
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const seen = new Set();
  const failures = [];
  const shrunk = [];
  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    seen.add(rel);
    const count = countModelNames(file);
    const base = Object.prototype.hasOwnProperty.call(baseline, rel) ? baseline[rel] : 0;
    if (count > base) {
      failures.push(`${rel} now names ${count} models (baseline ${base}). Model names belong in the roster or the known-names list; if this one is intentional, lower another count or update the baseline on purpose.`);
    } else if (count < base) {
      shrunk.push(`${rel} now names ${count} models (baseline ${base}): lower the baseline on purpose.`);
    }
  }
  for (const rel of Object.keys(baseline)) {
    if (!seen.has(rel)) shrunk.push(`${rel} is gone (baseline ${baseline[rel]}): lower the baseline on purpose.`);
  }
  for (const note of shrunk) t.diagnostic(note);
  assert.deepEqual(failures, []);
});
