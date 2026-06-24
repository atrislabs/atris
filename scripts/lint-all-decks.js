#!/usr/bin/env node
// Validate + lint every spec in decks/. Exits non-zero on any schema or lint
// error so CI fails when a shipped example deck regresses. Run: npm run lint:decks
const fs = require('fs');
const path = require('path');
const { validateSpec } = require('../lib/deck-schema');
const { lintSpec } = require('../lib/deck-review');

const dir = path.join(__dirname, '..', 'decks');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];

let totalErrors = 0;
let totalWarns = 0;
for (const file of files) {
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch (e) {
    totalErrors += 1;
    console.log(`✗ ${file.padEnd(42)} unreadable: ${e.message}`);
    continue;
  }
  const findings = [...validateSpec(spec), ...lintSpec(spec)];
  const errs = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity === 'warn');
  totalErrors += errs.length;
  totalWarns += warns.length;
  console.log(`${errs.length ? '✗' : '✓'} ${file.padEnd(42)} ${errs.length} errors, ${warns.length} warns`);
  for (const e of errs) console.log(`      slide ${e.slide}  ${e.rule}: ${e.message}`);
}

console.log(`\n${files.length} decks · ${totalErrors} errors · ${totalWarns} warnings`);
if (totalErrors) {
  console.error('deck lint failed');
  process.exit(1);
}
