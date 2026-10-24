#!/usr/bin/env node
// reaudit.js <repo> [--workers 8] [--out reaudit.jsonl]
// Re-checks every landed break-catching test against the code as it is now,
// trusting nothing from the run that made it. For each test/<base>--mut-L<n>-<k>
// file: find the line it was written against (from the commit that added the
// test), find that line in today's code, then require the test to pass on the
// real code in two time zones and fail once the line is broken again.
// Each worker uses its own detached copy so breaks never overlap. Zero deps.
'use strict';
if (require.main !== module) return;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const repo = path.resolve(process.argv[2] || '.');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const workers = Number(arg('--workers', 8));
const out = path.resolve(arg('--out', path.join(repo, 'atris/campaigns/cmp-overnight/reaudit.jsonl')));
const only = arg('--only', '');

const SWAPS = [
  [' === ', ' !== '], [' !== ', ' === '],
  [' >= ', ' > '], [' <= ', ' < '], [' > ', ' >= '], [' < ', ' <= '],
  [' && ', ' || '], [' || ', ' && '],
  ['return true;', 'return false;'], ['return false;', 'return true;'],
  [' + 1', ' - 1'], [' - 1', ' + 1'],
];
const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 26 }).stdout;

// build the job list
const files = fs.readdirSync(path.join(repo, 'test')).filter((f) => /--mut-L\d+-\d+\.test\.js$/.test(f))
  .filter((f) => !only || f.includes(only));
const head = git('rev-parse', 'HEAD').trim();
const jobs = files.map((f) => {
  const m = f.match(/^(.*?)(-cmd)?--mut-L(\d+)-(\d+)\.test\.js$/);
  const target = `${m[2] ? 'commands' : 'lib'}/${m[1]}.js`;
  const line = Number(m[3]); const [from, to] = SWAPS[Number(m[4])];
  const added = git('log', '--diff-filter=A', '--format=%H', '-1', '--', `test/${f}`).trim();
  const then = added ? git('show', `${added}^:${target}`).split('\n')[line - 1] : undefined;
  const nowLines = fs.readFileSync(path.join(repo, target), 'utf8').split('\n');
  const job = { file: `test/${f}`, target, line, from, to, added };
  if (then === undefined || !then.includes(from)) return { ...job, status: 'no-origin' };
  // nearest line in today's code with the same text
  let best = -1;
  nowLines.forEach((l, i) => { if (l.trim() === then.trim() && (best < 0 || Math.abs(i + 1 - line) < Math.abs(best + 1 - line))) best = i; });
  if (best < 0) return { ...job, status: 'line-gone', before: then.trim() };
  return { ...job, nowLine: best + 1, before: then.trim() };
});

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
    if (await runTest(cwd, job.file, tz) !== 0) return { ...job, status: 'fails-on-real', tz };
  }
  if (!job.nowLine) return job; // passes, but the break can no longer be placed
  const abs = path.join(cwd, job.target);
  const original = fs.readFileSync(abs, 'utf8');
  const lines = original.split('\n'); const l = lines[job.nowLine - 1];
  const at = l.indexOf(job.from);
  lines[job.nowLine - 1] = l.slice(0, at) + job.to + l.slice(at + job.from.length);
  fs.writeFileSync(abs, lines.join('\n'));
  let code;
  try { code = await runTest(cwd, job.file, 'UTC'); } finally { fs.writeFileSync(abs, original); }
  return { ...job, status: code === 0 ? 'misses-break' : 'catches' };
}

(async () => {
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
      const job = jobs[next++];
      const r = job.status ? job : await check(c, job);
      tally[r.status || 'passes-only'] = (tally[r.status || 'passes-only'] || 0) + 1;
      fs.appendFileSync(out, JSON.stringify(r) + '\n');
      if (++done % 50 === 0) console.log(`${done}/${jobs.length} ${JSON.stringify(tally)}`);
    }
  }));
  for (const c of copies) spawnSync('git', ['worktree', 'remove', '--force', c], { cwd: repo });
  fs.rmSync(base, { recursive: true, force: true });
  console.log(`done ${jobs.length}: ${JSON.stringify(tally)}`);
})();
