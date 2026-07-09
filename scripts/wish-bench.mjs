#!/usr/bin/env node
/**
 * wish-bench.mjs — the intake exam behind the zero-revision number.
 *
 * A held-out corpus of fuzzy operator wishes (fresh phrasings, never the
 * cases the intake was fixed against) with human-defined correct behavior.
 * Scores the deterministic intake layer: splitting, frontend detection,
 * clarity questions, verifier derivation. Measurement, not a gate: always
 * exits 0 unless --min is given.
 *
 * Usage:
 *   node scripts/wish-bench.mjs           # human table + score
 *   node scripts/wish-bench.mjs --json    # machine scorecard
 *   node scripts/wish-bench.mjs --min 80  # exit 1 below 80%
 *   node scripts/wish-bench.mjs --cases held-out.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { analyzeWishParts, auditWish, deriveVerifyPlan } = require(path.join(ROOT, 'lib', 'wish-audit'));
const { isFrontendWish } = require(path.join(ROOT, 'lib', 'wish-design'));

// expect fields (each is optional; only stated expectations are scored):
//   parts: null (one wish) or a number of parts
//   frontend: true/false
//   asks: true (must ask at least one question) / false (must ask none)
//   testCmd: true (verify derives a test command) / false (it must not)
const CASES = [
  // splitting: one intent that sounds like two
  { id: 'S1', wish: 'polish the header and footer spacing', expect: { parts: null } },
  { id: 'S2', wish: 'give the editor find and replace', expect: { parts: null } },
  { id: 'S3', wish: 'tighten the gap between the sidebar and content', expect: { parts: null } },
  { id: 'S4', wish: 'make the diff view side by side and easier to scan', expect: { parts: null } },
  { id: 'S5', wish: 'wire up sign in and sign out on the account page', expect: { parts: null } },
  { id: 'S6', wish: 'let me search wishes plus filter them by status', expect: { parts: null } },
  // splitting: genuinely two intents
  { id: 'S7', wish: 'fix the flaky login test and write the release notes', expect: { parts: 2 } },
  { id: 'S8', wish: 'rename the settings page and update the docs for it', expect: { parts: 2 } },
  { id: 'S9', wish: 'speed up the boot sequence; clean the stale worktrees', expect: { parts: 2 } },
  // frontend: how an operator actually talks about visuals
  { id: 'F1', wish: 'the sidebar feels heavy', expect: { frontend: true } },
  { id: 'F2', wish: 'make the signup flow gorgeous', expect: { frontend: true } },
  { id: 'F3', wish: 'our charts look like excel', expect: { frontend: true } },
  { id: 'F4', wish: 'too much going on above the fold', expect: { frontend: true } },
  { id: 'F5', wish: 'the settings screen needs breathing room', expect: { frontend: true } },
  { id: 'F6', wish: 'dark mode washes out the cards', expect: { frontend: true } },
  // frontend: backend traps wearing frontend words
  { id: 'F7', wish: 'log the page count in the api response', expect: { frontend: false } },
  { id: 'F8', wish: 'the deploy script colors its output wrong in ci', expect: { frontend: false } },
  { id: 'F9', wish: 'cache the theme config lookup in the server', expect: { frontend: false } },
  { id: 'F10', wish: 'screen the webhook payloads for secrets', expect: { frontend: false } },
  // clarity: fuzzy but actionable, zero dumb questions
  { id: 'C1', wish: 'shave 300ms off boot', expect: { asks: false } },
  { id: 'C2', wish: 'Wednesday demo needs the banner gone', expect: { asks: false } },
  { id: 'C3', wish: 'Theres a weird gap under the hero', expect: { asks: false } },
  { id: 'C4', wish: 'ship the 2.0.1 patch today', expect: { asks: false } },
  { id: 'C5', wish: 'trim the recap to 5 lines max', expect: { asks: false } },
  { id: 'C6', wish: 'Honestly the empty inbox screen is depressing', expect: { asks: false } },
  // clarity: undecidable, must ask
  { id: 'C7', wish: 'do that thing again', expect: { asks: true } },
  { id: 'C8', wish: 'make it more like the other one', expect: { asks: true } },
  // verify: idioms vs deliverables
  { id: 'V1', wish: 'add coverage for the splitter edge cases', expect: { testCmd: true } },
  { id: 'V2', wish: 'this flow is testing my patience, simplify it', expect: { testCmd: false } },
  { id: 'V3', wish: 'stress test the intake with weird phrasings', expect: { testCmd: true } },
  { id: 'V4', wish: 'the cli feels slow on first run', expect: { testCmd: false } },
];

function scoreCase(entry, root) {
  const results = [];
  const { wish, expect } = entry;
  if ('parts' in expect) {
    const parts = analyzeWishParts(wish, root);
    const got = parts === null ? null : parts.length;
    results.push({ dim: 'parts', want: expect.parts, got, pass: got === expect.parts });
  }
  if ('frontend' in expect) {
    const got = isFrontendWish(wish);
    results.push({ dim: 'frontend', want: expect.frontend, got, pass: got === expect.frontend });
  }
  if ('asks' in expect) {
    const audit = auditWish(wish, root);
    const got = audit.questions.length > 0;
    results.push({ dim: 'asks', want: expect.asks, got, pass: got === expect.asks });
  }
  if ('testCmd' in expect) {
    const plan = deriveVerifyPlan(wish);
    const got = Boolean(plan.command);
    results.push({ dim: 'testCmd', want: expect.testCmd, got, pass: got === expect.testCmd });
  }
  return results;
}

function loadCases(casesPath) {
  if (!casesPath) return CASES;
  const resolved = path.resolve(process.cwd(), casesPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`--cases must point to a JSON array: ${resolved}`);
  return parsed;
}

function createHermeticScoringRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wish-bench-'));
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of ['codex', 'claude']) {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
    fs.chmodSync(file, 0o755);
  }
  return { root, binDir };
}

function withHermeticScoringRoot(fn) {
  const { root, binDir } = createHermeticScoringRoot();
  const previousPath = process.env.PATH;
  process.env.PATH = [binDir, previousPath || ''].filter(Boolean).join(path.delimiter);
  try {
    return fn(root);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function run() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const minIdx = args.indexOf('--min');
  const min = minIdx >= 0 ? Number(args[minIdx + 1]) : null;
  const casesIdx = args.indexOf('--cases');
  const cases = loadCases(casesIdx >= 0 ? args[casesIdx + 1] : '');

  const rows = [];
  let pass = 0;
  let total = 0;
  withHermeticScoringRoot((scoringRoot) => {
    for (const entry of cases) {
      const checks = scoreCase(entry, scoringRoot);
      const ok = checks.every((c) => c.pass);
      total += 1;
      if (ok) pass += 1;
      rows.push({ id: entry.id, wish: entry.wish, pass: ok, checks });
    }
  });
  const pct = Math.round((pass / total) * 1000) / 10;

  if (asJson) {
    console.log(JSON.stringify({ schema: 'atris.wish_bench.v1', cases: total, pass, pct, rows }, null, 2));
  } else {
    for (const row of rows) {
      const mark = row.pass ? 'pass' : 'FAIL';
      const detail = row.pass ? '' : '  [' + row.checks.filter((c) => !c.pass).map((c) => `${c.dim}: want ${c.want} got ${c.got}`).join('; ') + ']';
      console.log(`${mark}  ${row.id}  ${row.wish}${detail}`);
    }
    console.log(`\nwish-bench v1: ${pass}/${total} held-out wishes read correctly (${pct}%)`);
  }
  if (min !== null && pct < min) process.exit(1);
}

run();
