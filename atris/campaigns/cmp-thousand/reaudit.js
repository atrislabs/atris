#!/usr/bin/env node
// reaudit.js <repo> <list-of-test-files> [--workers 8] [--out file.jsonl]
// Re-checks landed tests against the code as it is now. Each test must pass
// in an empty environment in two time zones a day apart, and must fail on at
// least one small break inside the function it is named after
// (test/<module>--<function-name>.test.js). Breaks are the same one-line
// swaps the overnight run used, tried one at a time in a private copy and
// always put back. A test whose function has no breakable line is reported,
// not failed. Zero dependencies.
'use strict';
if (require.main !== module) return;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const repo = path.resolve(process.argv[2]);
const list = fs.readFileSync(process.argv[3], 'utf8').split('\n').filter((f) => /^test\/.*\.test\.js$/.test(f));
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const workers = Number(arg('--workers', 8));
const out = path.resolve(arg('--out', path.join(repo, 'atris/campaigns/cmp-thousand/reaudit.jsonl')));
const maxBreaks = 8;

const SWAPS = [
  [' === ', ' !== '], [' !== ', ' === '],
  [' >= ', ' > '], [' <= ', ' < '], [' > ', ' >= '], [' < ', ' <= '],
  [' && ', ' || '], [' || ', ' && '],
  ['return true;', 'return false;'], ['return false;', 'return true;'],
  [' + 1', ' - 1'], [' - 1', ' + 1'],
];
const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
function outsideStrings(line, idx) {
  const before = line.slice(0, idx);
  for (const q of ["'", '"', '`']) if ((before.split(q).length - 1) % 2 === 1) return false;
  return !before.includes('//');
}

// the module the test loads and the line range of the function it names
function plan(file) {
  const src = fs.readFileSync(path.join(repo, file), 'utf8');
  const name = path.basename(file, '.test.js');
  const fn = name.includes('--') ? camel(name.split('--').pop()) : null;
  const mods = [...src.matchAll(/require\(['"]\.\.\/((?:lib|commands)\/[^'"]+?)(?:\.js)?['"]\)/g)].map((m) => `${m[1]}.js`);
  const job = { file, fn };
  if (!fn || !mods.length) return { ...job, sites: [] };
  for (const target of mods) {
    const lines = fs.readFileSync(path.join(repo, target), 'utf8').split('\n');
    const re = new RegExp(`(function\\s*\\*?\\s*${fn}\\s*\\(|\\b${fn}\\s*[=:]\\s*(async\\s*)?(function|\\(|[a-zA-Z_$]+\\s*=>)|^\\s*(async\\s+)?${fn}\\s*\\([^)]*\\)\\s*\\{)`);
    const start = lines.findIndex((l) => re.test(l));
    if (start < 0) continue;
    // walk braces to find the end of the function
    let depth = 0; let seen = false; let end = start;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i].replace(/(['"`]).*?\1/g, '')) { if (ch === '{') { depth++; seen = true; } else if (ch === '}') depth--; }
      end = i; if (seen && depth <= 0) break;
    }
    const sites = [];
    for (let i = start; i <= end; i++) {
      const t = lines[i].trim();
      if (!t || t.startsWith('//') || t.startsWith('*')) continue;
      for (const [from, to] of SWAPS) { const at = lines[i].indexOf(from); if (at >= 0 && outsideStrings(lines[i], at)) sites.push({ i, at, from, to }); }
    }
    const step = Math.max(1, Math.floor(sites.length / maxBreaks));
    return { ...job, target, range: [start + 1, end + 1], sites: sites.filter((_, k) => k % step === 0).slice(0, maxBreaks) };
  }
  return { ...job, sites: [] };
}

function runTest(cwd, file, tz) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reaudit-'));
  return new Promise((resolve) => {
    const p = spawn('perl', ['-e', 'alarm shift; exec @ARGV', '90', 'node', '--test', file], {
      cwd, stdio: 'ignore',
      env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: os.tmpdir(), TZ: tz, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ATRIS_SKIP_UPDATE_CHECK: '1' },
    });
    p.on('exit', (code) => { fs.rmSync(tmp, { recursive: true, force: true }); resolve(code); });
  });
}

async function check(cwd, job) {
  for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    if (await runTest(cwd, job.file, tz) !== 0) return { ...job, sites: undefined, status: 'fails-on-real', tz };
  }
  if (!job.sites.length) return { ...job, sites: undefined, status: 'passes-no-breakable-line' };
  const abs = path.join(cwd, job.target);
  const original = fs.readFileSync(abs, 'utf8');
  let caught = 0;
  for (const s of job.sites) {
    const lines = original.split('\n');
    lines[s.i] = lines[s.i].slice(0, s.at) + s.to + lines[s.i].slice(s.at + s.from.length);
    fs.writeFileSync(abs, lines.join('\n'));
    try { if (await runTest(cwd, job.file, 'UTC') !== 0) caught++; } finally { fs.writeFileSync(abs, original); }
  }
  return { ...job, tried: job.sites.length, caught, sites: undefined, status: caught ? 'catches' : 'misses-every-break' };
}

(async () => {
  const jobs = list.filter((f) => fs.existsSync(path.join(repo, f))).map(plan);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reaudit-copies-'));
  const copies = [];
  for (let i = 0; i < workers; i++) {
    const c = path.join(base, `w${i}`);
    spawnSync('git', ['worktree', 'add', '-q', '--detach', c, head], { cwd: repo });
    copies.push(c);
  }
  fs.writeFileSync(out, '');
  let next = 0; let done = 0; const tally = {};
  await Promise.all(copies.map(async (c) => {
    while (next < jobs.length) {
      const r = await check(c, jobs[next++]);
      tally[r.status] = (tally[r.status] || 0) + 1;
      fs.appendFileSync(out, JSON.stringify(r) + '\n');
      if (++done % 50 === 0) console.log(`${done}/${jobs.length} ${JSON.stringify(tally)}`);
    }
  }));
  for (const c of copies) spawnSync('git', ['worktree', 'remove', '--force', c], { cwd: repo });
  fs.rmSync(base, { recursive: true, force: true });
  console.log(`done ${jobs.length}: ${JSON.stringify(tally)}`);
})();
