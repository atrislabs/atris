#!/usr/bin/env node
// Member lab: run agents-v1 tasks in fresh folders and score each with the
// task's own check.js. Atris's own files (atris/, .atris/, agent adapters) are
// left out of scoring; work a member left on a side branch is merged first and
// reported as not reaching the folder. Results append to
// <lab>/results/<label>.jsonl.
//
// Arms:
//   member  `atris init`, then `atris member run <task>` (the whole member stack)
//   bare    no Atris at all, the engine runs the task directly
//   boot    `atris init` with --cli, then the engine runs the task directly.
//           Same agent as bare, so the only difference is the boot files.
//
// One arm:   node scripts/member-lab.js --arm member|bare|boot --label <name>
//              [--engine claude|codex] [--cli <atris.js>]
// Compare:   node scripts/member-lab.js --label <name> --reps 2
//              --arms "full=boot:/tmp/a/bin/atris.js,lean=boot:/tmp/b/bin/atris.js,bare=bare"
//            A boot arm can take a script that edits the fresh boot files
//            before the agent starts: name=boot:<cli>@<script.js> (gets the
//            folder as its argument). Use it to test a cut before building it.
//            Every (task, arm, rep) run is queued in a seeded shuffle so arms
//            alternate in time, and folder names are random ids, so the agent
//            cannot tell which arm it is in from its path.
// Common:    [--lab /tmp/x] [--tasks 06,09,...|all] [--jobs 3] [--timeout 600]
//            [--clean-home] [--seed 1] [--rescore] [--summary] [--keep-api-keys]
//            [--codex-model gpt-6.1-sol] [--codex-effort medium]
//
// --clean-home runs the engine as a fresh user would see it: Claude without
// user settings, skills, or CLAUDE.md (--setting-sources project,local), and
// Codex with a private CODEX_HOME holding only the login and a fixed model.
// Each row records tokens, turns, and which Atris boot files the agent opened.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const REPO = path.resolve(__dirname, '..');
const BENCH = path.join(REPO, 'atris', 'benchmarks', 'agents-v1');
const LAB = path.resolve(flag('lab', path.join(os.tmpdir(), 'atris-member-lab')));
const defaultCli = flag('cli', path.join(REPO, 'bin', 'atris.js'));
const engine = flag('engine', 'claude');
const jobs = Number(flag('jobs', 3));
const timeoutSec = Number(flag('timeout', 600));
const reps = Math.max(1, Number(flag('reps', 1)));
const seed = Number(flag('seed', 1));
const cleanHome = has('clean-home');
const tasksFlag = String(flag('tasks', '02,06,08,09,11,12,15,16,19,27'));

// Arm specs: name=kind[:cli]. Single-arm mode keeps the old --arm flag.
function parseArms() {
  const raw = flag('arms', '');
  if (!raw) {
    const kind = flag('arm', 'member');
    return [{ name: kind, kind, cli: defaultCli }];
  }
  return raw.split(',').map((spec) => {
    const [name, rest = ''] = spec.split('=');
    const [armPart, hook = ''] = rest.split('@');
    const [kind, ...cliParts] = armPart.split(':');
    const cli = cliParts.join(':') || defaultCli;
    if (!['member', 'bare', 'boot'].includes(kind)) throw new Error(`unknown arm kind in ${spec}`);
    return { name: name.trim(), kind, cli: path.resolve(cli), hook: hook ? path.resolve(hook) : '' };
  });
}
const ARMS = parseArms();
const label = flag('label', `${ARMS.map((a) => a.name).join('-')}-${Date.now()}`);

const allTasks = fs.readdirSync(BENCH).filter((d) => /^\d\d-/.test(d)).sort();
const wanted = tasksFlag === 'all' ? allTasks : tasksFlag.split(',').map((s) => s.trim()).filter(Boolean);
const taskDirs = allTasks.filter((d) => wanted.some((w) => d.startsWith(`${w}-`) || d === w));

const runsRoot = path.join(LAB, 'runs', label);
const resultsPath = path.join(LAB, 'results', `${label}.jsonl`);
fs.mkdirSync(runsRoot, { recursive: true });
fs.mkdirSync(path.dirname(resultsPath), { recursive: true });

const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1' };
// Engines run on their own logins by default so a stray API key never bills a
// lab run. --keep-api-keys passes them through for API-key-only setups.
if (!has('keep-api-keys')) for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY']) delete env[key];

// Codex reads skills, memories, and AGENTS.md from CODEX_HOME. A private home
// with only the login keeps the user's own setup out of every arm. Skills in
// ~/.agents/skills still load (HOME stays real so git identity works); they
// are the same in every arm.
function codexHome() {
  if (!cleanHome || engine !== 'codex') return null;
  const home = path.join(LAB, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  const realHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const auth = path.join(home, 'auth.json');
  if (!fs.existsSync(auth)) fs.symlinkSync(path.join(realHome, 'auth.json'), auth);
  const model = flag('codex-model', 'gpt-6.1-sol');
  const effort = flag('codex-effort', 'medium');
  fs.writeFileSync(path.join(home, 'config.toml'), [
    `model = "${model}"`, `model_reasoning_effort = "${effort}"`,
    'approval_policy = "never"', 'sandbox_mode = "danger-full-access"', '',
    '[features]', 'memories = false', '',
  ].join('\n'));
  return home;
}
const CODEX_HOME = codexHome();

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
        cwd: opts.cwd || workspace, encoding: 'utf8', env: { ...env, ...(opts.env || {}) }, input: opts.input,
        timeout: Number(opts.timeoutMs || 60000), maxBuffer: 16 * 1024 * 1024,
      });
    },
  };
}

function agentCommand(arm, prompt) {
  if (arm.kind === 'member') return [process.execPath, [arm.cli, 'member', 'run', prompt]];
  if (engine === 'codex') {
    return ['codex', ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', prompt]];
  }
  const args = ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];
  if (cleanHome) args.push('--setting-sources', 'project,local', '--strict-mcp-config');
  return ['claude', args];
}

function runAgent(arm, prompt, cwd, logPath) {
  return new Promise((resolve) => {
    const [cmd, args] = agentCommand(arm, prompt);
    const out = fs.openSync(logPath, 'w');
    const childEnv = { ...env, PWD: cwd };
    if (CODEX_HOME && arm.kind !== 'member') childEnv.CODEX_HOME = CODEX_HOME;
    const child = spawn(cmd, args, { cwd, env: childEnv, stdio: ['ignore', out, out], detached: true });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutSec * 1000);
    child.on('exit', (code, signal) => { clearTimeout(timer); fs.closeSync(out); resolve({ code, signal }); });
  });
}

// Atris boot files an agent can open or act on. Matched against every command
// and file path the agent used.
const BOOT_PIECES = [
  ['AGENTS.md', /(^|[\s'"/])AGENTS\.md\b/],
  ['CLAUDE.md', /(^|[\s'"/])CLAUDE\.md\b/],
  ['atris/atris.md', /atris\/atris\.md/],
  ['atris atris.md', /\batris atris\.md\b/],
  ['atris/MAP.md', /atris\/MAP\.md/],
  ['atris/PERSONA.md', /atris\/PERSONA\.md/],
  ['atris/FOR_AGENTS.md', /FOR_AGENTS\.md/],
  ['atris/TODO.md', /atris\/TODO\.md/],
  ['atris/team', /atris\/team\//],
  ['atris/skills', /(atris|\.claude)\/skills\//],
  ['atris/wiki', /atris\/wiki\b/],
  ['atris command', /(^|[;&|\s(])atris\s+[a-z]/],
  ['skill tool', /^Skill /],
];

// Engine-side failures that say nothing about the agent: the model was busy,
// rate limited, or the service errored. Agent failures (max turns, bad work)
// never match, so they stay in the score.
const INFRA_ERROR = /at capacity|rate.?limit|usage limit|overloaded|temporarily unavailable|service unavailable|internal server error|\b(429|500|502|503|529)\b|ECONNRESET|ETIMEDOUT|stream disconnected/i;

// Read tokens, turns, and tool calls back out of the engine's log.
function readAgentLog(arm, logPath, logEngine = engine) {
  const stats = { tokens_in: null, tokens_out: null, first_call_in: null, turns: null, tool_calls: 0, opened: [], infra_error: null };
  if (arm.kind === 'member') return stats;
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf8'); } catch { return stats; }
  const calls = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    // The engine itself failed and did not recover. The summary leaves such
    // runs out unless they passed anyway.
    const errText = e.type === 'error' || e.type === 'turn.failed' ? String(e.message || e.error?.message || '')
      : e.type === 'result' && e.is_error ? String(e.result || e.subtype || '') : '';
    if (errText && INFRA_ERROR.test(errText)) stats.infra_error = errText.slice(0, 200);
    if (e.type === 'turn.completed') stats.infra_error = null;
    if (logEngine === 'claude') {
      if (e.type === 'assistant' && e.message) {
        const u = e.message.usage;
        if (u && stats.first_call_in == null) stats.first_call_in = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        for (const c of e.message.content || []) {
          if (c.type !== 'tool_use') continue;
          const inp = c.input || {};
          calls.push(`${c.name} ${inp.command || ''} ${inp.file_path || ''} ${inp.path || ''} ${inp.pattern || ''} ${inp.skill || ''}`);
        }
      } else if (e.type === 'result' && e.usage) {
        const u = e.usage;
        stats.tokens_in = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        stats.tokens_out = u.output_tokens || 0;
        stats.turns = e.num_turns ?? null;
      }
    } else {
      if (e.type === 'item.completed' && e.item && e.item.type === 'command_execution') calls.push(String(e.item.command || ''));
      if (e.type === 'item.completed' && e.item && e.item.type === 'file_change') calls.push(`edit ${(e.item.changes || []).map((c) => c.path).join(' ')}`);
      if (e.type === 'turn.completed' && e.usage) {
        stats.tokens_in = (stats.tokens_in || 0) + (e.usage.input_tokens || 0);
        stats.tokens_out = (stats.tokens_out || 0) + (e.usage.output_tokens || 0);
      }
    }
  }
  if (logEngine === 'codex') stats.turns = calls.length;
  stats.tool_calls = calls.length;
  const joined = calls.join('\n');
  stats.opened = BOOT_PIECES.filter(([, re]) => calls.some((c) => re.test(c)) || re.test(joined)).map(([name]) => name);
  return stats;
}

// Neutral folder names so the agent cannot read its arm from the path.
const runIds = new Map();
function runId(arm, rep) {
  const key = `${arm.name}#${rep}`;
  if (!runIds.has(key)) runIds.set(key, `w${crypto.createHash('sha1').update(`${label}:${key}`).digest('hex').slice(0, 6)}`);
  return runIds.get(key);
}

async function runTask({ dir, arm, rep }) {
  const taskDir = path.join(BENCH, dir);
  const fixtureDir = path.join(taskDir, 'fixture');
  const single = ARMS.length === 1 && reps === 1 && !flag('arms', '');
  const wsRoot = single ? runsRoot : path.join(runsRoot, runId(arm, rep));
  const ws = path.join(wsRoot, dir);
  const logPath = path.join(wsRoot, `${dir}.log`);
  const rescore = has('rescore');
  const initsAtris = arm.kind === 'member' || arm.kind === 'boot';
  let ctx;
  let baseHead;
  let agent = { code: null, signal: null };
  const started = Date.now();
  fs.mkdirSync(wsRoot, { recursive: true });
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
    if (initsAtris) {
      sh(process.execPath, [arm.cli, 'init'], ws);
      // Optional per-arm edit of the fresh boot files, to test a cut before
      // building it into init: name=boot:<cli>@<script.js> runs the script here.
      if (arm.hook) sh(process.execPath, [arm.hook, ws], ws);
      sh('git', ['add', '-A'], ws);
      spawnSync('git', ['reset', '-q', '--', '.bench-base-head'], { cwd: ws });
      sh('git', ['-c', 'user.email=lab@atris', '-c', 'user.name=lab', 'commit', '-qm', 'atris init'], ws);
      const baseFile = path.join(ws, '.bench-base-head');
      if (fs.existsSync(baseFile)) fs.writeFileSync(baseFile, `${sh('git', ['rev-parse', 'HEAD'], ws).trim()}\n`);
    }
    baseHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ws, encoding: 'utf8' }).stdout.trim();
    const prompt = fs.readFileSync(path.join(taskDir, 'prompt.md'), 'utf8');
    agent = await runAgent(arm, prompt, ws, logPath);
  }
  const secs = Math.round((Date.now() - started) / 1000);
  // Score only the project's own files. Atris notes (atris/, .atris/, agent
  // adapters) are the member's desk, not the user's code.
  // Atris-owned = top-level names the atris init commit added, plus its state dirs.
  const initFiles = spawnSync('git', ['show', '--name-only', '--format=', baseHead], { cwd: ws, encoding: 'utf8' }).stdout;
  const atrisOwned = new Set(['.atris', '.agent-worktrees', 'atris', ...(initsAtris ? initFiles.split('\n').map((f) => f.split('/')[0]).filter(Boolean) : [])]);
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
  const stats = readAgentLog(arm, logPath);
  const row = {
    label, arm: arm.name, kind: arm.kind, engine: arm.kind === 'member' ? 'member' : engine, rep, task: dir,
    passed, landed, merged_side: mergedSide, secs, exit: agent.code, signal: agent.signal, failure,
    ...stats, folder: path.relative(runsRoot, ws), at: new Date().toISOString(),
  };
  fs.appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${arm.name} r${rep} ${dir} ${secs}s ${landed ? 'in-folder' : mergedSide ? 'side-branch' : 'no-change'} exit=${agent.code}${stats.tokens_in != null ? ` in=${stats.tokens_in}` : ''}${failure ? ` :: ${failure}` : ''}`);
  return row;
}

// Seeded shuffle so a run order can be replayed.
function shuffle(list, s) {
  const out = [...list];
  let x = s >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    x = (x * 1664525 + 1013904223) >>> 0;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function summarize(rows) {
  const byArm = {};
  for (const r of rows) (byArm[r.arm] ||= []).push(r);
  const lines = [];
  for (const [name, list] of Object.entries(byArm)) {
    const infra = list.filter((r) => r.infra_error && !r.passed).length;
    const scored = list.length - infra;
    const pass = list.filter((r) => r.passed).length;
    const counted = list.filter((r) => !(r.infra_error && !r.passed));
    const avg = (key) => {
      const vals = counted.map((r) => r[key]).filter((v) => typeof v === 'number');
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    };
    const opened = {};
    for (const r of counted) for (const p of r.opened || []) opened[p] = (opened[p] || 0) + 1;
    const openedText = Object.entries(opened).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join(', ') || 'none';
    lines.push(`${name}: ${pass}/${scored} passed (${Math.round(100 * pass / Math.max(1, scored))}%)${infra ? `, ${infra} engine failures left out` : ''}, avg ${avg('secs')}s, avg tokens in ${avg('tokens_in')}, first call ${avg('first_call_in')}, tool calls ${avg('tool_calls')}; opened: ${openedText}`);
  }
  return lines.join('\n');
}

(async () => {
  if (has('summary')) {
    const rows = fs.readFileSync(resultsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    // Older rows predate some log fields; read them back from the saved logs.
    for (const r of rows) {
      if (r.kind === 'member') continue;
      const logPath = path.join(runsRoot, `${r.folder}.log`);
      if (!fs.existsSync(logPath)) continue;
      const fresh = readAgentLog({ kind: r.kind }, logPath, r.engine);
      if (!('infra_error' in r)) Object.assign(r, fresh);
      else r.infra_error = fresh.infra_error;
    }
    console.log(summarize(rows));
    return;
  }
  // Each rep visits every task once per arm; inside a rep the order is shuffled
  // so no arm always runs first or last.
  const queue = [];
  for (let rep = 1; rep <= reps; rep++) {
    const round = [];
    for (const dir of taskDirs) for (const arm of ARMS) round.push({ dir, arm, rep });
    queue.push(...(ARMS.length > 1 || reps > 1 ? shuffle(round, seed * 1000 + rep) : round));
  }
  const rows = [];
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { rows.push(await runTask(item)); } catch (err) { console.log(`ERROR ${item.arm.name} r${item.rep} ${item.dir} ${err.message.slice(0, 200)}`); }
    }
  }));
  console.log(`\n${label}:\n${summarize(rows)}`);
})();
