#!/usr/bin/env node
'use strict';

// Checks ship gate lines 1 to 5 from README.md against judged output folders.
// usage: node gate.js out-final-mixed out-final-writing
// The last folder is the writing set (gate line 4).
const fs = require('node:fs');
const path = require('node:path');


const { PAIRS, verdictKey, loadRecords } = require('./judge.js');

// Keeps one verdict per task and pair, and only if it judged the answers on
// file now. Stale or duplicate verdicts never count.
function load(dir) {
  const records = loadRecords(dir);
  const file = path.join(dir, 'verdicts.json');
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  const valid = new Map();
  for (const rec of records) {
    for (const [a, b] of PAIRS) {
      const key = verdictKey(rec, a, b);
      const v = raw.find((x) => x.id === rec.id && x.a === a && x.b === b && x.key === key);
      if (v) valid.set(`${rec.id}|${a}|${b}`, v);
    }
  }
  return { records, verdicts: [...valid.values()] };
}

// One-sided sign test: chance of at least `wins` heads in wins + losses fair flips.
function signP(wins, losses) {
  const n = wins + losses;
  let tail = 0;
  for (let k = wins; k <= n; k += 1) tail += choose(n, k);
  return tail / 2 ** n;
}
function choose(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return r;
}

function tally(verdicts, a, b) {
  const vs = verdicts.filter((v) => v.a === a && v.b === b);
  const wins = vs.filter((v) => v.winner === a).length;
  const losses = vs.filter((v) => v.winner === b).length;
  return { wins, losses, ties: vs.length - wins - losses, n: vs.length, p: signP(wins, losses) };
}

function main(dirs) {
  if (new Set(dirs).size !== dirs.length) { console.error('the same folder was given twice'); process.exitCode = 2; return; }
  const sets = dirs.map(load);
  const ids = sets.flatMap((set) => set.records.map((r) => r.id));
  const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (repeated.length) { console.error(`task counted twice: ${[...new Set(repeated)].join(', ')}`); process.exitCode = 2; return; }
  const all = { records: sets.flatMap((s) => s.records), verdicts: sets.flatMap((s) => s.verdicts) };
  const writing = sets[sets.length - 1];
  const expectedPairs = all.records.length * PAIRS.length;

  const vsNudge = tally(all.verdicts, 'skill', 'nudge');
  const vsPlain = tally(all.verdicts, 'skill', 'plain');
  const nudgeVsPlain = tally(all.verdicts, 'nudge', 'plain');
  const writingVsPlain = tally(writing.verdicts, 'skill', 'plain');
  const grew = (arm) => new Set(all.verdicts.filter((v) => v.grew[arm]).map((v) => v.id)).size;
  const wc = (s) => s.split(/\s+/).filter(Boolean).length;
  // Broken = no real answer: fake command markup (every break seen in these
  // runs) or a near-empty reply. Correct short answers are not broken.
  const broken = all.records.filter((r) => /<invoke\b|<parameter\b/.test(r.answers.skill) || wc(r.answers.skill) < 10).map((r) => r.id);

  const fmt = (t) => `${t.wins} won, ${t.losses} lost, ${t.ties} tied, p=${t.p.toFixed(4)}`;
  const lines = [
    ['all pairs judged', all.verdicts.length === expectedPairs, `${all.verdicts.length}/${expectedPairs}`],
    ['1 beats the nudge for real', vsNudge.wins > vsNudge.losses && vsNudge.p < 0.05, fmt(vsNudge)],
    ['2 never worse than plain', vsPlain.wins >= vsPlain.losses, fmt(vsPlain)],
    ['3 same size job', grew('skill') <= grew('nudge'), `skill ${grew('skill')}, nudge ${grew('nudge')}, plain ${grew('plain')} of ${all.records.length}`],
    ['4 writing fixed', writingVsPlain.wins >= writingVsPlain.losses, fmt(writingVsPlain)],
    ['5 nothing broken', broken.length === 0, broken.length ? broken.join(', ') : 'none'],
  ];
  for (const [name, ok, detail] of lines) console.log(`${ok ? 'pass' : 'FAIL'}  ${name.padEnd(28)} ${detail}`);
  console.log(`info  better than plain claim       ${vsPlain.p < 0.05 && vsPlain.wins > vsPlain.losses ? 'earned' : 'not earned'} (${fmt(vsPlain)})`);
  console.log(`info  nudge vs plain                ${fmt(nudgeVsPlain)}`);
  process.exitCode = lines.every(([, ok]) => ok) ? 0 : 1;
}

if (require.main === module) {
  const dirs = process.argv.slice(2).map((d) => path.resolve(__dirname, d));
  if (dirs.length < 2) { console.error('usage: node gate.js <mixed-out> <writing-out>'); process.exit(2); }
  main(dirs);
}

module.exports = { signP };
