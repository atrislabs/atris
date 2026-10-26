#!/usr/bin/env node
'use strict';

// Checks ship gate lines 1 to 5 from README.md against judged output folders.
// usage: node gate.js out-final-mixed out-final-writing
// The last folder is the writing set (gate line 4).
const fs = require('node:fs');
const path = require('node:path');


const load = (dir) => ({
  records: fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'verdicts.json')
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))),
  verdicts: JSON.parse(fs.readFileSync(path.join(dir, 'verdicts.json'), 'utf8')),
});

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
  const sets = dirs.map(load);
  const all = { records: sets.flatMap((s) => s.records), verdicts: sets.flatMap((s) => s.verdicts) };
  const writing = sets[sets.length - 1];
  const expectedPairs = all.records.length * 3;

  const vsNudge = tally(all.verdicts, 'skill', 'nudge');
  const vsPlain = tally(all.verdicts, 'skill', 'plain');
  const nudgeVsPlain = tally(all.verdicts, 'nudge', 'plain');
  const writingVsPlain = tally(writing.verdicts, 'skill', 'plain');
  const grew = (arm) => new Set(all.verdicts.filter((v) => v.grew[arm]).map((v) => v.id)).size;
  const wc = (s) => s.split(/\s+/).filter(Boolean).length;
  const broken = all.records.filter((r) => wc(r.answers.skill) < 50 || /<invoke\b|<parameter\b/.test(r.answers.skill)).map((r) => r.id);

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
