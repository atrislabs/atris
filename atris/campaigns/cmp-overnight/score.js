#!/usr/bin/env node
// score.js <dir> <round> [--evidence]
// Scores one round per instruction version: tried, passed the check, dropped
// by review, net kept, seconds per job. Appends the score to rounds.jsonl.
// With --evidence, prints the round's misses and drops for the coach instead,
// without saying which version produced them.
'use strict';
if (require.main !== module) return;
const fs = require('fs');
const [H, roundArg] = process.argv.slice(2);
const round = Number(roundArg);
const evidence = process.argv.includes('--evidence');

const rows = fs.readFileSync(`${H}/ledger.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  .filter((r) => r.round === round)
  // a miss in under 20 seconds is an engine out of quota, not a judgment: left out of both versions
  .filter((r) => r.ok || r.secs >= 20);
const jobOf = {};
for (const f of fs.readdirSync(`${H}/claimed`)) { const j = JSON.parse(fs.readFileSync(`${H}/claimed/${f}`, 'utf8')); jobOf[j.id] = j; }
const dropFile = `${H}/round-${round}-drops.txt`;
const drops = {};
if (fs.existsSync(dropFile)) for (const line of fs.readFileSync(dropFile, 'utf8').split('\n')) {
  const m = line.match(/^DROP (\S+?):\s*(.*)$/); if (m) drops[m[1]] = m[2];
}

if (evidence) {
  for (const r of rows) {
    const j = jobOf[r.id] || {};
    const where = `${j.target} line ${j.line}: \`${j.before}\` -> \`${j.after}\``;
    if (!r.ok) console.log(`MISS ${where}\n  check said: ${r.reason}`);
    else if (drops[(j.files || [])[0]]) console.log(`DROPPED BY REVIEW ${where}\n  reviewer said: ${drops[j.files[0]]}`);
  }
  const kept = rows.filter((r) => r.ok && !drops[(jobOf[r.id]?.files || [])[0]]).length;
  console.log(`\n${kept} of ${rows.length} jobs this round were kept.`);
  process.exit(0);
}

const byV = {};
for (const r of rows) {
  const s = byV[r.version] ||= { version: r.version, tried: 0, passed: 0, dropped: 0, secs: 0 };
  s.tried++; s.secs += r.secs;
  if (r.ok) { s.passed++; if (drops[(jobOf[r.id]?.files || [])[0]]) s.dropped++; }
}
const out = Object.values(byV).map((s) => ({ ...s, kept: s.passed - s.dropped,
  keep_rate: s.tried ? +((s.passed - s.dropped) / s.tried).toFixed(3) : 0, secs_per_job: s.tried ? Math.round(s.secs / s.tried) : 0, secs: undefined }));
fs.appendFileSync(`${H}/rounds.jsonl`, JSON.stringify({ round, at: new Date().toISOString(), versions: out }) + '\n');
for (const s of out) console.log(`round ${round} v${s.version}: tried ${s.tried}, kept ${s.kept} (${Math.round(s.keep_rate * 100)}%), ${s.secs_per_job}s per job`);
