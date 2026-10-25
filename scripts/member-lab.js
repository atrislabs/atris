#!/usr/bin/env node
// Member lab: run agents-v1 tasks through `atris member run` (member arm) or a
// bare `claude -p` (bare arm) in fresh folders, then score each with the
// task's own check.js. Atris's own files (atris/, .atris/, agent adapters) are
// left out of scoring; work a member left on a side branch is merged first and
// reported as not reaching the folder. Results append to
// <lab>/results/<label>.jsonl.
//
// usage: node scripts/member-lab.js --arm member|bare --label <name>
//          [--lab ~/member-lab] [--cli <atris.js>] [--tasks 06,09,...]
//          [--jobs 5] [--timeout 600] [--rescore]
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');


function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const REPO = path.resolve(__dirname, '..');
const BENCH = path.join(REPO, 'atris', 'benchmarks', 'agents-v1');
const LAB = path.resolve(flag('lab', path.join(require('node:os').tmpdir(), 'atris-member-lab')));
const arm = flag('arm', 'member');
const label = flag('label', `${arm}-${Date.now()}`);
const cli = flag('cli', path.join(REPO, 'bin', 'atris.js'));
const jobs = Number(flag('jobs', 5));
const timeoutSec = Number(flag('timeout', 600));
const wanted = String(flag('tasks', '02,06,08,09,11,12,15,16,19,27')).split(',').map((s) => s.trim()).filter(Boolean);

const taskDirs = fs.readdirSync(BENCH)
  .filter((d) => /^\d\d-/.test(d) && wanted.some((w) => d.startsWith(`${w}-`) || d === w));

const runsRoot = path.join(LAB, 'runs', label);
const resultsPath = path.join(LAB, 'results', `${label}.jsonl`);
fs.mkdirSync(runsRoot, { recursive: true });
fs.mkdirSync(path.dirname(resultsPath), { recursive: true });

const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1' };

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env, timeout: 120000 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function makeCtx(workspace, fixtureDir) {
  return {
    workspace,
    fixtureDir,
    env,
    run(command, args = [], opts = {}) {
      return spawnSync(command, args, {
        cwd: opts.cwd || workspace, encoding: 'utf8', env, input: opts.input,
        timeout: Number(opts.timeoutMs || 60000), maxBuffer: 16 * 1024 * 1024,
      });
    },
  };
}

function agentCommand(prompt) {
  if (arm === 'member') return [process.execPath, [cli, 'member', 'run', prompt]];
  return ['claude', ['-p', prompt, '--dangerously-skip-permissions']];
}

function runAgent(prompt, cwd, logPath) {
  return new Promise((resolve) => {
    const [cmd, args] = agentCommand(prompt);
    const out = fs.openSync(logPath, 'w');
    const child = spawn(cmd, args, { cwd, env: { ...env, PWD: cwd }, stdio: ['ignore', out, out], detached: true });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutSec * 1000);
    child.on('exit', (code, signal) => { clearTimeout(timer); fs.closeSync(out); resolve({ code, signal }); });
  });
}

async function runTask(dir) {
  const taskDir = path.join(BENCH, dir);
  const fixtureDir = path.join(taskDir, 'fixture');
  const ws = path.join(runsRoot, dir);
  const rescore = process.argv.includes('--rescore');
  let ctx;
  let baseHead;
  let agent = { code: null, signal: null };
  const started = Date.now();
  if (rescore) {
    ctx = makeCtx(ws, fixtureDir);
    const log = spawnSync('git', ['log', '--format=%H %s', 'master'], { cwd: ws, encoding: 'utf8' }).stdout.split('\n');
    const init = log.find((l) => / atris init$/.test(l)) || log[log.length - 2] || '';
    baseHead = init.split(' ')[0];
  } else {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.cpSync(fixtureDir, ws, { recursive: true });
    ctx = makeCtx(ws, fixtureDir);
    const setupPath = path.join(taskDir, 'setup.js');
    if (fs.existsSync(setupPath)) {
      // Task setups own the first commit (and may record the base head).
      const mod = require(setupPath);
      await (typeof mod === 'function' ? mod : mod.setup)(ctx);
    } else {
      sh('git', ['init', '-q'], ws);
      sh('git', ['-c', 'user.email=lab@atris', '-c', 'user.name=lab', 'add', '-A'], ws);
      sh('git', ['-c', 'user.email=lab@atris', '-c', 'user.name=lab', 'commit', '-qm', 'fixture'], ws);
    }
    if (arm === 'member') {
      sh(process.execPath, [cli, 'init'], ws);
      sh('git', ['add', '-A'], ws);
      sh('git', ['-c', 'user.email=lab@atris', '-c', 'user.name=lab', 'commit', '-qm', 'atris init'], ws);
      const baseFile = path.join(ws, '.bench-base-head');
      if (fs.existsSync(baseFile)) fs.writeFileSync(baseFile, `${sh('git', ['rev-parse', 'HEAD'], ws).trim()}\n`);
    }
    baseHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ws, encoding: 'utf8' }).stdout.trim();
    const prompt = fs.readFileSync(path.join(taskDir, 'prompt.md'), 'utf8');
    agent = await runAgent(prompt, ws, path.join(runsRoot, `${dir}.log`));
  }
  const secs = Math.round((Date.now() - started) / 1000);
  // Score only the project's own files. Atris notes (atris/, .atris/, agent
  // adapters) are the member's desk, not the user's code.
  // Atris-owned = top-level names the atris init commit added, plus its state dirs.
  const initFiles = spawnSync('git', ['show', '--name-only', '--format=', baseHead], { cwd: ws, encoding: 'utf8' }).stdout;
  const atrisOwned = new Set(['.atris', '.agent-worktrees', 'atris', ...(arm === 'member' ? initFiles.split('\n').map((f) => f.split('/')[0]).filter(Boolean) : [])]);
  for (const name of [...fs.readdirSync(fixtureDir), '.bench-base-head']) atrisOwned.delete(name);
  const keep = { has: (entry) => !atrisOwned.has(entry) };
  const own = fs.readdirSync(fixtureDir);
  const g = (args) => spawnSync('git', args, { cwd: ws, encoding: 'utf8' });
  const dirty = g(['status', '--porcelain', '--', ...own]).stdout.trim();
  const touched = g(['diff', '--name-only', baseHead, 'HEAD', '--', ...own]).stdout.trim();
  const sideBranches = g(['branch', '--format=%(refname:short)']).stdout
    .split('\n').map((b) => b.trim()).filter((b) => b && b !== 'master' && b !== 'main');
  const landed = Boolean(dirty || touched);
  let mergedSide = null;
  if (!landed && sideBranches.length) {
    // Score the work product as if the user accepted the member's branch.
    mergedSide = sideBranches[sideBranches.length - 1];
    g(['checkout', '--', '.']);
    g(['-c', 'user.email=lab@atris', '-c', 'user.name=lab', 'merge', '--no-edit', '-q', '-X', 'theirs', mergedSide]);
  }
  const scoreDir = `${ws}.score`;
  fs.rmSync(scoreDir, { recursive: true, force: true });
  fs.mkdirSync(scoreDir);
  for (const entry of fs.readdirSync(ws)) {
    if (keep.has(entry)) fs.cpSync(path.join(ws, entry), path.join(scoreDir, entry), { recursive: true });
  }
  ctx.workspace = scoreDir;
  let passed = false;
  let failure = null;
  try {
    const spec = require(path.join(taskDir, 'check.js'));
    await spec.check(ctx);
    passed = true;
  } catch (err) {
    failure = String(err && err.message || err).split('\n').slice(0, 3).join(' | ').slice(0, 300);
  }
  const row = { label, arm, task: dir, passed, landed, merged_side: mergedSide, secs, exit: agent.code, signal: agent.signal, failure, at: new Date().toISOString() };
  fs.appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${dir} ${secs}s ${landed ? 'in-folder' : mergedSide ? 'side-branch' : 'no-change'} exit=${agent.code}${failure ? ` :: ${failure}` : ''}`);
  return row;
}

(async () => {
  const queue = [...taskDirs];
  const rows = [];
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (queue.length) {
      const dir = queue.shift();
      try { rows.push(await runTask(dir)); } catch (err) { console.log(`ERROR ${dir} ${err.message.slice(0, 200)}`); }
    }
  }));
  const pass = rows.filter((r) => r.passed).length;
  const avg = rows.length ? Math.round(rows.reduce((a, r) => a + r.secs, 0) / rows.length) : 0;
  const inFolder = rows.filter((r) => r.landed).length;
  console.log(`\n${label}: ${pass}/${rows.length} passed, ${inFolder} reached the folder, average ${avg}s`);
})();
