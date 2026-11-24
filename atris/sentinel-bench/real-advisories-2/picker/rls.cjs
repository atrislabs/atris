'use strict';
// RLS slot: GitHub's CWE list has no class for database permission rules, so
// read every reviewed npm/pip/go advisory in the date range and keep those whose
// text names row level security (RLS) or a Supabase/Postgres policy.
const { execFileSync } = require('child_process');
const RX = new RegExp(process.argv[2] || "\\b(RLS|row[- ]level security)", "i");
for (const eco of ['npm', 'pip', 'go']) {
  let out = '';
  try { out = execFileSync('gh', ['api', '--paginate', `/advisories?ecosystem=${eco}&per_page=100&type=reviewed&published=2024-06-01..2026-11-23`, '--jq', '.[] | [.ghsa_id, .cve_id, .severity, ([.cwes[].cwe_id]|join(",")), .source_code_location, ([.references[]|select(test("/commit/"))]|join(" ")), .published_at, (.summary|gsub("\t";" ")), (.description|gsub("[\t\n]";" ")|.[0:4000])] | @tsv'], { encoding: 'utf8', maxBuffer: 512 << 20 }); }
  catch (e) { process.stderr.write(`gh failed for ${eco}\n`); continue; }
  for (const line of out.split('\n')) {
    const f = line.split('\t');
    if (f.length < 9) continue;
    if (RX.test(f[7]) || RX.test(f[8])) console.log([eco, ...f.slice(0, 8)].join('\t'));
  }
}
