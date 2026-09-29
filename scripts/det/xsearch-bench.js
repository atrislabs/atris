#!/usr/bin/env node
'use strict';

// Bench what users get from `atris x-search`, end to end.
// Usage: node scripts/det/xsearch-bench.js [--quick|--free] [--case <name>]
//   default: every case, 2 paid searches (10 credits)
//   --quick: topic plus the free cases (5 credits)
//   --free:  free cases only (0 credits)
// Prints one line per case and a final "bench: X/Y passed in Ns"; exits 1 if
// any case fails. Rows (with a `case` field) go to $XSEARCH_OUT_DIR/xsearch.jsonl,
// default ~/.atris/benchmarks, outside any git repo. A failed paid case also
// keeps its full output there, since it cost credits to get.
// bin/atris.js is resolved next to this file, so an installed copy benches itself.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { checkXPosts } = require('../../lib/x-post-check');

const ATRIS = path.join(__dirname, '..', '..', 'bin', 'atris.js');
const FIXTURE = path.join(__dirname, 'data', 'xsearch-answer.json');
const PAID_TIMEOUT_MS = 180000;
const STRANGER_TIMEOUT_MS = 60000;
const CHECKED_MIN = 0.6;

const CASES = [
  { name: 'topic', kind: 'paid', args: ['x-search', 'AI agent startups launch', '--limit', '5', '--days', '2'], minPosts: 3, quick: true },
  { name: 'person', kind: 'paid', args: ['x-search', 'person', '--name', 'Garry Tan', '--handle', 'garrytan'], minPosts: 1 },
  { name: 'stranger-logged-out', kind: 'stranger', args: ['x-search', 'AI agent startups launch', '--limit', '5', '--days', '2'], quick: true, free: true },
  { name: 'offline-check', kind: 'offline', quick: true, free: true },
];

function parseArgs(argv) {
  const opts = { quick: false, free: false, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--quick') opts.quick = true;
    else if (argv[i] === '--free') opts.free = true;
    else if (argv[i] === '--case') opts.only = argv[++i] || '';
    else if (argv[i].startsWith('--case=')) opts.only = argv[i].slice('--case='.length);
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  return opts;
}

function selectCases(opts, cases = CASES) {
  if (opts.only !== null) {
    const found = cases.filter((c) => c.name === opts.only);
    if (!found.length) {
      throw new Error(`unknown case: ${opts.only} (cases: ${cases.map((c) => c.name).join(', ')})`);
    }
    return found;
  }
  if (opts.free) return cases.filter((c) => c.free);
  return opts.quick ? cases.filter((c) => c.quick) : cases.slice();
}

// x-search prints "posts: N checked, N unverified, N unknown" at the end.
function parseTally(stdout) {
  const match = String(stdout || '').match(/posts: (\d+) checked, (\d+) unverified, (\d+) unknown/);
  if (!match) return null;
  return { checked: Number(match[1]), unverified: Number(match[2]), unknown: Number(match[3]) };
}

// Pure pass/fail rules. Each takes a finished run and returns { pass, note }.
// Posts = checked citations plus unverified quotes. Unknown (X could not be
// reached) counts neither way.
function postCount(tally) {
  return tally ? tally.checked + tally.unverified : 0;
}

function judgePaid({ status, tally, minPosts }) {
  const posts = postCount(tally);
  const share = posts ? tally.checked / posts : 0;
  if (status !== 0) return { pass: false, posts, note: 'search failed' };
  if (!tally) return { pass: false, posts, note: 'no posts found to check' };
  if (posts < minPosts) return { pass: false, posts, note: `only ${posts} posts, wanted ${minPosts}` };
  if (share < CHECKED_MIN) return { pass: false, posts, note: `only ${Math.round(share * 100)}% checked` };
  return { pass: true, posts, note: `${Math.round(share * 100)}% checked` };
}

function judgeStranger({ status, text, hits }) {
  const told = /not signed in|atris login/i.test(String(text || ''));
  const pass = told && typeof status === 'number' && status !== 0 && hits === 0;
  let note = 'says to log in, nothing charged';
  if (!told) note = 'did not say to log in';
  else if (hits) note = `reached the server ${hits} time(s)`;
  else if (status === 0) note = 'exited 0 without logging in';
  return { pass, note };
}

function fixtureFetch(embeds, downId = null) {
  return async (id) => {
    if (id === downId) return { id, ok: false, error: 'timeout' };
    if (!(id in embeds)) return { id, ok: false, error: 'not in fixture' };
    const post = embeds[id];
    return post ? { id, ok: true, post: { id, handle: post.handle, text: post.text, createdAt: null } } : { id, ok: true, post: null };
  };
}

// Run the checker on the saved answer twice: once with X answering every
// lookup, once with one lookup timing out. No network.
async function runOfflineCheck(fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))) {
  const up = await checkXPosts({ content: fixture.content, citations: fixture.citations, fetchPost: fixtureFetch(fixture.embeds) });
  const down = await checkXPosts({
    content: fixture.content,
    citations: fixture.citations,
    fetchPost: fixtureFetch(fixture.embeds, fixture.expect.one_down.down_id),
  });
  const want = fixture.expect;
  const upOk = Boolean(up)
    && up.tally.checked === want.all_up.checked
    && up.tally.unverified === want.all_up.unverified
    && up.tally.unknown === want.all_up.unknown
    && up.otherSources.length === want.all_up.other_sources;
  const downOk = Boolean(down)
    && down.tally.checked === want.one_down.checked
    && down.tally.unverified === want.one_down.unverified
    && down.tally.unknown === want.one_down.unknown;
  return {
    pass: upOk && downOk,
    tally: up ? up.tally : null,
    note: !upOk ? 'wrong result with X answering' : !downOk ? 'wrong result with X down' : 'checked, unverified, and unknown all land right',
  };
}

// Count every request so the stranger case can prove it never reached the server.
function startCountingServer() {
  return new Promise((resolve, reject) => {
    const state = { hits: 0 };
    const server = http.createServer((req, res) => {
      state.hits += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"detail":"bench server"}');
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      state.url = `http://127.0.0.1:${server.address().port}`;
      state.close = () => new Promise((done) => server.close(() => done()));
      resolve(state);
    });
  });
}

function runAtris(args, { env, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [ATRIS, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, seconds: Number(((Date.now() - started) / 1000).toFixed(1)) });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: `${stderr}${err.message}`, seconds: Number(((Date.now() - started) / 1000).toFixed(1)) });
    });
  });
}

// Run x-search as a stranger would: a bare HOME with no login, and the backend
// pointed at a local server that counts requests.
async function runStranger(args) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xsearch-stranger-'));
  const server = await startCountingServer();
  try {
    const run = await runAtris(args, {
      cwd: tmp,
      env: {
        HOME: tmp,
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        TMPDIR: tmp,
        ATRIS_API_URL: `${server.url}/api`,
        ATRIS_BACKEND_URL: server.url,
        ATRIS_APP_URL: server.url,
        CI: '1',
      },
      timeoutMs: STRANGER_TIMEOUT_MS,
    });
    return { ...run, hits: server.hits };
  } finally {
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function lastLines(text, n = 3) {
  return String(text || '').trim().split('\n').filter(Boolean).slice(-n).map((line) => `  ${line}`).join('\n');
}

function tallyText(t) {
  return t ? `posts=${postCount(t)} checked=${t.checked} unverified=${t.unverified} unknown=${t.unknown}` : 'posts=0';
}

// Keep what a failed paid search printed, so the miss can be read later
// without paying for another search.
function saveFailedOutput(dir, name, ts, text) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `xsearch-${name}-${ts.replace(/[:.]/g, '-')}.txt`);
    fs.writeFileSync(file, text);
    return file;
  } catch {
    return null;
  }
}

async function runCase(c, outDir) {
  const ts = new Date().toISOString();
  if (c.kind === 'offline') {
    const started = Date.now();
    const verdict = await runOfflineCheck();
    const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    const t = verdict.tally;
    return {
      pass: verdict.pass,
      line: `${c.name} ${verdict.pass ? 'pass' : 'fail'} ${seconds}s (${verdict.note}) ${tallyText(t)}`,
      row: {
        ts, case: c.name, seconds, pass: verdict.pass, exit: null,
        posts: postCount(t),
        checked: t ? t.checked : 0, unverified: t ? t.unverified : 0, unknown: t ? t.unknown : 0,
      },
    };
  }

  if (c.kind === 'stranger') {
    const run = await runStranger(c.args);
    const verdict = judgeStranger({ status: run.status, text: `${run.stdout}\n${run.stderr}`, hits: run.hits });
    return {
      pass: verdict.pass,
      line: `${c.name} ${verdict.pass ? 'pass' : 'fail'} ${run.seconds}s exit=${run.status === null ? 'none' : run.status} (${verdict.note})`,
      detail: verdict.pass ? '' : lastLines(`${run.stdout}\n${run.stderr}`),
      row: { ts, case: c.name, seconds: run.seconds, pass: verdict.pass, exit: run.status, posts: 0, checked: 0, unverified: 0, unknown: 0, hits: run.hits },
    };
  }

  const run = await runAtris(c.args, { cwd: os.tmpdir(), env: process.env, timeoutMs: PAID_TIMEOUT_MS });
  const tally = parseTally(run.stdout);
  const verdict = judgePaid({ status: run.status, tally, minPosts: c.minPosts });
  const saved = verdict.pass ? null : saveFailedOutput(outDir, c.name, ts, `${run.stdout}\n${run.stderr}`);
  return {
    pass: verdict.pass,
    line: `${c.name} ${verdict.pass ? 'pass' : 'fail'} ${run.seconds}s exit=${run.status === null ? 'none' : run.status} (${verdict.note}) ${tallyText(tally)}`,
    detail: verdict.pass ? '' : [lastLines(`${run.stdout}\n${run.stderr}`), saved ? `  full output: ${saved}` : null].filter(Boolean).join('\n'),
    row: {
      ts, case: c.name, seconds: run.seconds, pass: verdict.pass, exit: run.status,
      posts: verdict.posts,
      checked: tally ? tally.checked : 0, unverified: tally ? tally.unverified : 0, unknown: tally ? tally.unknown : 0,
      ...(saved ? { output: saved } : {}),
    },
  };
}

function summary(results, seconds) {
  const passed = results.filter((r) => r.pass).length;
  return `bench: ${passed}/${results.length} passed in ${seconds}s`;
}

function appendRow(dir, row) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'xsearch.jsonl'), `${JSON.stringify(row)}\n`);
}

async function main() {
  let cases;
  try {
    cases = selectCases(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(err.message);
    console.error('usage: xsearch-bench [--quick|--free] [--case <name>]');
    process.exit(2);
  }
  const outDir = process.env.XSEARCH_OUT_DIR || path.join(os.homedir(), '.atris', 'benchmarks');
  const started = Date.now();
  const results = [];
  for (const c of cases) {
    const result = await runCase(c, outDir);
    results.push(result);
    console.log(result.line);
    if (result.detail) console.log(result.detail);
    appendRow(outDir, result.row);
  }
  console.log(summary(results, Math.round((Date.now() - started) / 1000)));
  process.exit(results.some((r) => !r.pass) ? 1 : 0);
}

if (require.main === module) main();

module.exports = {
  CASES,
  FIXTURE,
  parseArgs,
  selectCases,
  parseTally,
  postCount,
  judgePaid,
  judgeStranger,
  fixtureFetch,
  runOfflineCheck,
  saveFailedOutput,
  summary,
};
