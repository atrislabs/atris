'use strict';
// Build atris/sentinel-bench/real-advisories-2/advisories.json from picks.json
// and pins.json. Line numbers are read from the vulnerable-commit clones under
// <reposRoot>/<id> by matching each pin's pattern (nth match, default 1).
// node makeexam.cjs picks.json pins.json <reposRoot> <out.json>
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const [picksPath, pinsPath, reposRoot, outPath] = process.argv.slice(2);
const picks = JSON.parse(fs.readFileSync(picksPath, 'utf8')).picks;
const pins = JSON.parse(fs.readFileSync(pinsPath, 'utf8'));

const LANG = { '.go': 'Go', '.py': 'Python', '.ts': 'TypeScript', '.js': 'JavaScript' };
const problems = [];
function lineOf(id, file, pat, nth = 1) {
  const full = path.join(reposRoot, id, file);
  if (!fs.existsSync(full)) { problems.push(`${id}: ${file} missing`); return null; }
  const rx = new RegExp(pat);
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) if (rx.test(lines[i]) && ++seen === nth) return i + 1;
  problems.push(`${id}: /${pat}/ #${nth} not found in ${file}`);
  return null;
}

const ids = picks.map((p) => p.id).sort();
const list = picks.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map((p) => {
  const pin = pins[p.id];
  if (!pin) throw new Error(`no pin for ${p.id}`);
  const a = JSON.parse(execFileSync('gh', ['api', `/advisories/${p.id}`], { encoding: 'utf8' }));
  return {
    id: p.id,
    cve: a.cve_id || null,
    split: ids.indexOf(p.id) % 2 === 0 ? 'seen' : 'held-out',
    class: pin.class,
    repo: p.repo,
    language: LANG[path.extname(pin.hole_file)] || p.language,
    repo_files: p.repo_files,
    advisory_url: `https://github.com/advisories/${p.id}`,
    severity: a.severity,
    advisory_title: a.summary,
    published: a.published_at,
    vulnerable_commit: p.vulnerable_commit,
    fix_commit: p.fix_commit,
    fix_url: `https://github.com/${p.repo}/commit/${p.fix_commit}`,
    hole_file: pin.hole_file,
    hole_line: lineOf(p.id, pin.hole_file, pin.pat, pin.pat_nth || 1),
    also: (pin.also || []).map(([file, pat, nth]) => ({ file, line: lineOf(p.id, file, pat, nth || 1) })),
    hole: pin.hole,
  };
});
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(list, null, 1)}\n`);
console.log(problems.length ? problems.join('\n') : 'all lines pinned');
