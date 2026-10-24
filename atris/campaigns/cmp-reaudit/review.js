#!/usr/bin/env node
// review.js <repo> <sample.jsonl> <out.jsonl> [--workers 6] [--prefer codex|claude|agy] [--prompt file]
// Blind second look at landed tests. Each sample line names a test file, the
// code it checks, and the engine that wrote it. A reviewer from a different
// AI family reads both (read only) and answers keep, weak, or remove.
// Claude runs on the subscription, never the API key. Zero dependencies.
'use strict';
if (require.main !== module) return;
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const [repo, samplePath, outPath] = process.argv.slice(2).map((p) => path.resolve(p));
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const workers = Number(arg('--workers', 6));
const prefer = arg('--prefer', 'codex'); // grader to use unless it wrote the test
const template = fs.readFileSync(path.join(__dirname, arg('--prompt', 'review-prompt.txt')), 'utf8');
const sample = fs.readFileSync(samplePath, 'utf8').trim().split('\n').map(JSON.parse);
const done = new Set(fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).file) : []);

function run(cmd, args) {
  return new Promise((resolve) => {
    const env = { ...process.env }; delete env.ANTHROPIC_API_KEY;
    const p = spawn('perl', ['-e', 'alarm shift; exec @ARGV', String(process.env.REVIEW_SECS || 400), cmd, ...args], { cwd: repo, env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out }));
  });
}

async function review(job) {
  const prompt = template.replace('{{FILE}}', job.file).replace('{{TARGET}}', job.target || 'the module it loads')
    .replace('{{FN}}', job.fn ? `, function ${job.fn}` : '').replace('{{NOTE}}', job.note || '');
  // never the engine that wrote the test, nor any the job says to avoid (an earlier grader)
  const avoid = new Set([job.writer, ...(job.avoid || [])]);
  const reviewer = [prefer, 'claude', 'codex', 'agy'].find((e) => !avoid.has(e));
  if (!reviewer) return { file: job.file, group: job.group, writer: job.writer, reviewer: null, verdict: 'no-eligible-grader', reason: `every grader is the writer or an earlier grader: ${[...avoid].join(', ')}` };
  const r = reviewer === 'claude'
    ? await run('claude', ['-p', '--model', 'claude-sonnet-5-5', '--allowedTools=Read,Grep,Glob', '--', prompt])
    : reviewer === 'agy'
      ? await run('agy', ['-p', prompt, '--model', 'gemini-3.8-flash', '--add-dir', repo])
      : await run('codex', ['exec', '-m', 'gpt-6.1-sol', '-s', 'read-only', prompt]);
  const m = [...r.out.matchAll(/\{"verdict":\s*"(keep|weak|remove|pins-bug|fine|confirmed|refuted)",\s*"reason":\s*"((?:[^"\\]|\\.)*)"\}/g)].pop();
  return { file: job.file, group: job.group, writer: job.writer, reviewer, verdict: m ? m[1] : 'no-answer', reason: m ? JSON.parse(`"${m[2]}"`) : r.out.slice(-200) };
}

(async () => {
  const todo = sample.filter((j) => !done.has(j.file));
  let next = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < todo.length) {
      const r = await review(todo[next++]);
      fs.appendFileSync(outPath, JSON.stringify(r) + '\n');
      console.log(`${r.verdict.padEnd(9)} ${r.file} (${r.writer} -> ${r.reviewer})`);
    }
  }));
})();
