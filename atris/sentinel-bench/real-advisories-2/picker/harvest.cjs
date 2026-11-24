'use strict';
// Harvest candidate advisories from the GitHub global advisory API, same rules
// as the first exam (atris/sentinel-bench/real-advisories/README.md): reviewed
// advisories 2024-06 to now in npm, pip and Go, filtered to the CWE classes,
// to exactly one fix commit link in the advisory's own repo. Pages through
// every result (the first exam read only the first 100 per query).
// Prints one TSV line per advisory.
const { execFileSync } = require('child_process');

const ECOS = ['npm', 'pip', 'go'];
const CWES = {
  access: [639, 862, 863, 284, 285],
  signin: [287, 289, 290, 305, 1390],
  webhook: [345, 347, 348],
  secrets: [200, 359, 522, 538, 312],
  injection: [89, 78, 94, 943],
  ssrf: [918],
  traversal: [22, 23],
};

function gh(args) {
  try {
    const out = execFileSync('gh', ['api', '--paginate', ...args], { encoding: 'utf8', maxBuffer: 256 << 20 });
    // --paginate concatenates JSON arrays as ][
    return JSON.parse(`[${out.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/\]\s*\[/g, ',')}]`);
  } catch (e) { process.stderr.write(`gh failed: ${args[0]}\n`); return []; }
}

const seen = new Set();
for (const [cls, cwes] of Object.entries(CWES)) {
  for (const eco of ECOS) {
    const list = gh([`/advisories?ecosystem=${eco}&cwes=${cwes.join(',')}&per_page=100&type=reviewed&published=2024-06-01..2026-11-23`]);
    for (const a of list) {
      if (!a || seen.has(a.ghsa_id)) continue;
      seen.add(a.ghsa_id);
      const commits = [...new Set((a.references || []).filter((r) => /github\.com\/[^/]+\/[^/]+\/commit\/[0-9a-f]{7,40}/.test(r)).map((r) => r.replace(/[#?].*$/, '')))];
      if (commits.length !== 1) continue;
      const repo = (a.source_code_location || '').replace(/\/$/, '');
      if (!repo.startsWith('https://github.com/')) continue;
      if (!commits[0].toLowerCase().startsWith(repo.toLowerCase() + '/commit/')) continue;
      const cwe = (a.cwes || []).map((c) => c.cwe_id).join(',');
      console.log([cls, eco, a.ghsa_id, a.cve_id || '', a.severity, cwe, repo, commits[0], a.published_at, (a.summary || '').replace(/\t/g, ' ')].join('\t'));
    }
  }
}
