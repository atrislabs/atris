#!/usr/bin/env node
// Boot tokens: how much context an agent starts with in an Atris project.
// Makes a one-file repo, runs `atris init` with the given CLI (or none), asks
// the engine to reply "ok", and reads the input tokens of that one call.
// Runs as a fresh user: Claude without user settings, skills, or CLAUDE.md;
// Codex with a private CODEX_HOME holding only the login.
//
// usage: node scripts/boot-tokens.js --engine claude|codex --cli <atris.js>|none
//          [--dir /tmp/boot-tokens] [--model gpt-6.1-sol]
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const engine = flag('engine', 'claude');
const cli = flag('cli', path.join(__dirname, '..', 'bin', 'atris.js'));
const base = path.resolve(flag('dir', path.join(os.tmpdir(), 'atris-boot-tokens')));
const work = path.join(base, `${engine}-${cli === 'none' ? 'bare' : 'atris'}-${process.pid}`);
const env = { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', NO_UPDATE_NOTIFIER: '1' };
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY']) delete env[key];

fs.mkdirSync(work, { recursive: true });
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: work, encoding: 'utf8', env, timeout: 300000, ...opts });
run('git', ['init', '-q']);
fs.writeFileSync(path.join(work, 'README.md'), 'hello\n');
run('git', ['add', '-A']);
run('git', ['-c', 'user.email=lab@atris', '-c', 'user.name=lab', 'commit', '-qm', 'fixture']);
if (cli !== 'none') {
  const r = run(process.execPath, [cli, 'init']);
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }
}

const ask = 'Reply with the single word ok.';
let tokens = null;
const extra = {};
if (engine === 'codex') {
  const home = path.join(base, 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  const auth = path.join(home, 'auth.json');
  if (!fs.existsSync(auth)) fs.symlinkSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'), auth);
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "${flag('model', 'gpt-6.1-sol')}"\nmodel_reasoning_effort = "low"\n\n[features]\nmemories = false\n`);
  const r = run('codex', ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', ask], { env: { ...env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let threadId = '';
  for (const line of r.stdout.split('\n')) {
    try {
      const e = JSON.parse(line);
      if (e.type === 'thread.started') threadId = e.thread_id;
      if (e.type === 'turn.completed') tokens = e.usage.input_tokens;
    } catch {}
  }
  // Codex also lists its own plugin skills, and that list changes as its cache
  // syncs. Report it so two runs are only compared at the same skill count.
  const rollouts = [];
  (function walk(d) {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (threadId && p.includes(threadId)) rollouts.push(p);
    }
  })(path.join(home, 'sessions'));
  for (const line of rollouts[0] ? fs.readFileSync(rollouts[0], 'utf8').split('\n') : []) {
    if (!line.includes('"message"')) continue;
    try {
      const p = JSON.parse(line).payload || {};
      const text = (p.content || []).map((c) => c.text || '').join('');
      if (text.includes('<skills_instructions>')) extra.codex_skills = (text.match(/\(file: /g) || []).length;
      if (text.startsWith('# AGENTS.md instructions')) extra.agents_md_chars = text.length;
    } catch {}
  }
} else {
  const r = run('claude', ['-p', ask, '--strict-mcp-config', '--setting-sources', 'project,local', '--output-format', 'json', '--dangerously-skip-permissions'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const u = JSON.parse(r.stdout).usage;
    tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  } catch {}
}
console.log(JSON.stringify({ engine, cli, input_tokens: tokens, ...extra }));
fs.rmSync(work, { recursive: true, force: true });
if (tokens == null) process.exit(1);
